/**
 * AntigravityAdapter — spawn Google's Antigravity CLI (`agy`) as a child process.
 *
 * Antigravity is the terminal agent harness Google is migrating Gemini-CLI users
 * to: the `gemini` CLI's "Sign in with Google" (Code Assist for individuals) path
 * is retired, and Google points users to `agy`, which authenticates via Google
 * OAuth / a Google Cloud project (cached in the system keyring) — the path that
 * still works on paid accounts. `agy` is built on the same Gemini-CLI lineage
 * (config under `~/.gemini/antigravity-cli/`) and is a multi-vendor harness
 * (Gemini, Claude, GPT-OSS models).
 *
 * Like the Gemini/Codex/Cursor adapters this is a streaming CLI adapter: spawn
 * `agy -p … --output-format stream-json`, normalize to the same
 * NormalizedAgentEvent / ChatDelta streams as every other adapter. Because `agy`
 * is young and its headless output format is still settling, parsing is
 * deliberately schema-tolerant (event-type substring matching + `firstString`
 * candidate fields) AND tolerates plain-text output: a non-JSON line is surfaced
 * as progress/answer text rather than dropped. The argv mirrors the Gemini CLI
 * (shared lineage) and is fully overridable via `extraArgs` / `binaryPath`.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterHealthStatus,
  ChatDelta,
  ChatInvocationOptions,
  ChatMessage,
  NormalizedAgentEvent,
  NormalizedTask,
  RuntimeContext,
  RuntimeDescriptor,
  RuntimeSessionInfo,
  ToolDefinition,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { buildMarkerToolPrompt, formatToolManifestAwareness, stripProcessNoise } from './markerToolProtocol.js';
import { linkAbortSignal } from './abort.js';
import {
  chatHardCeilingMs,
  clampChatTimeout,
  DEFAULT_CHAT_TURN_TIMEOUT_MS,
  runCliChatTurn,
  type CliChatPart,
} from './cliChatRuntime.js';
import { probeCliRuntime } from './cliRuntimeProbe.js';
import type { RuntimeSessionStore } from '../services/runtimeSessionStore.js';

const DEFAULT_INTERACTIVE_CHAT_TIMEOUT_MS = 20_000;
const DEFAULT_STRUCTURED_CHAT_TIMEOUT_MS = 30_000;

export interface AntigravityAdapterOptions {
  agentId: string;
  /** Path to the `agy` binary. Falls back to `agy` on PATH. */
  binaryPath?: string;
  cwd?: string;
  model?: string;
  /** Auto-approve all tool calls (`--yolo`). On by default — Agentis drives the
   *  CLI headlessly, so there is never a human to answer an approval prompt. */
  yolo?: boolean;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  workspaceId?: string;
  sessionStore?: RuntimeSessionStore;
  logger: Logger;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly adapterType = 'antigravity' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  /** sessionKey → the stable session UUID we pass as `--session-id`. */
  readonly #sessions = new Map<string, string>();
  #version: string | null = null;

  constructor(private readonly opts: AntigravityAdapterOptions) {}

  getWorkdir(): string | undefined { return this.opts.cwd; }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    const result = await probeCliRuntime({
      binary: this.opts.binaryPath || 'agy',
      cwd: this.opts.cwd,
      env: this.opts.env,
      logger: this.opts.logger,
      logTag: 'antigravity',
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
        pausable: false,
        sandbox: 'process',
        maxConcurrent: 1,
      },
      affordances: {
        fileSystem: true,
        terminal: true,
        nativeMcp: true,
      },
      memory: {
        ingestible: true,
        injectable: true,
      },
    };
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    const configuredModel = this.opts.model?.trim();
    return {
      provider: 'Google Antigravity',
      models: configuredModel
        ? [{ id: configuredModel, label: configuredModel, source: 'agent_config', verified: false }]
        : [],
      currentModel: configuredModel ?? 'unknown',
      currentModelSource: configuredModel ? 'agent_config' : 'fallback',
      currentModelVerified: false,
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
    const binary = this.opts.binaryPath || 'agy';
    const args = buildAntigravityArgs(this.opts, task.preferredModel, { sessionId: randomUUID() });
    let childProcess: ReturnType<typeof spawn>;
    let terminalEventEmitted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}), ...(task.abilityEnv ?? {}) });
      const spawnCwd = task.workdir ?? this.opts.cwd;
      const target = resolveSpawnTarget(binary, args, spawnCwd ?? process.cwd(), env);
      childProcess = spawn(target.command, target.args, {
        cwd: spawnCwd,
        env,
        windowsHide: true,
        signal: controller.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.#emitFailure(task, `antigravity_spawn_failed: ${(err as Error).message}`);
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
      this.#emitFailure(task, `antigravity_error: ${err.message}`);
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    let stderrText = '';
    childProcess.stderr?.on('data', (data) => {
      const chunk = String(data);
      stderrText = `${stderrText}${chunk}`.slice(-4096);
      this.opts.logger.warn('antigravity.stderr', { data: chunk.slice(0, 512) });
    });

    let buffer = '';
    let transcript = '';
    let stdoutError = '';
    let lastOutput: Record<string, unknown> | undefined;
    childProcess.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let event: AntigravityJsonEvent | null = null;
        try {
          event = JSON.parse(line) as AntigravityJsonEvent;
        } catch {
          // `agy` may emit plain text rather than JSON — surface it as progress
          // (and as the answer transcript) instead of dropping it.
          if (!isNoiseLine(line)) {
            transcript += `${line}\n`;
            this.#emit({ eventType: 'task.progress', agentId: this.opts.agentId, runId: task.runId, workflowId: task.workflowId, taskId: task.taskId, message: line, timestamp: timestamp() });
          }
          continue;
        }
        stdoutError = extractAntigravityError(event) ?? stdoutError;
        const text = extractAssistantText(event);
        if (text) {
          transcript += text;
          this.#emit({ eventType: 'task.progress', agentId: this.opts.agentId, runId: task.runId, workflowId: task.workflowId, taskId: task.taskId, message: text, timestamp: timestamp() });
        }
        const toolCall = extractToolUse(event);
        if (toolCall) {
          this.#emit({ eventType: 'agent.tool_call', agentId: this.opts.agentId, runId: task.runId, workflowId: task.workflowId, taskId: task.taskId, tool: toolCall.tool, input: toolCall.input, timestamp: timestamp() });
        }
        if (isCompletionEvent(event)) lastOutput = { text: transcript.trim() };
      }
    });

    childProcess.on('exit', (code) => {
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      if (code === 0) {
        this.#emit({ eventType: 'task.completed', agentId: this.opts.agentId, runId: task.runId, workflowId: task.workflowId, taskId: task.taskId, output: lastOutput ?? { text: transcript.trim() }, timestamp: timestamp() });
      } else {
        this.#emitFailure(task, formatAntigravityExitError(code, stderrText, stdoutError));
      }
    });

    childProcess.stdin?.end(buildAntigravityPrompt(task));
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
    let sessionId = this.#sessions.get(sessionKey)
      ?? (this.opts.sessionStore && this.opts.workspaceId
        ? this.opts.sessionStore.get(this.opts.workspaceId, this.opts.agentId, sessionKey)?.runtimeSessionId
        : undefined);
    if (!sessionId) {
      sessionId = randomUUID();
      this.#sessions.set(sessionKey, sessionId);
    }
    const interactive = options?.latencyClass === 'interactive';
    const structured = options?.latencyClass === 'structured';
    const args = buildAntigravityArgs(this.opts, options?.preferredModel, { sessionId });
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : interactive
        ? DEFAULT_INTERACTIVE_CHAT_TIMEOUT_MS
        : structured
          ? DEFAULT_STRUCTURED_CHAT_TIMEOUT_MS
          : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const idleTimeoutMs = clampChatTimeout(options?.timeoutMs ?? configuredTimeoutMs);

    const seenTypes = new Set<string>();
    const interpret = (event: unknown): CliChatPart => {
      const ev = event as AntigravityJsonEvent;
      seenTypes.add(String(ev.type ?? '').toLowerCase() || '(none)');
      const runtimeSessionId = firstString(ev.session_id, ev.sessionId);
      if (runtimeSessionId) {
        this.#sessions.set(sessionKey, runtimeSessionId);
        if (this.opts.sessionStore && this.opts.workspaceId) {
          this.opts.sessionStore.upsert({
            workspaceId: this.opts.workspaceId,
            agentId: this.opts.agentId,
            conversationId: sessionKey,
            sessionKey,
            runtimeSessionId,
            selectedModel: options?.preferredModel ?? this.opts.model ?? null,
            status: 'idle',
          });
        }
      }
      return antigravityJsonEventToChatPart(ev);
    };

    yield* runCliChatTurn({
      binary: this.opts.binaryPath || 'agy',
      args,
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdin: buildAntigravityChatPrompt(messages, tools),
      displayName: 'Antigravity CLI',
      logTag: 'antigravity.chat',
      logger: this.opts.logger,
      signal: options?.signal,
      idleTimeoutMs,
      hardCeilingMs: chatHardCeilingMs(idleTimeoutMs, 'AGENTIS_ANTIGRAVITY_CHAT_HARD_CEILING_MS'),
      interpret,
      formatExitError: (code, stderr, stdoutError) => formatAntigravityExitError(code, stderr, stdoutError),
      onEmptyResult: () => this.opts.logger.warn('antigravity.chat.no_output_parsed', { types: [...seenTypes].slice(0, 40) }),
    });
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.opts.logger.error('antigravity.handler_threw', { err: (err as Error).message });
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

