/**
 * ClaudeCodeAdapter — spawn the Claude Code CLI as a child process.
 *
 * The CLI is invoked once per task with the task's prompt as stdin. We read
 * stdout line-by-line and parse JSONL events conforming to Claude Code's
 * machine-output mode. `maxTurns` caps runaway sessions.
 *
 * If the binary is missing the adapter immediately surfaces
 * task.failed via ADAPTER_UNAVAILABLE — operators get a clean message in
 * the dashboard rather than a hang.
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
import { CONSTANTS } from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { buildMarkerToolPrompt, extractMarkerToolCalls, formatToolManifestAwareness, isProcessNoiseLine, stripProcessNoise } from './markerToolProtocol.js';

/** Safety cap for one interactive chat turn when no explicit timeout is configured. */
const DEFAULT_CHAT_TURN_TIMEOUT_MS = 180_000;

export interface ClaudeCodeAdapterOptions {
  agentId: string;
  /** Path to the `claude` binary. Falls back to `claude` on PATH. */
  binaryPath?: string;
  /** Working directory the CLI is spawned in. */
  cwd?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  logger: Logger;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly adapterType = 'claude_code' as const;
  readonly #handlers = new Set<(e: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  #sessionId: string | undefined;

  constructor(private readonly opts: ClaudeCodeAdapterOptions) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    for (const a of this.#inFlight.values()) a.abort();
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

  onEvent(handler: (e: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const ctrl = new AbortController();
    this.#inFlight.set(task.taskId, ctrl);
    const bin = this.opts.binaryPath ?? 'claude';
    const args = [
      '--print',
      '--output-format=stream-json',
      `--max-turns=${this.opts.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT ?? 24}`,
      '--dangerously-skip-permissions',
      ...(this.opts.model ? [`--model=${this.opts.model}`] : []),
      ...(this.opts.allowedTools?.length ? [`--allowedTools=${this.opts.allowedTools.join(',')}`] : []),
      ...(this.#sessionId ? ['--resume', this.#sessionId] : []),
      ...(this.opts.extraArgs ?? []),
    ];
    let child: ReturnType<typeof spawn>;
    let terminalEventEmitted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}) });
      const target = resolveSpawnTarget(bin, args, this.opts.cwd ?? process.cwd(), env);
      child = spawn(target.command, target.args, {
        cwd: this.opts.cwd,
        env,
        windowsHide: true,
        signal: ctrl.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.#emitFailure(task, `claude_code_spawn_failed: ${(err as Error).message}`);
      this.#inFlight.delete(task.taskId);
      return;
    }

    if (this.opts.timeoutSec && this.opts.timeoutSec > 0) {
      timeout = setTimeout(() => ctrl.abort(), this.opts.timeoutSec * 1000);
      timeout.unref?.();
    }

    const at = () => new Date().toISOString();
    this.#emit({
      eventType: 'task.started',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      timestamp: at(),
    });

    child.on('error', (err) => {
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      this.#emitFailure(task, `claude_code_error: ${err.message}`);
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    child.stderr?.on('data', (d) =>
      this.opts.logger.warn('claude_code.stderr', { data: String(d).slice(0, 512) }),
    );

    let buffer = '';
    let lastOutput: Record<string, unknown> | undefined;
    let turns = 0;
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { type: string; [k: string]: unknown };
          const sessionId = firstString(ev.session_id, ev.sessionId, objectOf(ev.session)?.id);
          if (sessionId) this.#sessionId = sessionId;
          if (ev.type === 'assistant' || ev.type === 'thinking') {
            turns += 1;
            this.#emit({
              eventType: 'agent.thinking',
              agentId: this.opts.agentId,
              runId: task.runId,
              workflowId: task.workflowId,
              taskId: task.taskId,
              text: String(ev.text ?? ev.content ?? ''),
              timestamp: at(),
            });
          } else if (ev.type === 'tool_use') {
            this.#emit({
              eventType: 'agent.tool_call',
              agentId: this.opts.agentId,
              runId: task.runId,
              workflowId: task.workflowId,
              taskId: task.taskId,
              tool: String(ev.name ?? ''),
              input: ev.input ?? {},
              timestamp: at(),
            });
          } else if (ev.type === 'result') {
            lastOutput = (ev.result as Record<string, unknown>) ?? { text: ev.text };
          }
        } catch {
          this.#emit({
            eventType: 'task.progress',
            agentId: this.opts.agentId,
            runId: task.runId,
            workflowId: task.workflowId,
            taskId: task.taskId,
            message: line,
            timestamp: at(),
          });
        }
      }
    });

    child.on('exit', (code) => {
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
          output: lastOutput ?? { text: '' },
          timestamp: at(),
        });
      } else {
        this.#emitFailure(task, `claude_code exited ${code}`);
      }
    });

    // Pipe the prompt to stdin then close.
    child.stdin?.end(`${task.description}${formatToolManifestAwareness(task.toolManifest)}`);
  }

  async cancelTask(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort();
    this.#inFlight.delete(taskId);
  }

  async *chat(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<ChatDelta> {
    const ctrl = new AbortController();
    const bin = this.opts.binaryPath ?? 'claude';
    const args = [
      '--print',
      '--output-format=stream-json',
      `--max-turns=${this.opts.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT ?? 24}`,
      '--dangerously-skip-permissions',
      ...(this.opts.model ? [`--model=${this.opts.model}`] : []),
      ...(this.opts.allowedTools?.length ? [`--allowedTools=${this.opts.allowedTools.join(',')}`] : []),
      ...(this.#sessionId ? ['--resume', this.#sessionId] : []),
      ...(this.opts.extraArgs ?? []),
    ];
    const queue = createChatQueue();
    let child: ReturnType<typeof spawn>;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}) });
      const target = resolveSpawnTarget(bin, args, this.opts.cwd ?? process.cwd(), env);
      child = spawn(target.command, target.args, {
        cwd: this.opts.cwd,
        env,
        windowsHide: true,
        signal: ctrl.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = `Claude Code adapter failed to start: ${(err as Error).message}`;
      this.opts.logger.warn('claude_code.chat.spawn_failed', { err: message });
      yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: message };
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // Bound a single chat turn even when no timeout is configured, so a CLI
    // that wanders off can't hang the conversation forever.
    const chatTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    timeout = setTimeout(() => ctrl.abort(), chatTimeoutMs);
    timeout.unref?.();

    let stderrText = '';
    child.stderr?.on('data', (data) => {
      const chunk = String(data);
      stderrText = `${stderrText}${chunk}`.slice(-1024);
      this.opts.logger.warn('claude_code.chat.stderr', { data: chunk.slice(0, 512) });
    });
    child.on('error', (err) => {
      queue.push({ type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: `Claude Code error: ${err.message}` });
      queue.push({ type: 'done', finishReason: 'error' });
      queue.close();
      if (timeout) clearTimeout(timeout);
    });

    let buffer = '';
    let transcript = '';
    let rawFallback = '';
    const pendingToolCalls: ChatDelta[] = [];
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { type?: string; [k: string]: unknown };
          const sessionId = firstString(ev.session_id, ev.sessionId, objectOf(ev.session)?.id);
          if (sessionId) this.#sessionId = sessionId;
          const text = extractClaudeText(ev);
          if (text) transcript += text;
          for (const call of extractClaudeToolCalls(ev)) {
            pendingToolCalls.push({ type: 'tool_call', id: randomUUID(), name: call.name, args: call.args });
          }
        } catch {
          // stream-json mode emits JSON per line; non-JSON output is environment
          // noise (process-kill chatter). Keep it out of the visible transcript.
          if (!isProcessNoiseLine(line)) rawFallback += `${line}\n`;
        }
      }
    });
    child.on('exit', (code) => {
      if (timeout) clearTimeout(timeout);
      if (code !== 0) {
        const details = stderrText.trim();
        queue.push({
          type: 'tool_result',
          id: 'adapter',
          name: 'adapter.chat',
          result: null,
          error: details ? `Claude Code exited ${code}: ${details}` : `Claude Code exited ${code}`,
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
    child.stdin?.end(buildClaudeCodeChatPrompt(messages, tools));

    try {
      yield* queue.iterate();
    } finally {
      if (timeout) clearTimeout(timeout);
      ctrl.abort();
    }
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const h of this.#handlers) {
      try {
        h(event);
      } catch (err) {
        this.opts.logger.error('claude_code.handler_threw', { err: (err as Error).message });
      }
    }
  }

  #emitFailure(task: NormalizedTask, msg: string): void {
    this.#emit({
      eventType: 'task.failed',
      agentId: this.opts.agentId,
      runId: task.runId,
      workflowId: task.workflowId,
      taskId: task.taskId,
      error: msg,
      timestamp: new Date().toISOString(),
    });
  }
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

