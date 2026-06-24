import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { McpHarnessServer } from '../services/mcpHarnessSession.js';
import type { RuntimeSessionStore } from '../services/runtimeSessionStore.js';
import { resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { linkAbortSignal } from './abort.js';
import { AcpClient, toAcpHttpMcpServers, type AcpModelInfo, type AcpSessionUpdate } from './acpClient.js';
import {
  chatHardCeilingMs,
  createChatQueue,
  DEFAULT_CHAT_TURN_TIMEOUT_MS,
  runCliChatTurn,
} from './cliChatRuntime.js';
import { probeCliRuntime } from './cliRuntimeProbe.js';
import { runtimeProgressActivity } from './runtimeProgress.js';

const DEFAULT_HERMES_STARTUP_TIMEOUT_MS = 120_000;
const MAX_HERMES_STARTUP_TIMEOUT_MS = 300_000;
const DEFAULT_HERMES_FIRST_EVENT_TIMEOUT_MS = 90_000;
const MIN_HERMES_FIRST_EVENT_TIMEOUT_MS = 15_000;
const MAX_HERMES_FIRST_EVENT_TIMEOUT_MS = 120_000;

export interface HermesAgentAdapterOptions {
  agentId: string;
  binaryPath?: string;
  cwd?: string;
  model?: string;
  chatTransport?: 'cli' | 'acp' | 'auto';
  maxTurns?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  /**
   * Agentis-managed operating instructions. The chat executor injects the current
   * overlay into every turn; the adapter never overwrites runtime-owned files.
   */
  instructions?: string | null;
  workspaceId?: string;
  sessionStore?: RuntimeSessionStore;
  /**
   * Agentis MCP servers to mount into the harness so it calls Agentis tools
   * natively over MCP (real tools, real workspace state) and runs its own
   * agentic loop in ONE invocation — no marker-protocol re-spawn. When set, chat
   * runs over ACP (streaming) with these servers mounted. (UNIVERSAL-HARNESS §5.)
   */
  mcpServers?: McpHarnessServer[];
  logger: Logger;
}

export class HermesAgentAdapter implements AgentAdapter {
  readonly adapterType = 'hermes_agent' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  #client: AcpClient | undefined;
  #clientReady: Promise<AcpClient> | undefined;
  #processGeneration = Date.now();
  #prewarmReady: Promise<void> | undefined;
  #prewarmedSession: {
    sessionId: string;
    processGeneration: number;
    models?: AcpModelInfo[];
  } | undefined;
  #activeSessionId: string | undefined;
  #turnTail: Promise<void> = Promise.resolve();
  #version: string | null = null;
  readonly #sessions = new Map<string, {
    sessionId: string;
    processGeneration: number;
    selectedModel: string | null;
    createdAt: string;
    updatedAt: string;
  }>();
  /** Real model list advertised by the harness in `session/new` (cached per process). */
  #models: AcpModelInfo[] = [];

  constructor(private readonly opts: HermesAgentAdapterOptions) {}

  getWorkdir(): string | undefined { return this.opts.cwd; }

  async connect(): Promise<void> {
    if (!shouldPrewarmHermesOnConnect(this.opts.env) || this.#chatTransport() === 'cli' || this.#prewarmReady || this.#prewarmedSession) return;
    const startupTimeoutMs = boundedTimeout(
      process.env.AGENTIS_HERMES_STARTUP_TIMEOUT_MS,
      DEFAULT_HERMES_STARTUP_TIMEOUT_MS,
      MAX_HERMES_STARTUP_TIMEOUT_MS,
      DEFAULT_HERMES_STARTUP_TIMEOUT_MS,
    );
    this.#prewarmReady = this.#prewarm(startupTimeoutMs).catch((err) => {
      this.#prewarmReady = undefined;
      this.opts.logger.warn('hermes_agent.acp.prewarm_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async disconnect(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
    this.#client?.dispose();
    this.#client = undefined;
    this.#clientReady = undefined;
    this.#prewarmReady = undefined;
    this.#prewarmedSession = undefined;
    this.#activeSessionId = undefined;
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    const result = await probeCliRuntime({
      binary: this.opts.binaryPath || 'hermes',
      cwd: this.opts.cwd,
      env: this.opts.env,
      logger: this.opts.logger,
      logTag: 'hermes_agent',
    });
    this.#version = result.version;
    return result.health;
  }

  capabilities(): AdapterCapabilities {
    const acp = this.#chatTransport() !== 'cli';
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: acp ? 'mcp_native' : 'marker_protocol',
      ...(!acp ? {
        limitations: [
          'Using Hermes CLI compatibility transport because current Hermes ACP builds can stall before returning model output.',
        ],
      } : {}),
      execution: {
        longRunning: true,
        pausable: true,
        sandbox: 'process',
        maxConcurrent: 1,
      },
      affordances: {
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
    const currentModel = this.opts.model ?? 'hermes-agent-default';
    // After the first chat turn we know the harness's REAL model catalog (from
    // ACP session/new) — surface it so the runtime picker offers actual choices
    // instead of a placeholder. Bare names (sans provider prefix) match how
    // Agentis stores the selection.
    const models = this.#models.length > 0
      ? this.#models.map((m) => ({
        id: m.name ?? m.modelId,
        label: m.name ?? m.modelId,
        source: 'runtime' as const,
        verified: true,
      }))
      : [{
        id: currentModel,
        label: currentModel,
        source: this.opts.model ? 'agent_config' as const : 'fallback' as const,
        verified: Boolean(this.opts.model),
      }];
    return {
      provider: 'hermes_agent',
      models,
      currentModel,
      currentModelSource: this.opts.model ? 'agent_config' : 'runtime',
      currentModelVerified: this.#models.length > 0,
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
        warm: Boolean(this.#client),
        generation: this.#processGeneration,
        activeSessions: this.#sessions.size,
      },
    };
  }

  async listRuntimeSessions(): Promise<RuntimeSessionInfo[]> {
    if (this.opts.sessionStore && this.opts.workspaceId) {
      return this.opts.sessionStore.list(this.opts.workspaceId, this.opts.agentId);
    }
    return [...this.#sessions.entries()].map(([sessionKey, session]) => ({
      id: `${this.opts.agentId}:${sessionKey}`,
      sessionKey,
      runtimeSessionId: session.sessionId,
      status: 'idle',
      selectedModel: session.selectedModel,
      processGeneration: session.processGeneration,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastUsedAt: session.updatedAt,
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
    const binary = this.opts.binaryPath || 'hermes';
    const { args, cleanup } = this.#buildChatInvocation(buildPrompt(task));
    let childProcess: ReturnType<typeof spawn>;
    let terminalEventEmitted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}) });
      // Isolated per-task directory when the engine allocated one (parallel swarm
      // subtask); otherwise the adapter's single-agent configured cwd.
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
      this.#emitFailure(task, `hermes_agent_spawn_failed: ${(err as Error).message}`);
      cleanup();
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
      this.#emitFailure(task, `hermes_agent_error: ${err.message}`);
      cleanup();
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    let stderrTail = '';
    childProcess.stderr?.on('data', (data) => {
      const chunk = String(data);
      stderrTail = `${stderrTail}${chunk}`.slice(-1024);
      this.opts.logger.warn('hermes_agent.stderr', { data: chunk.slice(0, 512) });
    });

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
        const parsed = parseJson(line);
        if (!parsed) {
          transcript += line + '\n';
          this.#emitProgress(task, line, timestamp());
          continue;
        }
        const text = extractText(parsed);
        if (text) {
          transcript += text;
          this.#emitProgress(task, text, timestamp());
        }
        const toolCall = extractToolCall(parsed);
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
        if (isCompletionEvent(parsed)) lastOutput = extractOutput(parsed, transcript);
      }
    });

    childProcess.on('exit', (code) => {
      cleanup();
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
        this.#emitFailure(task, `hermes_agent exited ${code}: ${stderrTail.trim() || 'see logs'}`);
      }
    });

    // The prompt is passed as the `-q` argument (hermes chat reads no stdin in
    // quiet mode), so close stdin immediately.
    childProcess.stdin?.end();
  }

  async cancelTask(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort();
    this.#inFlight.delete(taskId);
  }

  /**
   * Build a `hermes chat` invocation for one headless turn.
   *
   * The prompt is written to a temp file and passed as `-q "@file:<path>"`
   * (Hermes's documented file-injection syntax) rather than inline. A full chat
   * prompt — system context, tool schemas, brain discourse, conversation history
   * — is tens of KB and blows the OS command-line limit when passed as a literal
   * argument (`spawn ENAMETOOLONG`). `@file:` keeps the command line tiny and
   * handles Windows drive-letter paths (`C:\...`) correctly.
   *
   * `-Q` (quiet) is the documented programmatic mode: it suppresses the
   * banner/spinner/tool previews and prints only the final response to stdout
   * (the `session_id:` line goes to stderr). `--max-turns` and `-m` are
   * `chat`-subcommand flags — NOT top-level ones (passing `--max-turns` at the
   * top level is the "unrecognized arguments" crash this adapter used to hit).
   * `--yolo` avoids a TTY approval hang.
   *
   * The caller MUST invoke `cleanup()` once the process has exited.
   */
  #buildChatInvocation(prompt: string, model = this.opts.model): { args: string[]; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'agentis-hermes-'));
    const promptFile = join(dir, 'prompt.txt');
    writeFileSync(promptFile, prompt, 'utf8');
    const args = [
      'chat',
      '-q', `@file:${promptFile}`,
      '-Q',
      ...(model ? ['-m', model] : []),
      '--max-turns', String(this.opts.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT ?? 24),
      '--yolo',
      ...(this.opts.extraArgs ?? []),
    ];
    return {
      args,
      cleanup: () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // A leftover temp file in the OS temp dir is harmless.
        }
      },
    };
  }

  async *chat(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    const transport = this.#chatTransport();
    if (transport === 'cli') {
      yield* this.#chatCli(messages, options);
      return;
    }
    const allowCliFallback = transport === 'auto';

    const releaseTurn = await this.#acquireTurn();
    const queue = createChatQueue();
    const sessionKey = options?.sessionKey?.trim() || 'default';
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const requestedRoundMs = Math.max(30_000, options?.timeoutMs ?? configuredTimeoutMs);
    const hardCeilingMs = chatHardCeilingMs(requestedRoundMs, 'AGENTIS_HERMES_CHAT_HARD_CEILING_MS');
    const firstEventTimeoutMs = boundedTimeout(
      process.env.AGENTIS_HERMES_FIRST_EVENT_TIMEOUT_MS,
      DEFAULT_HERMES_FIRST_EVENT_TIMEOUT_MS,
      Math.min(hardCeilingMs, MAX_HERMES_FIRST_EVENT_TIMEOUT_MS),
      MIN_HERMES_FIRST_EVENT_TIMEOUT_MS,
    );
    const startupTimeoutMs = boundedTimeout(
      process.env.AGENTIS_HERMES_STARTUP_TIMEOUT_MS,
      DEFAULT_HERMES_STARTUP_TIMEOUT_MS,
      MAX_HERMES_STARTUP_TIMEOUT_MS,
      DEFAULT_HERMES_STARTUP_TIMEOUT_MS,
    );
    let settled = false;
    let fallbackStarted = false;
    let client: AcpClient | undefined;
    let sessionId = '';
    let firstEventSeen = false;
    let firstEventTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const turnState: HermesAcpTurnState = {
      sessionKey,
      agentId: this.opts.agentId,
      thoughtText: '',
      toolLabels: new Map(),
    };

    const finish = (deltas: ChatDelta[]) => {
      if (settled) return;
      settled = true;
      if (firstEventTimer) clearTimeout(firstEventTimer);
      if (hardTimer) clearTimeout(hardTimer);
      for (const delta of deltas) queue.push(delta);
      queue.close();
    };
    const fallbackToCli = async (code: string, message: string) => {
      if (settled || fallbackStarted) return;
      fallbackStarted = true;
      settled = true;
      if (firstEventTimer) clearTimeout(firstEventTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (client) {
        void client.cancel(sessionId);
        this.#invalidateClient(client);
      }
      if (this.opts.sessionStore && this.opts.workspaceId) {
        this.opts.sessionStore.markStatus(this.opts.workspaceId, this.opts.agentId, sessionKey, 'stale');
      }
      queue.push({
        type: 'activity',
        id: `hermes-fallback-${sessionKey}`,
        label: 'Switching Hermes transport',
        detail: `${code}: ${message}`,
        phase: 'runtime',
        status: 'running',
        startedAt: new Date().toISOString(),
        agentId: this.opts.agentId,
      });
      try {
        for await (const delta of this.#chatCli(messages, options)) queue.push(delta);
      } catch (err) {
        queue.push({
          type: 'tool_result',
          id: 'adapter',
          name: 'adapter.chat',
          result: null,
          error: `hermes_cli_fallback_failed: ${(err as Error).message}`,
        });
        queue.push({ type: 'done', finishReason: 'error' });
      } finally {
        queue.close();
      }
    };
    const failTurn = (code: string, message: string) => {
      if (allowCliFallback && !firstEventSeen && isHermesAcpStartupOrSessionFailure(code)) {
        void fallbackToCli(code, message);
        return;
      }
      if (client) {
        void client.cancel(sessionId);
        this.#invalidateClient(client);
      }
      if (this.opts.sessionStore && this.opts.workspaceId) {
        this.opts.sessionStore.markStatus(this.opts.workspaceId, this.opts.agentId, sessionKey, 'stale');
      }
      finish([
        { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: `${code}: ${message}` },
        { type: 'done', finishReason: 'error' },
      ]);
    };

    void (async () => {
      try {
        queue.push({
          type: 'activity',
          id: `hermes-runtime-${sessionKey}`,
          label: 'Starting Hermes runtime',
          detail: 'Connecting to the persistent ACP runtime.',
          phase: 'runtime',
          status: 'running',
          startedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });
        client = await this.#ensureClient(startupTimeoutMs);
        queue.push({
          type: 'activity',
          id: `hermes-runtime-${sessionKey}`,
          label: 'Hermes runtime ready',
          phase: 'runtime',
          status: 'success',
          completedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });
        queue.push({
          type: 'activity',
          id: `hermes-session-${sessionKey}`,
          label: 'Opening Hermes session',
          detail: 'Preparing the conversation and runtime tools.',
          phase: 'runtime',
          status: 'running',
          startedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });
        const session = await this.#openSession(client, sessionKey, startupTimeoutMs);
        queue.push({
          type: 'activity',
          id: `hermes-session-${sessionKey}`,
          label: 'Hermes session ready',
          phase: 'runtime',
          status: 'success',
          completedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });
        sessionId = session.sessionId;
        this.#activeSessionId = sessionId;
        if (session.models?.length) this.#models = session.models;

        const requestedModel = options?.preferredModel ?? this.opts.model;
        const resolvedModelId = resolveAcpModelId(requestedModel, session.models ?? this.#models);
        if (resolvedModelId && session.selectedModel !== resolvedModelId) {
          queue.push({
            type: 'activity',
            id: `hermes-model-${sessionKey}`,
            label: `Selecting ${requestedModel ?? resolvedModelId}`,
            phase: 'runtime',
            status: 'running',
            startedAt: new Date().toISOString(),
            agentId: this.opts.agentId,
          });
          await withDeadline(
            client.setModel(sessionId, resolvedModelId),
            startupTimeoutMs,
            'model_selection_timeout',
          );
          session.selectedModel = resolvedModelId;
          this.#persistSession(sessionKey, sessionId, resolvedModelId, 'active');
          queue.push({
            type: 'activity',
            id: `hermes-model-${sessionKey}`,
            label: `Using ${requestedModel ?? resolvedModelId}`,
            phase: 'runtime',
            status: 'success',
            completedAt: new Date().toISOString(),
            agentId: this.opts.agentId,
          });
        } else if (requestedModel && !resolvedModelId) {
          this.opts.logger.warn('hermes_agent.acp.model_not_offered', { requested: requestedModel });
        }

        queue.push({
          type: 'activity',
          id: `hermes-wait-${sessionKey}`,
          label: 'Waiting for Hermes',
          detail: requestedModel
            ? `The runtime is waiting for ${requestedModel}. Provider silence is allowed.`
            : 'The runtime is waiting for its configured provider. Provider silence is allowed.',
          phase: 'waiting',
          status: 'running',
          startedAt: new Date().toISOString(),
          agentId: this.opts.agentId,
        });

        firstEventTimer = setTimeout(() => {
          failTurn(
            'first_event_timeout',
            `Hermes produced no model event within ${Math.round(firstEventTimeoutMs / 1000)} seconds.`,
          );
        }, firstEventTimeoutMs);
        firstEventTimer.unref?.();
        hardTimer = setTimeout(() => {
          failTurn(
            'hard_deadline',
            `Hermes exceeded the ${Math.round(hardCeilingMs / 1000)} second turn ceiling.`,
          );
        }, hardCeilingMs);
        hardTimer.unref?.();
        abortHandler = () => failTurn('canceled', 'The operator canceled this turn.');
        options?.signal?.addEventListener('abort', abortHandler, { once: true });

        const result = await client.sessionPrompt(
          { sessionId, prompt: [{ type: 'text', text: formatAcpPrompt(messages) }] },
          (update) => {
            if (!firstEventSeen) {
              firstEventSeen = true;
              if (firstEventTimer) clearTimeout(firstEventTimer);
            }
            const delta = acpUpdateToDelta(update, turnState);
            if (delta && !settled) queue.push(delta);
          },
        );
        if (firstEventTimer) clearTimeout(firstEventTimer);
        this.#persistSession(sessionKey, sessionId, session.selectedModel, 'idle');
        const finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] =
          result.stopReason === 'max_tokens' || result.stopReason === 'max_turn_requests' ? 'max_turns' : 'stop';
        finish([{ type: 'done', finishReason }]);
      } catch (err) {
        if (!settled) {
          const message = err instanceof Error ? err.message : String(err);
          failTurn(classifyHermesError(message), message);
        }
      } finally {
        if (abortHandler) options?.signal?.removeEventListener('abort', abortHandler);
        if (this.#activeSessionId === sessionId) this.#activeSessionId = undefined;
      }
    })();

    try {
      yield* queue.iterate();
    } finally {
      if (firstEventTimer) clearTimeout(firstEventTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (abortHandler) options?.signal?.removeEventListener('abort', abortHandler);
      releaseTurn();
    }
  }

  async *#chatCli(
    messages: ChatMessage[],
    options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const idleTimeoutMs = Math.max(30_000, options?.timeoutMs ?? configuredTimeoutMs);
    const requestedModel = normalizeHermesCliModel(options?.preferredModel) ?? normalizeHermesCliModel(this.opts.model);
    const invocation = this.#buildChatInvocation(formatAcpPrompt(messages), requestedModel);

    yield {
      type: 'activity',
      id: `hermes-cli-${options?.sessionKey ?? 'default'}`,
      label: 'Starting Hermes',
      detail: 'Using the stable Hermes headless CLI transport.',
      phase: 'runtime',
      status: 'running',
      startedAt: new Date().toISOString(),
      agentId: this.opts.agentId,
    };

    try {
      for await (const delta of runCliChatTurn({
        binary: this.opts.binaryPath || 'hermes',
        args: invocation.args,
        cwd: this.opts.cwd,
        env: this.opts.env,
        stdin: '',
        displayName: 'Hermes',
        logTag: 'hermes_agent.chat',
        logger: this.opts.logger,
        signal: options?.signal,
        idleTimeoutMs,
        hardCeilingMs: chatHardCeilingMs(idleTimeoutMs, 'AGENTIS_HERMES_CHAT_HARD_CEILING_MS'),
        interpret: (event) => {
          const parsed = event && typeof event === 'object' ? event as Record<string, unknown> : {};
          const text = extractText(parsed);
          return text ? { kind: 'final', text } : { kind: 'ignore' };
        },
        formatExitError: (_code, stderr) => stderr.trim(),
        onEmptyResult: () => {
          this.opts.logger.warn('hermes_agent.chat.empty_result', {
            agentId: this.opts.agentId,
            sessionKey: options?.sessionKey ?? 'default',
          });
        },
      })) {
        if (
          delta.type === 'tool_result'
          && delta.id === 'adapter'
          && options?.signal?.aborted
        ) {
          yield {
            ...delta,
            error: 'canceled: The operator canceled this turn.',
          };
          continue;
        }
        yield delta;
      }
    } finally {
      invocation.cleanup();
    }
  }

  #chatTransport(): 'cli' | 'acp' | 'auto' {
    const configured = this.opts.chatTransport
      ?? this.opts.env?.AGENTIS_HERMES_CHAT_TRANSPORT
      ?? process.env.AGENTIS_HERMES_CHAT_TRANSPORT;
    const normalized = configured?.trim().toLowerCase();
    if (normalized === 'cli') return 'cli';
    if (normalized === 'acp') return 'acp';
    return 'auto';
  }

  async #acquireTurn(): Promise<() => void> {
    const previous = this.#turnTail;
    let release!: () => void;
    this.#turnTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  async #ensureClient(startupTimeoutMs: number): Promise<AcpClient> {
    if (this.#client) return this.#client;
    if (this.#clientReady) return this.#clientReady;
    this.#clientReady = (async () => {
      let client: AcpClient;
      client = new AcpClient({
        command: this.opts.binaryPath || 'hermes',
        args: ['acp'],
        cwd: this.opts.cwd,
        env: this.opts.env,
        logger: this.opts.logger,
        logTag: 'hermes_agent.acp',
        stderrLogLevel: 'none',
        onPermission: (request) => {
          this.opts.logger.debug?.('hermes_agent.permission_requested', {
            tool: request.toolCall?.title ?? request.toolCall?.kind ?? 'unknown',
          });
          return null;
        },
        onClose: () => {
          if (this.#client === client) {
            this.#client = undefined;
            this.#clientReady = undefined;
            this.#prewarmReady = undefined;
            this.#prewarmedSession = undefined;
            this.#activeSessionId = undefined;
          }
        },
      });
      try {
        client.start();
        await withDeadline(client.initialize(), startupTimeoutMs, 'handshake_timeout');
        this.#processGeneration += 1;
        this.#client = client;
        return client;
      } catch (err) {
        client.dispose();
        throw err;
      } finally {
        if (!this.#client) this.#clientReady = undefined;
      }
    })();
    return this.#clientReady;
  }

  async #prewarm(startupTimeoutMs: number): Promise<void> {
    const client = await this.#ensureClient(startupTimeoutMs);
    if (this.#prewarmedSession?.processGeneration === this.#processGeneration) return;
    const created = await withDeadline(
      client.sessionNew({
        cwd: this.opts.cwd ?? process.cwd(),
        mcpServers: toAcpHttpMcpServers(this.opts.mcpServers ?? []),
      }),
      startupTimeoutMs,
      'session_prewarm_timeout',
    );
    if (created.models?.length) this.#models = created.models;
    this.#prewarmedSession = {
      sessionId: created.sessionId,
      processGeneration: this.#processGeneration,
      models: created.models,
    };
  }

  async #openSession(
    client: AcpClient,
    sessionKey: string,
    startupTimeoutMs: number,
  ): Promise<{
    sessionId: string;
    models?: AcpModelInfo[];
    selectedModel: string | null;
  }> {
    const sessionCwd = this.opts.cwd ?? process.cwd();
    const mcpServers = toAcpHttpMcpServers(this.opts.mcpServers ?? []);
    if (this.#prewarmReady) await this.#prewarmReady;
    const memorySession = this.#sessions.get(sessionKey);
    if (memorySession?.processGeneration === this.#processGeneration) {
      return {
        sessionId: memorySession.sessionId,
        models: this.#models,
        selectedModel: memorySession.selectedModel,
      };
    }

    const stored = this.opts.sessionStore && this.opts.workspaceId
      ? this.opts.sessionStore.get(this.opts.workspaceId, this.opts.agentId, sessionKey)
      : null;
    const persistedId = memorySession?.sessionId
      ?? (stored?.processGeneration === this.#processGeneration ? stored.runtimeSessionId : undefined);
    if (persistedId) {
      try {
        const loaded = await withDeadline(
          client.sessionLoad({ cwd: sessionCwd, sessionId: persistedId, mcpServers }),
          startupTimeoutMs,
          'session_load_timeout',
        );
        const now = new Date().toISOString();
        this.#sessions.set(sessionKey, {
          sessionId: loaded.sessionId,
          processGeneration: this.#processGeneration,
          selectedModel: memorySession?.selectedModel ?? stored?.selectedModel ?? null,
          createdAt: memorySession?.createdAt ?? stored?.createdAt ?? now,
          updatedAt: now,
        });
        this.#persistSession(
          sessionKey,
          loaded.sessionId,
          memorySession?.selectedModel ?? stored?.selectedModel ?? null,
          'active',
        );
        return {
          sessionId: loaded.sessionId,
          models: loaded.models ?? this.#models,
          selectedModel: memorySession?.selectedModel ?? stored?.selectedModel ?? null,
        };
      } catch (err) {
        this.opts.logger.warn('hermes_agent.acp.session_load_failed', {
          sessionKey,
          sessionId: persistedId,
          err: (err as Error).message,
        });
      }
    }

    const prewarmed = this.#prewarmedSession;
    if (prewarmed?.processGeneration === this.#processGeneration) {
      this.#prewarmedSession = undefined;
      const now = new Date().toISOString();
      this.#sessions.set(sessionKey, {
        sessionId: prewarmed.sessionId,
        processGeneration: this.#processGeneration,
        selectedModel: null,
        createdAt: now,
        updatedAt: now,
      });
      this.#persistSession(sessionKey, prewarmed.sessionId, null, 'active');
      return {
        sessionId: prewarmed.sessionId,
        models: prewarmed.models ?? this.#models,
        selectedModel: null,
      };
    }

    const created = await withDeadline(
      client.sessionNew({ cwd: sessionCwd, mcpServers }),
      startupTimeoutMs,
      'session_open_timeout',
    );
    const now = new Date().toISOString();
    this.#sessions.set(sessionKey, {
      sessionId: created.sessionId,
      processGeneration: this.#processGeneration,
      selectedModel: null,
      createdAt: now,
      updatedAt: now,
    });
    this.#persistSession(sessionKey, created.sessionId, null, 'active');
    return { sessionId: created.sessionId, models: created.models, selectedModel: null };
  }

  #persistSession(
    sessionKey: string,
    sessionId: string,
    selectedModel: string | null,
    status: RuntimeSessionInfo['status'],
  ): void {
    const now = new Date().toISOString();
    const existing = this.#sessions.get(sessionKey);
    this.#sessions.set(sessionKey, {
      sessionId,
      processGeneration: this.#processGeneration,
      selectedModel,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (this.opts.sessionStore && this.opts.workspaceId) {
      this.opts.sessionStore.upsert({
        workspaceId: this.opts.workspaceId,
        agentId: this.opts.agentId,
        conversationId: sessionKey,
        sessionKey,
        runtimeSessionId: sessionId,
        processGeneration: this.#processGeneration,
        selectedModel,
        status,
      });
    }
  }

  #invalidateClient(client: AcpClient): void {
    if (this.#client === client) {
      this.#client = undefined;
      this.#clientReady = undefined;
      this.#prewarmReady = undefined;
      this.#prewarmedSession = undefined;
      this.#activeSessionId = undefined;
    }
    client.dispose();
  }

  #emitProgress(task: NormalizedTask, message: string, timestamp: string): void {
    this.#emit({
      eventType: 'task.progress',
      agentId: this.opts.agentId,
      runId: task.runId,
      workflowId: task.workflowId,
      taskId: task.taskId,
      message,
      timestamp,
    });
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.opts.logger.error('hermes_agent.handler_threw', { err: (err as Error).message });
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