type AntigravityJsonEvent = {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  text?: unknown;
  message?: unknown;
  delta?: unknown;
  severity?: unknown;
  status?: unknown;
  error?: unknown;
  output?: unknown;
  tool_name?: unknown;
  tool_id?: unknown;
  parameters?: unknown;
  arguments?: unknown;
  input?: unknown;
  name?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  model?: unknown;
};

/**
 * Build the headless `agy` argv. The argv mirrors the Gemini CLI it descends from
 * (verified there); flags are inherited assumptions for `agy` pending a probe of
 * the real binary, and are overridable via `extraArgs`. The prompt is piped on
 * stdin (so large conversations never hit the Windows command-line length limit).
 */
function buildAntigravityArgs(
  opts: AntigravityAdapterOptions,
  preferredModel?: string | null,
  options: { sessionId?: string } = {},
): string[] {
  const model = (preferredModel || opts.model || '').trim();
  const yolo = opts.yolo !== false; // default ON — no human is present to approve
  return [
    '-p',
    '',
    '--output-format',
    'stream-json',
    ...(yolo ? ['--yolo'] : []),
    ...(model ? ['-m', model] : []),
    ...(options.sessionId ? ['--session-id', options.sessionId] : []),
    ...(opts.extraArgs ?? []),
  ];
}