function extractClaudeText(event: { [k: string]: unknown }): string {
  const direct = firstString(event.text, event.content, event.result);
  if (direct) return direct;
  const message = objectOf(event.message);
  return firstString(message?.text, message?.content) ?? '';
}

function extractClaudeToolCalls(event: { [k: string]: unknown }): Array<{ name: string; args: unknown }> {
  const calls: Array<{ name: string; args: unknown }> = [];
  const add = (value: unknown) => {
    const object = objectOf(value);
    if (!object) return;
    const type = String(object.type ?? event.type ?? '').toLowerCase();
    if (!type.includes('tool') && !type.includes('function')) return;
    const name = firstString(object.name, object.tool, event.name, event.tool);
    if (!name) return;
    calls.push({ name, args: object.input ?? object.arguments ?? event.input ?? event.arguments ?? {} });
  };
  add(event);
  const message = objectOf(event.message);
  const content = message?.content ?? event.content;
  if (Array.isArray(content)) {
    for (const item of content) add(item);
  }
  return calls;
}

function buildClaudeCodeChatPrompt(messages: ChatMessage[], tools: ToolDefinition[]): string {
  return [
    buildMarkerToolPrompt(tools),
    '',
    'Conversation:',
    formatMessagesForClaude(messages),
  ].join('\n');
}

function formatMessagesForClaude(messages: ChatMessage[]): string {
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
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
