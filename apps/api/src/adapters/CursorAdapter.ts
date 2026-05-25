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
import {
  buildMarkerToolPrompt,
  extractMarkerToolCalls,
  isProcessNoiseLine,
  stripProcessNoise,
} from './markerToolProtocol.js';

/** Safety cap for one interactive chat turn when no explicit timeout is configured. */
const DEFAULT_CHAT_TURN_TIMEOUT_MS = 180_000;

export interface CursorAdapterOptions {
  agentId: string;
  binaryPath?: string;
  cwd?: string;
  model?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  logger: Logger;
}

export class CursorAdapter implements AgentAdapter {
  readonly adapterType = 'cursor' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  #sessionId: string | undefined;

  constructor(private readonly opts: CursorAdapterOptions) {}

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
    const binary = this.opts.binaryPath || 'agent';
    const args = [
      '--output-format',
      'stream-json',
      ...(this.opts.model ? [`--model=${this.opts.model}`] : []),
      ...(this.#sessionId ? ['--resume', this.#sessionId] : []),
      ...(this.opts.extraArgs ?? []),
    ];
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
      this.#emitFailure(task, `cursor_spawn_failed: ${(err as Error).message}`);
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
      this.#emitFailure(task, `cursor_error: ${err.message}`);
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    childProcess.stderr?.on('data', (data) =>
      this.opts.logger.warn('cursor.stderr', { data: String(data).slice(0, 512) }),
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
          const event = JSON.parse(line) as CursorJsonEvent;
          const sessionId = firstString(event.session_id, event.sessionId, objectOf(event.session)?.id);
          if (sessionId) this.#sessionId = sessionId;
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
          if (isCompletionEvent(event)) lastOutput = extractOutput(event, transcript);
        } catch {
          transcript += line + '\n';
          this.#emit({
            eventType: 'task.progress',
            agentId: this.opts.agentId,
            runId: task.runId,
            workflowId: task.workflowId,
            taskId: task.taskId,
            message: line,
            timestamp: timestamp(),
          });
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
        this.#emitFailure(task, `cursor exited ${code}`);
      }
    });

    childProcess.stdin?.end(buildPrompt(task));
  }

  async cancelTask(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort();
    this.#inFlight.delete(taskId);
  }

  async *chat(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<ChatDelta> {
    const controller = new AbortController();
    const binary = this.opts.binaryPath ?? 'agent';
    const args = [
      '--output-format',
      'stream-json',
      ...(this.opts.model ? [`--model=${this.opts.model}`] : []),
      ...(this.#sessionId ? ['--resume', this.#sessionId] : []),
      ...(this.opts.extraArgs ?? []),
    ];
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
      const message = `Cursor adapter failed to start: ${(err as Error).message}`;
      this.opts.logger.warn('cursor.chat.spawn_failed', { err: message });
      yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: message };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    const chatTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    timeout = setTimeout(() => controller.abort(), chatTimeoutMs);
    timeout.unref?.();

    let stderrText = '';
    childProcess.stderr?.on('data', (data) => {
      const chunk = String(data);
      stderrText = `${stderrText}${chunk}`.slice(-1024);
      this.opts.logger.warn('cursor.chat.stderr', { data: chunk.slice(0, 512) });
    });

    childProcess.on('error', (err) => {
      queue.push({
        type: 'tool_result',
        id: 'adapter',
        name: 'adapter.chat',
        result: null,
        error: `Cursor error: ${err.message}`,
      });
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
          const event = JSON.parse(line) as CursorJsonEvent;
          const sessionId = firstString(event.session_id, event.sessionId, objectOf(event.session)?.id);
          if (sessionId) this.#sessionId = sessionId;

          if (isReasoningEvent(event)) {
            const reasoning = extractText(event);
            if (reasoning) queue.push({ type: 'thinking', delta: reasoning });
          } else {
            const text = extractText(event);
            if (text) transcript += text;
            const toolCall = extractToolCall(event);
            if (toolCall) {
              pendingToolCalls.push({
                type: 'tool_call',
                id: randomUUID(),
                name: toolCall.tool,
                args: toolCall.input,
              });
            }
          }
        } catch {
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
          error: details ? `Cursor exited ${code}: ${details}` : `Cursor exited ${code}`,
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
        ...markerCalls.map((call) => ({
          type: 'tool_call' as const,
          id: randomUUID(),
          name: call.name,
          args: call.args,
        })),
      ];
      for (const call of allToolCalls) queue.push(call);
      queue.push({ type: 'done', finishReason: allToolCalls.length > 0 ? 'tool_calls' : 'stop' });
      queue.close();
    });

    childProcess.stdin?.end(buildCursorChatPrompt(messages, tools));

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
        this.opts.logger.error('cursor.handler_threw', { err: (err as Error).message });
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

type CursorJsonEvent = {
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
  session?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
};

function buildPrompt(task: NormalizedTask): string {
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

function extractText(event: CursorJsonEvent): string {
  const direct = firstString(event.text, event.content, event.delta);
  if (direct) return direct;
  const message = objectOf(event.message);
  const messageText = firstString(message?.text, message?.content);
  if (messageText) return messageText;
  const item = objectOf(event.item);
  return firstString(item?.text, item?.content) ?? '';
}

function extractToolCall(event: CursorJsonEvent): { tool: string; input: unknown } | null {
  const type = String(event.type ?? '').toLowerCase();
  if (!type.includes('tool') && !type.includes('function')) return null;
  const item = objectOf(event.item);
  const tool = firstString(event.name, event.tool, item?.name, item?.tool) ?? 'tool';
  return { tool, input: event.input ?? event.arguments ?? item?.input ?? item?.arguments ?? {} };
}

function isCompletionEvent(event: CursorJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  return type === 'result' || type === 'done' || type.includes('completed') || type.includes('finished');
}

function extractOutput(event: CursorJsonEvent, transcript: string): Record<string, unknown> {
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

function buildCursorChatPrompt(messages: ChatMessage[], tools: ToolDefinition[]): string {
  return [
    buildMarkerToolPrompt(tools),
    '',
    'Conversation:',
    formatMessagesForCursor(messages),
  ].join('\n');
}

function formatMessagesForCursor(messages: ChatMessage[]): string {
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

function isReasoningEvent(event: CursorJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  if (type.includes('reason') || type.includes('think')) return true;
  const item = objectOf(event.item);
  const itemType = String(item?.type ?? '').toLowerCase();
  return itemType.includes('reason') || itemType.includes('think');
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