/**
 * Map one ACP `session/update` to an Agentis `ChatDelta`, or null to ignore it.
 * The agent's OWN tool calls (it ran them over MCP) surface as live activity —
 * never as executable `tool_call` deltas, so Agentis doesn't re-run them.
 */
interface HermesAcpTurnState {
  sessionKey: string;
  agentId: string;
  thoughtText: string;
  toolLabels: Map<string, string>;
}

function acpUpdateToDelta(update: AcpSessionUpdate, state: HermesAcpTurnState): ChatDelta | null {
  switch (update.sessionUpdate) {
    case 'agent_thought_chunk': {
      const text = textOf(update.content);
      if (!text) return null;
      state.thoughtText += text;
      return runtimeProgressActivity({
        id: `hermes-thought-${state.sessionKey}`,
        runtimeName: 'Hermes',
        text: state.thoughtText,
        reasoning: true,
        agentId: state.agentId,
      });
    }
    case 'agent_message_chunk': {
      const text = textOf(update.content);
      state.thoughtText = '';
      return text ? { type: 'text', delta: text } : null;
    }
    case 'tool_call': {
      const u = update as { toolCallId?: string; title?: string; kind?: string };
      const label = u.title?.trim() || prettyToolName(u.kind) || 'a tool';
      const toolCallId = u.toolCallId ?? randomUUID();
      state.toolLabels.set(toolCallId, label);
      return hermesToolActivity(toolCallId, label, String(update.status ?? 'running'));
    }
    case 'tool_call_update': {
      const u = update as { toolCallId?: string; title?: string; status?: string };
      const toolCallId = u.toolCallId ?? randomUUID();
      const label = u.title?.trim() || state.toolLabels.get(toolCallId) || 'a tool';
      state.toolLabels.set(toolCallId, label);
      return hermesToolActivity(toolCallId, label, u.status ?? 'running');
    }
    default:
      // usage_update / available_commands_update / plan are not operator-facing
      // execution events.
      return null;
  }
}

