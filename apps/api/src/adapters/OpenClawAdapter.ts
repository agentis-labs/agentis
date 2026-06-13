/**
 * OpenClawAdapter — bridge to OpenClaw Gateway over WebSocket.
 *
 * Inbound:
 *   agent.heartbeat              → updates lastHeartbeatAt
 *   session.message              → CONVERSATION_MESSAGE_RECEIVED + mirror to conversation_messages
 *   session.tool                 → AGENT_TERMINAL_TOOL_CALL
 *   exec.approval.requested      → ApprovalInbox.create(source='openclaw_exec')
 *   agent.status.changed         → AGENT_STATUS event + DB update
 *   task.completed / task.failed → engine.notifyTaskCompleted / notifyTaskFailed
 *
 * Outbound:
 *   dispatchTask  → ws send {kind:'task.dispatch', task}
 *   cancelTask    → ws send {kind:'task.cancel', taskId}
 *   sendMessage   → ws send {kind:'session.send', sessionId?, body}
 *
 * The connection is wrapped in a CircuitBreaker. Three consecutive send/recv
 * failures open the breaker for 30s; the gateway surfaces this in its
 * health snapshot.
 */

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
  TriggerConfig,
  TriggerListenerHandle,
  RuntimeContext,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { clampChatTimeout, createChatQueue, DEFAULT_CHAT_TURN_TIMEOUT_MS } from './cliChatRuntime.js';

/**
 * A single in-flight chat turn's view of the gateway's async event stream.
 * OpenClaw doesn't answer a request synchronously — its reply arrives later as a
 * `session.message`. A turn registers one of these so {@link OpenClawAdapter.chat}
 * can stream live thinking and resolve on the agent's reply (or time out).
 */
interface OpenClawChatListener {
  onThinking(text: string): void;
  onAgentMessage(body: string): void;
  onError(message: string): void;
}

interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: Buffer | string) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

interface WebSocketCtor {
  new (url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }): WebSocketLike;
  readonly OPEN: number;
}

let cachedWS: { kind: 'available'; WS: WebSocketCtor } | { kind: 'unavailable'; reason: string } | undefined;
async function loadWs() {
  if (cachedWS) return cachedWS;
  try {
    const mod = (await import('ws' as string)) as { WebSocket: WebSocketCtor; default?: WebSocketCtor };
    const WS = (mod.WebSocket ?? mod.default) as WebSocketCtor;
    cachedWS = { kind: 'available', WS };
  } catch (err) {
    cachedWS = { kind: 'unavailable', reason: (err as Error).message };
  }
  return cachedWS;
}

export interface OpenClawAdapterOptions {
  agentId: string;
  gatewayUrl: string;
  /** Decrypted device token. NEVER persisted in plaintext. */
  deviceToken?: string;
  headers?: Record<string, string>;
  password?: string;
  agentName?: string;
  sessionKeyStrategy?: 'issue' | 'fixed' | 'run';
  sessionKey?: string;
  disableDeviceAuth?: boolean;
  timeoutSec?: number;
  payloadTemplate?: Record<string, unknown>;
  /** Optional: the gateway-side session id to bind to (for mirrored conversations). */
  defaultSessionId?: string;
  logger: Logger;
}

export class OpenClawAdapter implements AgentAdapter {
  readonly adapterType = 'openclaw' as const;
  readonly #handlers = new Set<(e: NormalizedAgentEvent) => void>();
  readonly #chatListeners = new Set<OpenClawChatListener>();
  readonly #breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });
  #ws: WebSocketLike | undefined;
  #closed = false;

  constructor(private readonly opts: OpenClawAdapterOptions) {}