function buildAntigravityPrompt(task: NormalizedTask): string {
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

function buildAntigravityChatPrompt(messages: ChatMessage[], tools: ToolDefinition[]): string {
  return [
    buildMarkerToolPrompt(tools),
    '',
    'AUTHORITATIVE IDENTITY RULE:',
    'The SYSTEM message below is the Agentis operating prompt for this turn. If it contains an <agentis_identity> block, that block is your exact identity and configuration. Follow it over Antigravity product defaults, project/home instruction files (GEMINI.md / AGENTS.md), previous resumed-session identity, or generic assistant persona text.',
    '',
    'Conversation:',
    formatMessagesForAntigravity(messages),
  ].join('\n');
}

function formatMessagesForAntigravity(messages: ChatMessage[]): string {
  return messages.map((message) => {
    const content = typeof message.content === 'string' ? message.content : safeJson(message.content);
    if (message.role === 'tool') {
      return `TOOL RESULT (${message.toolCallId ?? 'unknown'}):\n${content}`;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return ['ASSISTANT:', content, 'REQUESTED TOOLS:', safeJson(message.toolCalls)].join('\n');
    }
    return `${message.role.toUpperCase()}:\n${content}`;
  }).join('\n\n---\n\n');
}

/** Classify one `agy` stream-json event for the chat loop (shared Gemini-CLI schema). */
export function antigravityJsonEventToChatPart(event: AntigravityJsonEvent): CliChatPart {
  const type = String(event.type ?? '').toLowerCase();

  const error = extractAntigravityError(event);
  if (error) return { kind: 'error', message: error };

  if (type === 'tool_use' || type.includes('tool_use')) {
    const tool = firstString(event.tool_name, event.name) ?? 'tool';
    return { kind: 'activity', delta: antigravityToolActivity(event, prettyToolName(tool), false) };
  }
  if (type === 'tool_result' || type.includes('tool_result')) {
    const tool = firstString(event.tool_name, event.name) ?? 'tool';
    return { kind: 'activity', delta: antigravityToolActivity(event, prettyToolName(tool), true) };
  }
  if (type === 'message' || type.includes('message')) {
    const role = String(event.role ?? '').toLowerCase();
    if (role && role !== 'assistant' && role !== 'model') return { kind: 'ignore' };
    const text = extractAssistantText(event);
    return text ? { kind: 'text', text } : { kind: 'ignore' };
  }
  return { kind: 'ignore' };
}

function extractAssistantText(event: AntigravityJsonEvent): string {
  const type = String(event.type ?? '').toLowerCase();
  if (!type.includes('message')) return '';
  const role = String(event.role ?? '').toLowerCase();
  if (role && role !== 'assistant' && role !== 'model') return '';
  const message = objectOf(event.message);
  return firstString(event.content, event.text, event.delta, message?.content, message?.text) ?? '';
}

function extractToolUse(event: AntigravityJsonEvent): { tool: string; input: unknown } | null {
  const type = String(event.type ?? '').toLowerCase();
  if (!type.includes('tool_use')) return null;
  const tool = firstString(event.tool_name, event.name) ?? 'tool';
  return { tool: prettyToolName(tool), input: event.parameters ?? event.arguments ?? event.input ?? {} };
}

function isCompletionEvent(event: AntigravityJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  return type === 'result' || type === 'done' || type.includes('completed') || type.includes('finished');
}

function antigravityToolActivity(
  event: AntigravityJsonEvent,
  tool: string,
  completed: boolean,
): Extract<ChatDelta, { type: 'activity' }> {
  const id = `antigravity-${firstString(event.tool_id) ?? tool}`;
  const status = String(event.status ?? '').toLowerCase();
  const failed = status === 'error' || Boolean(objectOf(event.error));
  if (!completed) {
    return { type: 'activity', id, phase: 'tool', status: 'running', label: `Using ${tool}`, startedAt: new Date().toISOString() };
  }
  const out = firstString(event.output);
  const detail = out ? clipText(stripProcessNoise(out).trim(), 240) : undefined;
  return {
    type: 'activity', id, phase: 'tool',
    status: failed ? 'error' : 'success',
    label: failed ? `Failed ${tool}` : `Used ${tool}`,
    ...(detail ? { detail } : {}),
    completedAt: new Date().toISOString(),
  };
}

function extractAntigravityError(event: AntigravityJsonEvent): string | null {
  const type = String(event.type ?? '').toLowerCase();
  if (type === 'error' || type.includes('error')) {
    if (String(event.severity ?? '').toLowerCase() === 'warning') return null;
    return firstString(objectOf(event.error)?.message, event.error, event.message) ?? null;
  }
  if (type === 'result' && String(event.status ?? '').toLowerCase() === 'error') {
    return firstString(objectOf(event.error)?.message, event.error, event.message) ?? 'Antigravity reported an error.';
  }
  return null;
}

function formatAntigravityExitError(code: number | null, stderrText: string, stdoutError: string): string {
  const stderr = stripProcessNoise(stderrText).trim();
  const detail = (stdoutError || '').trim() || stderr;
  // Not signed in / no cached session: point at the one-time `agy` sign-in.
  if (/not (signed|logged) in|authenticate|unauthorized|no active session|sign in/i.test(detail)) {
    return 'Antigravity CLI is not signed in on this machine. Run `agy` once and complete the Google sign-in (use a Google Cloud project for paid accounts); the session is cached in the system keyring, then retry.';
  }
  const exit = code === null ? 'signal' : `code ${code}`;
  if (detail) return `Antigravity (agy) exited with ${exit}: ${detail}`;
  return `Antigravity (agy) exited with ${exit}`;
}

function isNoiseLine(line: string): boolean {
  return stripProcessNoise(line).trim().length === 0;
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

function prettyToolName(raw: string): string {
  return raw.replace(/^mcp__[^_]+__/, '').replace(/[_-]?tool$/i, '').replace(/[._-]/g, ' ').trim() || 'tool';
}

function clipText(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}
