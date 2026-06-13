import { spawn } from 'node:child_process';
import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterHealthStatus,
  ChatDelta,
  ChatInvocationOptions,
  ChatMessage,
  NormalizedAgentEvent,
  NormalizedTask,
  ToolDefinition,
  RuntimeContext,
  RuntimeDescriptor,
  RuntimeSessionInfo,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { buildMarkerToolPrompt } from './markerToolProtocol.js';
import { linkAbortSignal } from './abort.js';
import {
  chatHardCeilingMs,
  clampChatTimeout,
  DEFAULT_CHAT_TURN_TIMEOUT_MS,
  runCliChatTurn,
  type CliChatPart,
} from './cliChatRuntime.js';
import type { RuntimeSessionStore } from '../services/runtimeSessionStore.js';
import { probeCliRuntime } from './cliRuntimeProbe.js';

export interface CursorAdapterOptions {
  agentId: string;
  binaryPath?: string;
  cwd?: string;
  model?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  workspaceId?: string;
  sessionStore?: RuntimeSessionStore;
  logger: Logger;
}

export class CursorAdapter implements AgentAdapter {
  readonly adapterType = 'cursor' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  readonly #sessions = new Map<string, string>();
  #version: string | null = null;

  constructor(private readonly opts: CursorAdapterOptions) {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    const result = await probeCliRuntime({
      binary: this.opts.binaryPath || 'agent',
      cwd: this.opts.cwd,
      env: this.opts.env,
      logger: this.opts.logger,
      logTag: 'cursor',
    });
    this.#version = result.version;
    return result.health;
  }

  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'marker_protocol',
      execution: {
        longRunning: true,
        pausable: true,
        sandbox: 'process',
        maxConcurrent: 1,
      },
      affordances: {
        codebaseIndex: true,
        fileSystem: true,
        terminal: true,
      },
      memory: {
        ingestible: true,
        injectable: true,
      },
    };
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    const currentModel = this.opts.model ?? 'cursor-default';
    return {
      provider: 'cursor',
      models: [{
        id: currentModel,
        label: currentModel,
        source: this.opts.model ? 'agent_config' : 'fallback',
        verified: Boolean(this.opts.model),
      }],
      currentModel,
      currentModelSource: this.opts.model ? 'agent_config' : 'fallback',
      currentModelVerified: Boolean(this.opts.model),
      fastModeSupported: false,
    };
  }

  async describeRuntime(): Promise<Partial<RuntimeDescriptor>> {
    const observedAt = new Date().toISOString();
    return {
      version: this.#version
        ? { value: this.#version, source: 'runtime', observedAt, verified: true }
        : null,
      process: {
        warm: false,
        activeSessions: this.#sessions.size,
      },
    };
  }

  async listRuntimeSessions(): Promise<RuntimeSessionInfo[]> {
    if (this.opts.sessionStore && this.opts.workspaceId) {
      return this.opts.sessionStore.list(this.opts.workspaceId, this.opts.agentId);
    }
    const now = new Date().toISOString();
    return [...this.#sessions.entries()].map(([sessionKey, runtimeSessionId]) => ({
      id: `${this.opts.agentId}:${sessionKey}`,
      sessionKey,
      runtimeSessionId,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }));
  }

  async closeRuntimeSession(sessionKey: string): Promise<void> {
    this.#sessions.delete(sessionKey);
    if (this.opts.sessionStore && this.opts.workspaceId) {
      this.opts.sessionStore.remove(this.opts.workspaceId, this.opts.agentId, sessionKey);
    }
  }

  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(task.signal, controller);
    this.#inFlight.set(task.taskId, controller);
    const binary = this.opts.binaryPath || 'agent';
    const args = [
      '--output-format',
      'stream-json',
      ...(task.preferredModel || this.opts.model ? [`--model=${task.preferredModel || this.opts.model}`] : []),
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
      unlinkAbort();
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
      unlinkAbort();
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
      unlinkAbort();
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

  async *chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    const sessionKey = options?.sessionKey?.trim() || 'default';
    const storedSession = this.#sessions.get(sessionKey)
      ?? (this.opts.sessionStore && this.opts.workspaceId
        ? this.opts.sessionStore.get(this.opts.workspaceId, this.opts.agentId, sessionKey)?.runtimeSessionId
        : undefined);
    const args = [
      '--output-format',
      'stream-json',
      ...(options?.preferredModel || this.opts.model ? [`--model=${options?.preferredModel || this.opts.model}`] : []),
      ...(storedSession ? ['--resume', storedSession] : []),
      ...(this.opts.extraArgs ?? []),
    ];
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const idleTimeoutMs = clampChatTimeout(options?.timeoutMs ?? configuredTimeoutMs);

    const interpret = (event: unknown): CliChatPart => {
      const ev = event as CursorJsonEvent;
      const sessionId = firstString(ev.session_id, ev.sessionId, objectOf(ev.session)?.id);
      if (sessionId) {
        this.#sessions.set(sessionKey, sessionId);
        if (this.opts.sessionStore && this.opts.workspaceId) {
          this.opts.sessionStore.upsert({
            workspaceId: this.opts.workspaceId,
            agentId: this.opts.agentId,
            conversationId: sessionKey,
            sessionKey,
            runtimeSessionId: sessionId,
            selectedModel: options?.preferredModel ?? this.opts.model ?? null,
            status: 'idle',
          });
        }
      }
      if (isReasoningEvent(ev)) {
        const reasoning = extractText(ev);
        return reasoning ? { kind: 'thinking', text: reasoning } : { kind: 'ignore' };
      }
      const text = extractText(ev);
      if (text) return { kind: 'text', text };
      const toolCall = extractToolCall(ev);
      if (toolCall) return { kind: 'tool', name: toolCall.tool, args: toolCall.input };
      return { kind: 'ignore' };
    };

    yield* runCliChatTurn({
      binary: this.opts.binaryPath ?? 'agent',
      args,
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdin: buildCursorChatPrompt(messages, tools),
      displayName: 'Cursor',
      logTag: 'cursor.chat',
      logger: this.opts.logger,
      signal: options?.signal,
      idleTimeoutMs,
      hardCeilingMs: chatHardCeilingMs(idleTimeoutMs, 'AGENTIS_CURSOR_CHAT_HARD_CEILING_MS'),
      interpret,
    });
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