  async connect(): Promise<void> {
    const loaded = await loadWs();
    if (loaded.kind === 'unavailable') {
      this.opts.logger.warn('openclaw.ws_unavailable', { reason: loaded.reason });
      return;
    }
    const { WS } = loaded;
    this.#ws = new WS(this.opts.gatewayUrl, undefined, {
      headers: this.#authHeaders(),
    });
    this.#ws.on('open', () => this.opts.logger.info('openclaw.ws_open', { agentId: this.opts.agentId }));
    this.#ws.on('message', (raw) => this.#handleMessage(typeof raw === 'string' ? raw : raw.toString('utf8')));
    this.#ws.on('close', () => {
      this.opts.logger.warn('openclaw.ws_close', { agentId: this.opts.agentId });
      if (!this.#closed) {
          this.#emit({
            eventType: 'agent.heartbeat',
            agentId: this.opts.agentId,
            connected: false,
            timestamp: new Date().toISOString(),
          });
        }
    });
    this.#ws.on('error', (err) => {
      this.opts.logger.error('openclaw.ws_error', { agentId: this.opts.agentId, err: err.message });
    });
  }

  async disconnect(): Promise<void> {
    this.#closed = true;
    this.#ws?.close();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    return {
      isHealthy: this.#ws?.readyState === 1 && this.#breaker.state() !== 'open',
      checkedAt: new Date().toISOString(),
      ...(this.#breaker.state() === 'open' ? { error: 'circuit_breaker_open' } : {}),
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true,
      // The gateway agent runs its OWN tool loop remotely; Agentis relays the
      // operator's message and streams the reply rather than executing tools here.
      toolCalling: false,
      toolForwarding: 'session_event',
      execution: {
        longRunning: true,
        pausable: true,
        sandbox: 'none',
      },
      affordances: {
        browser: true,
        computerUse: true,
        terminal: true,
      },
      memory: {
        injectable: true,
      },
      limitations: [
        'OpenClaw chats through its gateway session; Agentis platform tools run on the gateway agent, not in the local chat tool loop.',
      ],
    };
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    return {
      provider: 'openclaw',
      models: [{ id: 'openclaw-gateway', label: 'OpenClaw Gateway' }],
      currentModel: 'openclaw-gateway',
      fastModeSupported: false,
    };
  }

  async createPersistentListener(trigger: TriggerConfig): Promise<TriggerListenerHandle> {
    // Persistent listeners share the same WS — we simply tag inbound events
    // with the workflowId at the AdapterManager layer. Closing the handle
    // is a no-op because closing would terminate the agent itself.
    return {
      triggerId: trigger.triggerId,
      startedAt: new Date().toISOString(),
      close: async () => {},
    };
  }

  onEvent(handler: (e: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    await this.#breaker.exec(async () => {
      this.#sendOrThrow({
        ...(this.opts.payloadTemplate ?? {}),
        kind: 'task.dispatch',
        task,
        ...(this.opts.agentName ? { agentName: this.opts.agentName } : {}),
        sessionKey: this.#sessionKeyFor(task),
      });
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    try {
      await this.#breaker.exec(async () => {
        this.#sendOrThrow({ kind: 'task.cancel', taskId });
      });
    } catch {
      // best-effort
    }
  }

  /** Send an operator message into a mirrored session. */
  async sendSessionMessage(args: { sessionId?: string; body: string }): Promise<void> {
    await this.#breaker.exec(async () => {
      this.#sendOrThrow({
        kind: 'session.send',
        sessionId: args.sessionId ?? this.opts.defaultSessionId,
        body: args.body,
      });
    });
  }

  breakerState() {
    return this.#breaker.state();
  }

  /**
   * Interactive chat over the mirrored gateway session. Unlike the CLI adapters,
   * OpenClaw has no synchronous response: we relay the operator's latest message
   * and stream the gateway's async reply (live `agent.thinking` → ThinkingBubble,
   * the agent's `session.message` → the answer) until it replies or times out.
   * Agentis tools are not executed here — the gateway agent owns its own loop.
   */
  async *chat(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user') ?? messages.at(-1);
    const body = typeof lastUser?.content === 'string' ? lastUser.content : String(lastUser?.content ?? '');
    const queue = createChatQueue();
    const timeoutMs = clampChatTimeout(
      this.opts.timeoutSec && this.opts.timeoutSec > 0 ? this.opts.timeoutSec * 1000 : DEFAULT_CHAT_TURN_TIMEOUT_MS,
    );

    let settled = false;
    const listener: OpenClawChatListener = {
      onThinking: (text) => {
        if (settled || !text) return;
        queue.push({ type: 'thinking', delta: text });
      },
      onAgentMessage: (replyBody) => {
        if (settled || !replyBody.trim()) return;
        settle();
        queue.push({ type: 'text', delta: replyBody });
        queue.push({ type: 'done', finishReason: 'stop' });
        queue.close();
      },
      onError: (message) => {
        if (settled) return;
        settle();
        queue.push({ type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: message });
        queue.push({ type: 'done', finishReason: 'error' });
        queue.close();
      },
    };
    const timer = setTimeout(
      () => listener.onError(`OpenClaw did not reply within ${Math.round(timeoutMs / 1000)}s`),
      timeoutMs,
    );
    timer.unref?.();
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      this.#chatListeners.delete(listener);
    };
    const onAbort = () => listener.onError('OpenClaw request was canceled');
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    this.#chatListeners.add(listener);
    try {
      await this.sendSessionMessage({ sessionId: this.opts.defaultSessionId, body });
    } catch (err) {
      listener.onError(`OpenClaw send failed: ${(err as Error).message}`);
    }

    try {
      yield* queue.iterate();
    } finally {
      settle();
      options?.signal?.removeEventListener('abort', onAbort);
    }
  }

  // ─────────────────────────────────────────────

  #notifyChatListeners(fn: (listener: OpenClawChatListener) => void): void {
    for (const listener of this.#chatListeners) {
      try {
        fn(listener);
      } catch (err) {
        this.opts.logger.warn('openclaw.chat_listener_threw', { err: (err as Error).message });
      }
    }
  }

  #sendOrThrow(payload: unknown): void {
    if (!this.#ws || this.#ws.readyState !== 1 /* OPEN */) {
      throw new Error('openclaw_ws_not_open');
    }
    this.#ws.send(JSON.stringify(payload));
  }

  #handleMessage(text: string): void {
    let msg: { kind: string; [k: string]: unknown };
    try {
      msg = JSON.parse(text) as { kind: string; [k: string]: unknown };
    } catch {
      this.opts.logger.warn('openclaw.bad_json', { agentId: this.opts.agentId });
      return;
    }
    const at = new Date().toISOString();
    switch (msg.kind) {
      case 'agent.heartbeat':
        this.#emit({
          eventType: 'agent.heartbeat',
          agentId: this.opts.agentId,
          connected: true,
          timestamp: at,
        });
        return;
      case 'connect.challenge':
        this.#sendConnectResponse(msg);
        return;
      case 'agent.thinking':
        this.#emit({
          eventType: 'agent.thinking',
          agentId: this.opts.agentId,
          runId: String(msg.runId ?? ''),
          workflowId: String(msg.workflowId ?? ''),
          taskId: String(msg.taskId ?? ''),
          text: String(msg.text ?? ''),
          timestamp: at,
        });
        this.#notifyChatListeners((l) => l.onThinking(String(msg.text ?? '')));
        return;
      case 'agent.tool_call':
      case 'session.tool':
        this.#emit({
          eventType: 'agent.tool_call',
          agentId: this.opts.agentId,
          runId: String(msg.runId ?? ''),
          workflowId: String(msg.workflowId ?? ''),
          taskId: String(msg.taskId ?? ''),
          tool: String(msg.tool ?? ''),
          input: msg.args ?? {},
          result: msg.result,
          timestamp: at,
        });
        return;
      case 'task.completed':
        this.#emit({
          eventType: 'task.completed',
          agentId: this.opts.agentId,
          runId: String(msg.runId ?? ''),
          workflowId: String(msg.workflowId ?? ''),
          taskId: String(msg.taskId ?? ''),
          output: (msg.output as Record<string, unknown>) ?? {},
          timestamp: at,
        });
        return;
      case 'task.failed':
        this.#emit({
          eventType: 'task.failed',
          agentId: this.opts.agentId,
          runId: String(msg.runId ?? ''),
          workflowId: String(msg.workflowId ?? ''),
          taskId: String(msg.taskId ?? ''),
          error: String(msg.error ?? 'agent task failed'),
          timestamp: at,
        });
        this.#notifyChatListeners((l) => l.onError(String(msg.error ?? 'OpenClaw agent task failed')));
        return;
      case 'session.message': {
        const authorType = String(msg.authorType ?? 'agent') as 'agent' | 'operator' | 'system';
        this.#emit({
          eventType: 'agent.session_message',
          agentId: this.opts.agentId,
          sessionId: String(msg.sessionId ?? ''),
          sessionMessageId: String(msg.id ?? ''),
          authorType,
          body: String(msg.body ?? ''),
          timestamp: at,
        });
        // The agent's reply resolves the in-flight chat turn (ignore the echo of
        // the operator's own message and any system notices).
        if (authorType === 'agent') {
          this.#notifyChatListeners((l) => l.onAgentMessage(String(msg.body ?? '')));
        }
        return;
      }
      case 'exec.approval.requested':
        this.#emit({
          eventType: 'agent.approval_requested',
          agentId: this.opts.agentId,
          ...(msg.runId ? { runId: String(msg.runId) } : {}),
          ...(msg.taskId ? { taskId: String(msg.taskId) } : {}),
          title: String(msg.title ?? 'OpenClaw exec approval'),
          summary: String(msg.summary ?? ''),
          command: msg.command,
          timestamp: at,
        });
        return;
      case 'agent.status.changed':
        this.#emit({
          eventType: 'agent.status',
          agentId: this.opts.agentId,
          status: (String(msg.status ?? 'offline') as 'online' | 'busy' | 'offline' | 'error'),
          timestamp: at,
        });
        return;
      default:
        this.opts.logger.debug?.('openclaw.unhandled_kind', { kind: msg.kind });
    }
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const h of this.#handlers) {
      try {
        h(event);
      } catch (err) {
        this.opts.logger.error('openclaw.handler_threw', { err: (err as Error).message });
      }
    }
  }

  #authHeaders(): Record<string, string> {
    return {
      ...(this.opts.headers ?? {}),
      ...(this.opts.deviceToken ? { authorization: `Bearer ${this.opts.deviceToken}`, 'x-openclaw-token': this.opts.deviceToken } : {}),
      ...(this.opts.password ? { 'x-openclaw-password': this.opts.password } : {}),
    };
  }

  #sessionKeyFor(task: NormalizedTask): string {
    if (this.opts.sessionKeyStrategy === 'fixed' && this.opts.sessionKey) return this.opts.sessionKey;
    if (this.opts.sessionKeyStrategy === 'run') return `agentis-run-${task.runId}`;
    const issueId = typeof task.inputData.issueId === 'string' ? task.inputData.issueId : task.runId;
    return `agentis-issue-${issueId}`;
  }

  #sendConnectResponse(challenge: Record<string, unknown>): void {
    try {
      this.#sendOrThrow({
        kind: 'req.connect',
        clientId: `agentis-${this.opts.agentId}`,
        role: 'operator',
        scopes: ['agent:request', 'session:read', 'session:write'],
        challenge: challenge.challenge,
        device: this.opts.disableDeviceAuth ? null : { mode: 'ephemeral' },
      });
    } catch (err) {
      this.opts.logger.warn('openclaw.connect_response_failed', { agentId: this.opts.agentId, err: (err as Error).message });
    }
  }
}
