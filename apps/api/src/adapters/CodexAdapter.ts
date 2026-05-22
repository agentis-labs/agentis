/**
 * CodexAdapter — spawn the OpenAI Codex CLI as a child process.
 *
 * The adapter is intentionally protocol-specific rather than a generic HTTP
 * wrapper: operators see Codex as a first-class runtime, while the engine still
 * receives the same NormalizedAgentEvent stream as every other adapter.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterHealthStatus,
  ChatDelta,
  ChatMessage,
  NormalizedAgentEvent,
  NormalizedTask,
  ToolDefinition,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { buildMarkerToolPrompt, extractMarkerToolCalls, formatToolManifestAwareness, isProcessNoiseLine, stripProcessNoise } from './markerToolProtocol.js';

/** Safety cap for one interactive chat turn when no explicit timeout is configured. */
const DEFAULT_CHAT_TURN_TIMEOUT_MS = 180_000;

export interface CodexAdapterOptions {
  agentId: string;
  /** Path to the `codex` binary. Falls back to `codex` on PATH. */
  binaryPath?: string;
  /** Working directory the CLI is spawned in. */
  cwd?: string;
  model?: string;
  maxTurns?: number;
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  fastMode?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  logger: Logger;
}

export class CodexAdapter implements AgentAdapter {
  readonly adapterType = 'codex' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();

