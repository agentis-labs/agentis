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
  ChatInvocationOptions,
  ChatMessage,
  NormalizedAgentEvent,
  NormalizedTask,
  RuntimeContext,
  RuntimeDescriptor,
  RuntimeSessionInfo,
  ToolDefinition,
} from '@agentis/core';
import { CONSTANTS } from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { buildMarkerToolPrompt, formatToolManifestAwareness } from './markerToolProtocol.js';
import { harnessMcpArgs, type McpHarnessServer } from '../services/mcpHarnessSession.js';
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
  dangerouslySkipPermissions?: boolean;
  /**
   * Agentis MCP servers to mount (`--mcp-config`) so the harness calls Agentis
   * tools natively in its own loop. When set, `toolForwarding` becomes
   * `mcp_native`. (UNIVERSAL-HARNESS §5.)
   */
  mcpServers?: McpHarnessServer[];
  workspaceId?: string;
  sessionStore?: RuntimeSessionStore;
  logger: Logger;
}
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly adapterType = 'claude_code' as const;
  readonly #handlers = new Set<(e: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  readonly #sessions = new Map<string, string>();
  #version: string | null = null;

  constructor(private readonly opts: ClaudeCodeAdapterOptions) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    for (const a of this.#inFlight.values()) a.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    const result = await probeCliRuntime({
      binary: this.opts.binaryPath ?? 'claude',
      cwd: this.opts.cwd,
      env: this.opts.env,
      logger: this.opts.logger,
      logTag: 'claude_code',
    });
    this.#version = result.version;
    return result.health;
  }

  #mcpNative(): boolean {
    return (this.opts.mcpServers?.length ?? 0) > 0;
  }

  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: this.#mcpNative() ? 'mcp_native' : 'marker_protocol',
      // Claude Code is a filesystem/terminal-native CLI that speaks MCP directly;
      // surfacing these affordances lets the engine route capability-tagged work
      // to it (parity with the Codex/Hermes adapters).
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
    const currentModel = configuredModel || 'runtime-default';
    return {
      provider: 'Anthropic',
      models: configuredModel
        ? [{
          id: configuredModel,
          label: configuredModel,
          source: 'agent_config',
          verified: false,
        }]
        : [],
      currentModel,
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

  onEvent(handler: (e: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const ctrl = new AbortController();
    const unlinkAbort = linkAbortSignal(task.signal, ctrl);
    this.#inFlight.set(task.taskId, ctrl);
    const bin = this.opts.binaryPath ?? 'claude';
    const args = [
      '--print',
      '--output-format=stream-json',
      `--max-turns=${this.opts.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT ?? 24}`,
      '--dangerously-skip-permissions',
      ...(task.preferredModel || this.opts.model ? [`--model=${task.preferredModel || this.opts.model}`] : []),
      ...(this.opts.allowedTools?.length ? [`--allowedTools=${this.opts.allowedTools.join(',')}`] : []),
      // Mount Agentis tools over MCP so Claude Code calls them natively in its loop.
      ...harnessMcpArgs('claude_code', this.opts.mcpServers ?? []),
      ...(this.opts.extraArgs ?? []),
    ];
    let child: ReturnType<typeof spawn>;
    let terminalEventEmitted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}), ...(task.abilityEnv ?? {}) });
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
      unlinkAbort();
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
      unlinkAbort();
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
    const maxTurns = options?.latencyClass === 'interactive'
      ? Math.min(this.opts.maxTurns ?? 4, 4)
      : this.opts.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT ?? 24;
    const args = [
      '--print',
      '--output-format=stream-json',
      `--max-turns=${maxTurns}`,
      '--dangerously-skip-permissions',
      ...(options?.preferredModel || this.opts.model ? [`--model=${options?.preferredModel || this.opts.model}`] : []),
      ...(this.opts.allowedTools?.length ? [`--allowedTools=${this.opts.allowedTools.join(',')}`] : []),
      ...(storedSession ? ['--resume', storedSession] : []),
      // Mount Agentis tools over MCP so Claude Code calls them natively in its loop.
      ...harnessMcpArgs('claude_code', this.opts.mcpServers ?? []),
      ...(this.opts.extraArgs ?? []),
    ];
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const idleTimeoutMs = clampChatTimeout(options?.timeoutMs ?? configuredTimeoutMs);

    // Walk each event's content blocks so every kind goes to the right channel:
    // thinking → ThinkingBubble, the harness's OWN tool use → a live activity step
    // (never an executable tool_call — Agentis must not re-run what Claude ran),
    // text → the answer body. Executable Agentis tool calls come ONLY from markers
    // in that answer text (extracted by the runtime at exit).
    const interpret = (event: unknown): CliChatPart[] => {
      const ev = event as { type?: string; [k: string]: unknown };
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
      return interpretClaudeChatEvent(ev);
    };

    yield* runCliChatTurn({
      binary: this.opts.binaryPath ?? 'claude',
      args,
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdin: buildClaudeCodeChatPrompt(messages, tools, this.#mcpNative()),
      displayName: 'Claude Code',
      logTag: 'claude_code.chat',
      logger: this.opts.logger,
      signal: options?.signal,
      idleTimeoutMs,
      hardCeilingMs: chatHardCeilingMs(idleTimeoutMs, 'AGENTIS_CLAUDE_CHAT_HARD_CEILING_MS'),
      interpret,
      formatExitError: (code, stderr) => {
        let details = stderr.trim();
        if (code === 1 && (details.includes('ERRO:') || details.includes('taskkill') || !details)) {
          details = 'The runtime process crashed. This is usually caused by an invalid API key, insufficient credits/quota, or a misconfigured model.\n\nRaw error: ' + details;
        }
        return details;
      },
    });
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

type ClaudeChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'activity'; delta: Extract<ChatDelta, { type: 'activity' }> };

