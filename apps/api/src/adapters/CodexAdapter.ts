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
  AdapterHealthStatus,
  ChatDelta,
  ChatMessage,
  NormalizedAgentEvent,
  NormalizedTask,
  ToolDefinition,
} from '@agentis/core';
import { CONSTANTS } from '@agentis/core';
import type { Logger } from '../logger.js';

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
      childProcess = spawn(binary, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...(this.opts.env ?? {}) },
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
      childProcess = spawn(binary, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...(this.opts.env ?? {}) },
        signal: controller.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      yield { type: 'text', delta: `Codex adapter failed to start: ${(err as Error).message}` };
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    if (this.opts.timeoutSec && this.opts.timeoutSec > 0) {
      timeout = setTimeout(() => controller.abort(), this.opts.timeoutSec * 1000);
      timeout.unref?.();
    }
    childProcess.stderr?.on('data', (data) => this.opts.logger.warn('codex.chat.stderr', { data: String(data).slice(0, 512) }));
    childProcess.on('error', (err) => {
      queue.push({ type: 'text', delta: `Codex error: ${err.message}` });
      queue.push({ type: 'done', finishReason: 'error' });
      queue.close();
      if (timeout) clearTimeout(timeout);
    });
    let buffer = '';
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
          if (text) queue.push({ type: 'text', delta: text });
          const toolCall = extractToolCall(event);
          if (toolCall) queue.push({ type: 'tool_call', id: randomUUID(), name: toolCall.tool, args: toolCall.input });
          if (isCompletionEvent(event)) queue.push({ type: 'done', finishReason: 'stop' });
        } catch {
          queue.push({ type: 'text', delta: line });
        }
      }
    });
    childProcess.on('exit', (code) => {
      if (timeout) clearTimeout(timeout);
      queue.push({ type: 'done', finishReason: code === 0 ? 'stop' : 'error' });
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
  return [
    '--json',
    `--max-turns=${opts.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT ?? 24}`,
    ...(opts.model ? [`--model=${opts.model}`] : []),
    ...(opts.modelReasoningEffort ? [`--model-reasoning-effort=${opts.modelReasoningEffort}`] : []),
    ...(opts.fastMode ? ['--fast'] : []),
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
    'Agentis interactive chat session. Use tool calls when the Codex CLI supports them; otherwise explain the next action clearly.',
    '',
    'Available tools:',
    safeJson(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))),
    '',
    'Conversation:',
    safeJson(messages),
  ].join('\n');
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