function hermesToolActivity(toolCallId: string, label: string, rawStatus: string): Extract<ChatDelta, { type: 'activity' }> {
  const status = rawStatus.toLowerCase();
  const failed = /fail|error|cancel/.test(status);
  const completed = failed || /complete|success|done|finished/.test(status);
  return {
    type: 'activity',
    id: `hermes-${toolCallId}`,
    phase: 'tool',
    status: failed ? 'error' : completed ? 'success' : 'running',
    label: failed ? `Failed ${label}` : completed ? `Used ${label}` : `Using ${label}`,
    ...(completed
      ? { completedAt: new Date().toISOString() }
      : { startedAt: new Date().toISOString() }),
  };
}

/**
 * Resolve the operator-configured model name against the model ids the agent
 * advertised in `session/new`. Harnesses namespace ids by provider
 * (`nous:anthropic/claude-opus-4.5`), while Agentis config stores the bare name
 * (`anthropic/claude-opus-4.5`) — so match exact id, then exact display name,
 * then provider-prefixed suffix.
 */
function resolveAcpModelId(requested: string | null | undefined, models: AcpModelInfo[] | undefined): string | null {
  const wanted = requested?.trim();
  if (!wanted || !models?.length) return null;
  const exact = models.find((m) => m.modelId === wanted);
  if (exact) return exact.modelId;
  const byName = models.find((m) => m.name === wanted);
  if (byName) return byName.modelId;
  const bySuffix = models.find((m) => m.modelId.endsWith(`:${wanted}`) || m.modelId.endsWith(`/${wanted}`));
  return bySuffix?.modelId ?? null;
}