  constructor(private readonly opts: CodexAdapterOptions) {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }

  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'marker_protocol',
    };
  }

  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.set(task.taskId, controller);
    const binary = this.opts.binaryPath ?? 'codex';
    const args = buildCodexArgs(this.opts);
    let childProcess: ReturnType<typeof spawn>;
    let terminalEventEmitted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}) });
      const target = resolveSpawnTarget(binary, args, this.opts.cwd ?? process.cwd(), env);
      childProcess = spawn(target.command, target.args, {
        cwd: this.opts.cwd,
        env,
        windowsHide: true,
        signal: controller.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.#emitFailure(task, `codex_spawn_failed: ${(err as Error).message}`);
      this.#inFlight.delete(task.taskId);
      return;
    }

    if (this.opts.timeoutSec && this.opts.timeoutSec > 0) {
      timeout = setTimeout(() => controller.abort(), this.opts.timeoutSec * 1000);
      timeout.unref?.();
    }

    const timestamp = () => new Date().toISOString();
    this.#emit({
      eventType: 'task.started',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      timestamp: timestamp(),
    });

    childProcess.on('error', (err) => {
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      this.#emitFailure(task, `codex_error: ${err.message}`);
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    childProcess.stderr?.on('data', (data) =>
      this.opts.logger.warn('codex.stderr', { data: String(data).slice(0, 512) }),
    );

    let buffer = '';
    let transcript = '';
    let lastOutput: Record<string, unknown> | undefined;
    childProcess.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as CodexJsonEvent;
          const text = extractText(event);
          if (text) {
            transcript += text;
            this.#emit({
              eventType: 'task.progress',
              agentId: this.opts.agentId,
              runId: task.runId,
              workflowId: task.workflowId,
              taskId: task.taskId,
              message: text,
              timestamp: timestamp(),
            });
          }
          const toolCall = extractToolCall(event);
          if (toolCall) {
            this.#emit({
              eventType: 'agent.tool_call',
              agentId: this.opts.agentId,
              runId: task.runId,
              workflowId: task.workflowId,
              taskId: task.taskId,
              tool: toolCall.tool,
              input: toolCall.input,
              timestamp: timestamp(),
            });
          }
          if (isCompletionEvent(event)) {
            lastOutput = extractOutput(event, transcript);
          }
        } catch {
          this.opts.logger.warn('codex.malformed_jsonl', { line: line.slice(0, 256) });
        }
      }
    });

    childProcess.on('exit', (code) => {
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      if (code === 0) {
        this.#emit({
          eventType: 'task.completed',
          agentId: this.opts.agentId,
          runId: task.runId,
          workflowId: task.workflowId,
          taskId: task.taskId,
          output: lastOutput ?? { text: transcript.trim() },
          timestamp: timestamp(),
        });
      } else {
        this.#emitFailure(task, `codex exited ${code}`);
      }
    });

    childProcess.stdin?.end(buildCodexPrompt(task));
  }

  async cancelTask(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort();
    this.#inFlight.delete(taskId);
  }

  async *chat(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<ChatDelta> {
    const controller = new AbortController();
    const binary = this.opts.binaryPath ?? 'codex';
    const args = buildCodexArgs(this.opts);
    const queue = createChatQueue();
    let childProcess: ReturnType<typeof spawn>;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}) });
      const target = resolveSpawnTarget(binary, args, this.opts.cwd ?? process.cwd(), env);
      childProcess = spawn(target.command, target.args, {
        cwd: this.opts.cwd,
        env,
        windowsHide: true,
        signal: controller.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = `Codex adapter failed to start: ${(err as Error).message}`;
      this.opts.logger.warn('codex.chat.spawn_failed', { err: message });
      yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: message };
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    // A single interactive chat turn must be bounded even when the agent config
    // sets no timeout — otherwise a CLI that goes off exploring its sandbox can
    // hang the conversation indefinitely (no spinner end, no dismiss).
    const chatTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    timeout = setTimeout(() => controller.abort(), chatTimeoutMs);
    timeout.unref?.();
    let stderrText = '';
    childProcess.stderr?.on('data', (data) => {
      const chunk = String(data);
      stderrText = `${stderrText}${chunk}`.slice(-1024);
      this.opts.logger.warn('codex.chat.stderr', { data: chunk.slice(0, 512) });
    });
    childProcess.on('error', (err) => {
      queue.push({ type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: `Codex error: ${err.message}` });
      queue.push({ type: 'done', finishReason: 'error' });
      queue.close();
      if (timeout) clearTimeout(timeout);
    });
    let buffer = '';
    let transcript = '';
    let rawFallback = '';
    const pendingToolCalls: ChatDelta[] = [];
    childProcess.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as CodexJsonEvent;
          if (isReasoningEvent(event)) {
            // Reasoning streams live into the ThinkingBubble rather than being
            // mixed into the final answer text (CHAT-10X-VISION §3.3).
            const reasoning = extractText(event);
            if (reasoning) queue.push({ type: 'thinking', delta: reasoning });
          } else {
            const text = extractText(event);
            if (text) transcript += text;
            const toolCall = extractToolCall(event);
            if (toolCall) pendingToolCalls.push({ type: 'tool_call', id: randomUUID(), name: toolCall.tool, args: toolCall.input });
          }
        } catch {
          // Codex runs in --json mode, so every meaningful token arrives as a
          // JSON event. Non-JSON lines are environment noise (e.g. Windows
          // taskkill output: "ÊXITO: o processo com PID … foi finalizado").
          // Never surface them as assistant text — retain a filtered copy only
          // as a fallback for the rare case where the model emits no JSON.
          if (!isProcessNoiseLine(line)) rawFallback += `${line}\n`;
        }
      }
    });
    childProcess.on('exit', (code) => {
      if (timeout) clearTimeout(timeout);
      if (code !== 0) {
        const details = stderrText.trim();
        queue.push({
          type: 'tool_result',
          id: 'adapter',
          name: 'adapter.chat',
          result: null,
          error: details ? `Codex exited ${code}: ${details}` : `Codex exited ${code}`,
        });
        queue.push({ type: 'done', finishReason: 'error' });
        queue.close();
        return;
      }

      const source = transcript.trim().length > 0 ? transcript : stripProcessNoise(rawFallback);
      const { calls: markerCalls, cleaned } = extractMarkerToolCalls(source);
      if (cleaned) queue.push({ type: 'text', delta: cleaned });
      const allToolCalls: ChatDelta[] = [
        ...pendingToolCalls,
        ...markerCalls.map((call) => ({ type: 'tool_call' as const, id: randomUUID(), name: call.name, args: call.args })),
      ];
      for (const call of allToolCalls) queue.push(call);
      queue.push({ type: 'done', finishReason: allToolCalls.length > 0 ? 'tool_calls' : 'stop' });
      queue.close();
    });
    childProcess.stdin?.end(buildCodexChatPrompt(messages, tools));
    try {
      yield* queue.iterate();
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
    }
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.opts.logger.error('codex.handler_threw', { err: (err as Error).message });
      }
    }
  }

  #emitFailure(task: NormalizedTask, message: string): void {
    this.#emit({
      eventType: 'task.failed',
      agentId: this.opts.agentId,
      runId: task.runId,
      workflowId: task.workflowId,
      taskId: task.taskId,
      error: message,
      timestamp: new Date().toISOString(),
    });
  }
}