/**
 * Split one Claude Code `stream-json` event into typed parts so each goes to the
 * right channel: `thinking` blocks → ThinkingBubble, the harness's OWN tool use
 * → a live activity step (never an executable tool_call), and `text` blocks →
 * the answer body. Walks the assistant message's content-block array (the modern
 * shape) and falls back to the flat text fields for simpler events.
 */
function interpretClaudeChatEvent(ev: { type?: string; [k: string]: unknown }): ClaudeChatPart[] {
  const parts: ClaudeChatPart[] = [];
  const message = objectOf(ev.message);
  const content = message?.content ?? ev.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') { if (block) parts.push({ kind: 'text', text: block }); continue; }
      const b = objectOf(block);
      if (!b) continue;
      const bt = String(b.type ?? '').toLowerCase();
      if (bt.includes('thinking') || bt.includes('reason')) {
        const t = firstString(b.thinking, b.text, b.content);
        if (t) parts.push({ kind: 'thinking', text: t });
      } else if (bt.includes('tool') || bt.includes('function') || bt.includes('mcp') || bt.includes('server_tool')) {
        parts.push({ kind: 'activity', delta: claudeToolActivity(b) });
      } else {
        const t = firstString(b.text, b.content);
        if (t) parts.push({ kind: 'text', text: t });
      }
    }
    return parts;
  }
  // Flat / non-block events (legacy `{type:'thinking'|'assistant', text}`, result).
  const evType = String(ev.type ?? '').toLowerCase();
  if (evType === 'thinking') {
    const t = extractClaudeText(ev);
    if (t) parts.push({ kind: 'thinking', text: t });
    return parts;
  }
  if (evType.includes('tool') || evType.includes('function')) {
    parts.push({ kind: 'activity', delta: claudeToolActivity(ev) });
    return parts;
  }
  const text = extractClaudeText(ev);
  if (text) parts.push({ kind: 'text', text });
  return parts;
}

/** A live activity step for one of Claude Code's own (Bash/Read/MCP) tool uses. */
function claudeToolActivity(b: Record<string, unknown>): Extract<ChatDelta, { type: 'activity' }> {
  const id = `claude-${String(b.id ?? randomUUID())}`;
  const raw = firstString(b.name, b.tool) ?? 'a tool';
  // MCP tools arrive namespaced as `mcp__agentis__build_workflow`; show the verb.
  const pretty = raw.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ').trim() || 'a tool';
  return { type: 'activity', id, phase: 'tool', status: 'running', label: `Using ${pretty}`, startedAt: new Date().toISOString() };
}

function buildClaudeCodeChatPrompt(messages: ChatMessage[], tools: ToolDefinition[], mcpNative = false): string {
  // MCP-native: Claude Code mounts the `agentis` MCP server and calls those tools
  // in its own loop, so we drop the marker-protocol instructions and hand it the
  // conversation directly.
  const toolPreamble = mcpNative
    ? 'You have the Agentis platform tools available via the "agentis" MCP server (build workflows, run them, inspect the workspace, dispatch agents, etc.). Use them directly to fulfill the request, then reply with a concise final answer.'
    : buildMarkerToolPrompt(tools);
  return [
    toolPreamble,
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