function normalizeHermesCliModel(model: string | null | undefined): string | undefined {
  const value = model?.trim();
  if (!value || value === 'hermes-auto' || value === 'hermes-agent-default') return undefined;
  return value;
}

function shouldPrewarmHermesOnConnect(env: Record<string, string> | undefined): boolean {
  const value = env?.AGENTIS_HERMES_PREWARM_ON_CONNECT ?? process.env.AGENTIS_HERMES_PREWARM_ON_CONNECT;
  return value === '1' || value?.toLowerCase() === 'true';
}

function isHermesAcpStartupOrSessionFailure(code: string): boolean {
  return code === 'handshake_timeout'
    || code === 'session_prewarm_timeout'
    || code === 'session_load_timeout'
    || code === 'session_open_timeout'
    || code === 'model_selection_timeout';
}

function boundedTimeout(raw: string | undefined, fallback: number, maximum: number, minimum = 1_000): number {
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(minimum, Math.min(Math.floor(value), maximum));
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${code}: exceeded ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyHermesError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('handshake_timeout')) return 'handshake_timeout';
  if (normalized.includes('session_load_timeout')) return 'session_load_timeout';
  if (normalized.includes('session_open_timeout')) return 'session_open_timeout';
  if (normalized.includes('model_selection_timeout')) return 'model_selection_timeout';
  if (normalized.includes('auth') || normalized.includes('credential') || normalized.includes('api key')) {
    return 'authentication_failed';
  }
  if (normalized.includes('process error') || normalized.includes('exited')) return 'runtime_exited';
  return 'runtime_failed';
}