function buildCodexArgs(opts: CodexAdapterOptions): string[] {
  const reasoningEffort = opts.modelReasoningEffort ?? (opts.fastMode ? 'minimal' : undefined);
  return [
    'exec',
    '--json',
    ...(opts.model ? [`--model=${opts.model}`] : []),
    ...(reasoningEffort ? ['-c', `model_reasoning_effort="${reasoningEffort}"`] : []),
    ...(opts.dangerouslyBypassApprovalsAndSandbox !== false ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
    ...(opts.extraArgs ?? []),
  ];
}

type CodexJsonEvent = {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  message?: unknown;
  delta?: unknown;
  item?: unknown;
  result?: unknown;
  output?: unknown;
  name?: unknown;
  tool?: unknown;
  input?: unknown;
  arguments?: unknown;
};

function buildCodexPrompt(task: NormalizedTask): string {
  return [
    `Task: ${task.title}`,
    '',
    task.description,
    formatToolManifestAwareness(task.toolManifest),
    '',
    'Input data:',
    safeJson(task.inputData),
    '',
    'Scratchpad snapshot:',
    safeJson(task.scratchpadSnapshot),
  ].join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function extractText(event: CodexJsonEvent): string {
  const direct = firstString(event.text, event.content, event.delta);
  if (direct) return direct;
  const message = objectOf(event.message);
  const messageText = firstString(message?.text, message?.content);
  if (messageText) return messageText;
  const item = objectOf(event.item);
  return firstString(item?.text, item?.content) ?? '';
}

function extractToolCall(event: CodexJsonEvent): { tool: string; input: unknown } | null {
  const type = String(event.type ?? '').toLowerCase();
  if (!type.includes('tool') && !type.includes('function')) return null;
  const item = objectOf(event.item);
  const tool = firstString(event.name, event.tool, item?.name, item?.tool) ?? 'tool';
  return { tool, input: event.input ?? event.arguments ?? item?.input ?? item?.arguments ?? {} };
}

function isCompletionEvent(event: CodexJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  return type === 'result' || type === 'done' || type.includes('completed') || type.includes('finished');
}

/**
 * Whether a Codex JSONL event carries chain-of-thought rather than the final
 * answer. Routed to `thinking` deltas so the UI renders it in the collapsible
 * ThinkingBubble instead of the answer body. Deliberately conservative so the
 * plain `{"type":"assistant"}` message contract is unaffected.
 */
function isReasoningEvent(event: CodexJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  if (type.includes('reason') || type.includes('think')) return true;
  const item = objectOf(event.item);
  const itemType = String(item?.type ?? '').toLowerCase();
  return itemType.includes('reason') || itemType.includes('think');
}

function extractOutput(event: CodexJsonEvent, transcript: string): Record<string, unknown> {
  const result = objectOf(event.result) ?? objectOf(event.output);
  if (result) return result;
  const text = firstString(event.text, event.content) ?? transcript.trim();
  return { text };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value)) {
      const joined = value.map((item) => {
        if (typeof item === 'string') return item;
        const object = objectOf(item);
        return firstString(object?.text, object?.content) ?? '';
      }).join('');
      if (joined) return joined;
    }
  }
  return undefined;
}

function buildCodexChatPrompt(messages: ChatMessage[], tools: ToolDefinition[]): string {
  return [
    buildMarkerToolPrompt(tools),
    '',
    'Conversation:',
    formatMessagesForCodex(messages),
  ].join('\n');
}

function formatMessagesForCodex(messages: ChatMessage[]): string {
  return messages.map((message) => {
    const content = typeof message.content === 'string' ? message.content : safeJson(message.content);
    if (message.role === 'tool') {
      return `TOOL RESULT (${message.toolCallId ?? 'unknown'}):\n${content}`;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return [
        'ASSISTANT:',
        content,
        'REQUESTED TOOLS:',
        safeJson(message.toolCalls),
      ].join('\n');
    }
    return `${message.role.toUpperCase()}:\n${content}`;
  }).join('\n\n---\n\n');
}

function createChatQueue() {
  const pending: ChatDelta[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  return {
    push(delta: ChatDelta) {
      if (closed) return;
      pending.push(delta);
      waiters.shift()?.();
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()?.();
    },
    async *iterate(): AsyncIterable<ChatDelta> {
      while (!closed || pending.length > 0) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}