function textOf(content: unknown): string {
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

function prettyToolName(raw: unknown): string {
  return typeof raw === 'string'
    ? raw.replace(/^mcp__[^_]+__/, '').replace(/[._]/g, ' ').trim()
    : '';
}

/**
 * Flatten the chat history into a single ACP prompt block. Tools come over MCP,
 * so — unlike the old marker path — NO tool catalog or marker instructions are
 * injected; the agent discovers the real tool surface and workspace state by
 * calling the mounted Agentis MCP server.
 */
function formatAcpPrompt(messages: ChatMessage[]): string {
  return messages.map((message) => {
    const content = typeof message.content === 'string' ? message.content : safeJson(message.content);
    if (message.role === 'system') return content;
    if (message.role === 'tool') return `TOOL RESULT (${message.toolCallId ?? 'unknown'}):\n${content}`;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return ['ASSISTANT:', content, 'REQUESTED TOOLS:', safeJson(message.toolCalls)].join('\n');
    }
    return `${message.role.toUpperCase()}:\n${content}`;
  }).join('\n\n');
}

type HermesJsonEvent = {
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

function parseJson(line: string): HermesJsonEvent | null {
  try {
    return JSON.parse(line) as HermesJsonEvent;
  } catch {
    return null;
  }
}

function extractText(event: HermesJsonEvent): string {
  const direct = firstString(event.text, event.content, event.delta);
  if (direct) return direct;
  const message = objectOf(event.message);
  const messageText = firstString(message?.text, message?.content);
  if (messageText) return messageText;
  const item = objectOf(event.item);
  return firstString(item?.text, item?.content) ?? '';
}

function extractToolCall(event: HermesJsonEvent): { tool: string; input: unknown } | null {
  const type = String(event.type ?? '').toLowerCase();
  if (!type.includes('tool') && !type.includes('function')) return null;
  const item = objectOf(event.item);
  const tool = firstString(event.name, event.tool, item?.name, item?.tool) ?? 'tool';
  return { tool, input: event.input ?? event.arguments ?? item?.input ?? item?.arguments ?? {} };
}

function isCompletionEvent(event: HermesJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  return type === 'result' || type === 'done' || type.includes('completed') || type.includes('finished');
}

function extractOutput(event: HermesJsonEvent, transcript: string): Record<string, unknown> {
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
