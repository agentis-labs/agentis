/**
 * HermesAdapter — first-class OpenAI-compatible chat adapter for Hermes models.
 *
 * Hermes is not routed through a generic HTTP adapter because operators expect
 * a named platform with live token streaming, model configuration, and branded
 * fleet visibility. This adapter speaks the common /v1/chat/completions stream
 * protocol used by vLLM and hosted Nous/Hermes endpoints. Local OpenAI-compatible
 * LM Studio, and llama.cpp endpoints use LocalLlmAdapter, which shares this
 * stream implementation but validates for local/private URLs instead of
 * requiring AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE.
 */

import { promises as dns } from 'node:dns';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterHealthStatus,
  NormalizedAgentEvent,
  NormalizedTask,
  ChatMessage,
  ChatDelta,
  ChatInvocationOptions,
  ToolDefinition,
  RuntimeContext,
} from '@agentis/core';
import { AgentisError, CONSTANTS } from '@agentis/core';
import type { Logger } from '../logger.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { assertSafeUrl } from '../services/safeUrl.js';
import { linkAbortSignal } from './abort.js';

export type OpenAiCompatibleAdapterType = 'local_llm';

export interface HermesAdapterOptions {
  agentId: string;
  baseUrl: string;
  model: string;
  adapterType?: OpenAiCompatibleAdapterType;
  networkAccess?: 'public' | 'local';
  apiKey?: string;
  maxTokens?: number;
  /**
   * Idle watchdog for {@link HermesAdapter.chat}: abort the streaming request
   * when no bytes have arrived for this many ms (resets on every chunk, so long
   * legitimate generations are never cut). Falls back to
   * `AGENTIS_CHAT_STREAM_TIMEOUT_MS`, then `CONVERSATION_AGENT_RESPONSE_TIMEOUT_MS`.
   */
  chatTimeoutMs?: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  telemetry?: import('../telemetry/index.js').Telemetry;
}

export class HermesAdapter implements AgentAdapter {
  readonly adapterType: OpenAiCompatibleAdapterType;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  readonly #breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });
  readonly #fetch: typeof fetch;

  constructor(private readonly opts: HermesAdapterOptions) {
    this.adapterType = opts.adapterType ?? 'local_llm';
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    return {
      isHealthy: this.#breaker.state() !== 'open',
      checkedAt: new Date().toISOString(),
      ...(this.#breaker.state() === 'open' ? { error: 'circuit_breaker_open' } : {}),
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'native',
      execution: {
        longRunning: false,
        pausable: false,
        sandbox: 'none',
      },
      affordances: {},
      memory: {
        injectable: true,
      },
    };
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    const currentModel = this.opts.model ?? 'hermes-default';
    return {
      provider: this.adapterType,
      models: [{ id: currentModel, label: currentModel }],
      currentModel,
      fastModeSupported: false,
    };
  }

  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(task.signal, controller);
    this.#inFlight.set(task.taskId, controller);
    this.#emit({
      eventType: 'task.started',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      timestamp: new Date().toISOString(),
    });
    void this.#runTask(task, controller).catch((err) => {
      if (controller.signal.aborted) return;
      this.#emitFailure(task, `hermes_dispatch_failed: ${(err as Error).message}`);
    }).finally(() => {
      unlinkAbort();
      this.#inFlight.delete(task.taskId);
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort();
    this.#inFlight.delete(taskId);
  }

  breakerState() {
    return this.#breaker.state();
  }

  /**
   * Agentic chat loop entry point — CHAT-AGENT-LOOP.md §4.1.
   *
   * Sends `messages` + `tools` to the OpenAI-compatible endpoint with
   * `stream: true` and yields `ChatDelta` events as they arrive.
   * The caller (ChatSessionExecutor) drives the turn loop — this method
   * handles a single LLM call and returns when `finish_reason` is emitted.
   */
  async *chat(messages: ChatMessage[], tools: ToolDefinition[], options?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    const rawEndpoint = resolveChatCompletionsUrl(this.opts.baseUrl);
    const endpoint = this.opts.networkAccess === 'local'
      ? await assertLocalModelUrl(rawEndpoint)
      : await assertSafeUrl(rawEndpoint, {
          allowPrivate: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
        });

    // A hung or silently-stalled endpoint must never become a chat turn that
    // never finishes. We arm an *idle* watchdog: if no bytes arrive within
    // `idleMs` — whether waiting for the first token or mid-stream — the request
    // is aborted and surfaced as an error `done` so the caller reports it instead
    // of streaming forever. The watchdog resets on every chunk, so a long but
    // live generation is never cut. Registered in `#inFlight` so `disconnect()`
    // cancels it too. Idle aborts propagate through `#breaker`, so a repeatedly
    // dead endpoint trips the circuit and fast-fails instead of hanging each call.
    const idleMs = resolveChatIdleTimeoutMs(this.opts.chatTimeoutMs);
    const controller = new AbortController();
    // Honor an external cancel (e.g. the operator closed the chat stream): fold it
    // into this call's controller so the in-flight model request is aborted, not
    // just timed out. Idempotent with the idle watchdog — first abort wins.
    const externalSignal = options?.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const callId = `chat_${randomUUID()}`;
    this.#inFlight.set(callId, controller);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, idleMs);
      timer.unref?.();
    };

    try {
      armWatchdog();
      let response: Response;
      try {
        response = await this.#breaker.exec(() => this.#fetch(endpoint.toString(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream, application/json',
            'user-agent': this.adapterType === 'local_llm' ? 'Agentis/1.0 (LocalLlmAdapter/chat)' : 'Agentis/1.0 (HermesAdapter/chat)',
            ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.opts.model,
            stream: true,
            messages: toChatML(messages),
            ...(tools.length > 0
              ? {
                  tools: tools.map((t) => ({
                    type: 'function',
                    function: { name: t.name, description: formatToolDescription(t), parameters: t.parameters },
                  })),
                  tool_choice: 'auto',
                }
              : {}),
            ...((options?.maxTokens ?? this.opts.maxTokens)
              ? { max_tokens: options?.maxTokens ?? this.opts.maxTokens }
              : {}),
          }),
          signal: controller.signal,
        }));
      } catch (err) {
        yield { type: 'done', finishReason: 'error' };
        throw timedOut
          ? new Error(`HermesAdapter.chat: model did not respond within ${idleMs}ms`)
          : err;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        yield { type: 'done', finishReason: 'error' };
        throw new Error(`HermesAdapter.chat: status=${response.status} ${body.slice(0, 256)}`.trim());
      }

      try {
        yield* this.#streamChatDeltas(response, armWatchdog);
      } catch (err) {
        yield { type: 'done', finishReason: 'error' };
        throw timedOut
          ? new Error(`HermesAdapter.chat: stream stalled — no data for ${idleMs}ms`)
          : err;
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      this.#inFlight.delete(callId);
    }
  }

  async *#streamChatDeltas(response: Response, keepAlive?: () => void): AsyncIterable<ChatDelta> {
    const contentType = response.headers.get('content-type') ?? '';

    // Non-streaming fallback — model returned JSON directly
    if (contentType.includes('application/json')) {
      const json = await response.json() as OpenAiCompatibleResponse;
      const choice = json.choices?.[0];
      const text = extractResponseText(json);
      if (text) yield { type: 'text', delta: text };
      const rawCalls = (choice?.message as Record<string, unknown> | undefined)?.tool_calls;
      const calls = extractToolCallsFull(rawCalls);
      for (const tc of calls) {
        yield { type: 'tool_call', id: tc.id, name: tc.name, args: tc.arguments };
      }
      const fr = choice?.finish_reason;
      // Diagnostic: a turn that ends with no text AND no tool call is the
      // "blank reply" failure mode — log enough to tell a reasoning-only stop
      // (sawText=false, finish_reason=stop) from a truncation (finish_reason=length).
      this.opts.logger?.debug?.('hermes.chat.done', {
        model: this.opts.model, mode: 'json', finishReason: fr ?? null,
        sawText: Boolean(text), toolCalls: calls.length,
      });
      yield { type: 'done', finishReason: mapFinishReason(fr) };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    // Accumulate streaming tool call argument fragments by index
    const pendingToolCalls = new Map<number, { id: string; name: string; argStr: string }>();
    let finishReason: string | null = null;
    // Track what the stream actually surfaced so the turn loop / logs can tell a
    // reasoning-only stop apart from a real empty turn.
    let sawText = false;
    let sawReasoning = false;

    outer: while (true) {
      const { value, done } = await reader.read();
      // Bytes arrived (or the stream ended) — reset the idle watchdog.
      keepAlive?.();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let sepIdx: number;
      while ((sepIdx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + (buffer[sepIdx] === '\r' ? 4 : 2));

        for (const line of block.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') break outer;

          let json: OpenAiCompatibleResponse;
          try {
            json = JSON.parse(data) as OpenAiCompatibleResponse;
          } catch {
            continue;
          }

          const choice = json.choices?.[0];
          const delta = choice?.delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          // Streaming text content
          const text = firstString(delta.content);
          if (text) { sawText = true; yield { type: 'text', delta: text }; }

          // Chain-of-thought / reasoning
          const reasoning = firstString(delta.reasoning_content);
          if (reasoning) { sawReasoning = true; yield { type: 'thinking', delta: reasoning }; }

          // Streaming tool call arguments (fragmented across chunks)
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
              const idx = (tc.index as number) ?? 0;
              if (!pendingToolCalls.has(idx)) {
                pendingToolCalls.set(idx, {
                  id: String(tc.id ?? `tc_${idx}`),
                  name: '',
                  argStr: '',
                });
              }
              const pending = pendingToolCalls.get(idx)!;
              if (tc.id) pending.id = String(tc.id);
              const fn = tc.function as Record<string, unknown> | undefined;
              if (fn?.name) pending.name = String(fn.name);
              if (fn?.arguments) pending.argStr += String(fn.arguments);
            }
          }

          const fr = choice?.finish_reason;
          if (fr) finishReason = fr;
        }
      }

      if (done) break;
    }

    // Emit completed tool calls now that all argument fragments have been received
    for (const [, tc] of pendingToolCalls) {
      let args: unknown;
      try {
        args = JSON.parse(tc.argStr);
      } catch {
        args = tc.argStr;
      }
      yield { type: 'tool_call', id: tc.id, name: tc.name, args };
    }

    this.opts.logger?.debug?.('hermes.chat.done', {
      model: this.opts.model, mode: 'stream', finishReason,
      sawText, sawReasoning, toolCalls: pendingToolCalls.size,
    });
    yield {
      type: 'done',
      finishReason: mapFinishReason(finishReason),
    };
  }

  async #runTask(task: NormalizedTask, controller: AbortController): Promise<void> {
    const rawEndpoint = resolveChatCompletionsUrl(this.opts.baseUrl);
    const endpoint = this.opts.networkAccess === 'local'
      ? await assertLocalModelUrl(rawEndpoint)
      : await assertSafeUrl(rawEndpoint, {
          allowPrivate: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
        });
    await this.#breaker.exec(async () => {
      const timeout = setTimeout(() => controller.abort(), task.timeoutMs || CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS).unref?.();
      try {
        const response = await this.#fetch(endpoint.toString(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream, application/json',
            'user-agent': this.adapterType === 'local_llm' ? 'Agentis/1.0 (LocalLlmAdapter)' : 'Agentis/1.0 (HermesAdapter)',
            ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.opts.model,
            stream: true,
            messages: [
              {
                role: 'system',
                content: `You are a Hermes agent operating inside Agentis. Complete the task, report useful progress, and return concrete artifacts when available.\n\n${task.description}`,
              },
              { role: 'user', content: buildHermesPrompt(task) },
            ],
            ...(this.opts.maxTokens ? { max_tokens: this.opts.maxTokens } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`status=${response.status} ${body.slice(0, 256)}`.trim());
        }
        const output = await readOpenAiCompatibleStream(response, (delta) => this.#handleDelta(task, delta));
        if (controller.signal.aborted) return;
        this.#emit({
          eventType: 'task.completed',
          agentId: this.opts.agentId,
          runId: task.runId,
          workflowId: task.workflowId,
          taskId: task.taskId,
          output,
          timestamp: new Date().toISOString(),
        });
        
        if (this.opts.telemetry?.emitLlmTrace) {
          const usage = output.usage as any ?? {};
          const promptTokens = usage.prompt_tokens ?? 0;
          const completionTokens = usage.completion_tokens ?? 0;
          const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
          this.opts.telemetry.emitLlmTrace({
            traceId: task.runId || task.taskId,
            nodeId: task.taskId,
            metrics: {
              promptTokens,
              completionTokens,
              cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
              totalTokens,
              totalCostMicros: 0, // Cost engine integration would calculate this based on model
              latencyMs: 0, // Latency would be calculated based on start/end time
            },
            contextStrategy: {
              windowLimit: 128000,
              blocks: [
                { source: 'system', tokenCount: promptTokens > 0 ? 400 : 0, wasTruncated: false, truncatedTokens: 0 },
                { source: 'user', tokenCount: promptTokens > 400 ? promptTokens - 400 : 0, wasTruncated: false, truncatedTokens: 0 }
              ]
            },
            payloads: {
              rawPrompt: {
                model: this.opts.model,
                messages: [
                  { role: 'system', content: 'You are a Hermes agent operating inside Agentis...' },
                  { role: 'user', content: buildHermesPrompt(task) }
                ]
              },
              rawCompletion: typeof output.text === 'string' ? output.text : undefined,
              toolCalls: [],
            }
          });
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });
  }

  #handleDelta(task: NormalizedTask, delta: HermesStreamDelta): void {
    if (delta.text) {
      this.#emit({
        eventType: 'task.progress',
        agentId: this.opts.agentId,
        taskId: task.taskId,
        runId: task.runId,
        workflowId: task.workflowId,
        message: delta.text,
        timestamp: new Date().toISOString(),
      });
    }
    if (delta.reasoning) {
      this.#emit({
        eventType: 'agent.thinking',
        agentId: this.opts.agentId,
        taskId: task.taskId,
        runId: task.runId,
        workflowId: task.workflowId,
        text: delta.reasoning,
        timestamp: new Date().toISOString(),
      });
    }
    for (const toolCall of delta.toolCalls) {
      this.#emit({
        eventType: 'agent.tool_call',
        agentId: this.opts.agentId,
        taskId: task.taskId,
        runId: task.runId,
        workflowId: task.workflowId,
        tool: toolCall.name,
        input: toolCall.arguments,
        timestamp: new Date().toISOString(),
      });
    }
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.opts.logger.error('hermes.handler_threw', { err: (err as Error).message });
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

interface HermesStreamDelta {
  text: string;
  reasoning: string;
  toolCalls: Array<{ name: string; arguments: unknown }>;
}

/**
 * Idle-timeout budget (ms) for the streaming chat watchdog. Precedence:
 * explicit option → `AGENTIS_CHAT_STREAM_TIMEOUT_MS` env → the platform's
 * conversation response timeout. Non-positive/garbage values are ignored so a
 * misconfigured env can never disable the watchdog.
 */
function resolveChatIdleTimeoutMs(optionMs?: number): number {
  if (typeof optionMs === 'number' && optionMs > 0) return optionMs;
  const fromEnv = Number(process.env.AGENTIS_CHAT_STREAM_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return CONSTANTS.CONVERSATION_AGENT_RESPONSE_TIMEOUT_MS;
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('hermes requires baseUrl');
  if (trimmed.endsWith('/v1/chat/completions')) return trimmed;
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

const PRIVATE_V4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0a000000, 0x0affffff],
  [0xac100000, 0xac1fffff],
  [0xc0a80000, 0xc0a8ffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0x00000000, 0x00ffffff],
  [0x64400000, 0x647fffff],
];

async function assertLocalModelUrl(raw: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AgentisError('VALIDATION_FAILED', `Invalid local model URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AgentisError('EXTENSION_NETWORK_VIOLATION', 'Local model endpoints must use http(s)');
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return parsed;
  const literal = net.isIP(host);
  if (literal) {
    if (isPrivateAddress(host)) return parsed;
    throw new AgentisError('EXTENSION_NETWORK_VIOLATION', `Local model endpoint must be localhost or a private network address; got ${host}`);
  }
  let addresses: string[];
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    addresses = records.map((record) => record.address);
  } catch (err) {
    throw new AgentisError('EXTENSION_NETWORK_VIOLATION', `Could not resolve local model host ${host}: ${(err as Error).message}`);
  }
  if (addresses.length > 0 && addresses.every(isPrivateAddress)) return parsed;
  throw new AgentisError('EXTENSION_NETWORK_VIOLATION', `Local model endpoint ${host} must resolve only to localhost or private network addresses`);
}

function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return n != null && PRIVATE_V4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    n = (n * 256 + value) >>> 0;
  }
  return n >>> 0;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80:')) return true;
  const mapped = lower.match(/^::ffff:([\d.]+)$/);
  return Boolean(mapped?.[1] && isPrivateIPv4(mapped[1]));
}

function buildHermesPrompt(task: NormalizedTask): string {
  return [
    `Task: ${task.title}`,
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

async function readOpenAiCompatibleStream(
  response: Response,
  onDelta: (delta: HermesStreamDelta) => void,
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const json = await response.json() as OpenAiCompatibleResponse;
    const text = extractResponseText(json);
    if (text) onDelta({ text, reasoning: '', toolCalls: [] });
    return { text, model: json.model, usage: json.usage ?? null };
  }
  const reader = response.body?.getReader();
  if (!reader) return { text: '' };
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason: string | null = null;
  let usage: unknown;
  while (true) {
    const read = await reader.read();
    buffer += decoder.decode(read.value ?? new Uint8Array(), { stream: !read.done });
    let separatorIndex: number;
    while ((separatorIndex = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + (buffer[separatorIndex] === '\r' ? 4 : 2));
      const parsed = processStreamBlock(block);
      if (!parsed) continue;
      if (parsed.done) return { text: text.trim(), finishReason, usage };
      text += parsed.delta.text;
      finishReason = parsed.finishReason ?? finishReason;
      usage = parsed.usage ?? usage;
      onDelta(parsed.delta);
    }
    if (read.done) break;
  }
  const parsed = processStreamBlock(buffer);
  if (parsed && !parsed.done) {
    text += parsed.delta.text;
    finishReason = parsed.finishReason ?? finishReason;
    usage = parsed.usage ?? usage;
    onDelta(parsed.delta);
  }
  return { text: text.trim(), finishReason, usage };
}

function processStreamBlock(block: string): { done: boolean; delta: HermesStreamDelta; finishReason?: string | null; usage?: unknown } | null {
  const trimmed = block.trim();
  if (!trimmed) return null;
  const dataLines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const payloads = dataLines.length > 0 ? dataLines : [trimmed];
  let combinedDelta: HermesStreamDelta = { text: '', reasoning: '', toolCalls: [] };
  let finishReason: string | null | undefined;
  let usage: unknown;
  for (const payload of payloads) {
    if (payload === '[DONE]') return { done: true, delta: combinedDelta, finishReason, usage };
    const json = JSON.parse(payload) as OpenAiCompatibleResponse;
    const chunk = extractChunkDelta(json);
    combinedDelta = {
      text: combinedDelta.text + chunk.text,
      reasoning: combinedDelta.reasoning + chunk.reasoning,
      toolCalls: [...combinedDelta.toolCalls, ...chunk.toolCalls],
    };
    finishReason = json.choices?.[0]?.finish_reason ?? finishReason;
    usage = json.usage ?? usage;
  }
  return { done: false, delta: combinedDelta, finishReason, usage };
}

interface OpenAiCompatibleResponse {
  model?: string;
  usage?: unknown;
  choices?: Array<{
    text?: string;
    finish_reason?: string | null;
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
  }>;
}

function extractResponseText(json: OpenAiCompatibleResponse): string {
  const choice = json.choices?.[0];
  return firstString(choice?.message?.content, choice?.text) ?? '';
}

/**
 * Map the provider's OpenAI-style `finish_reason` onto the platform's ChatDelta
 * terminal reasons. `length` (output-token ceiling hit) is preserved distinctly
 * so the turn loop can recover a truncated/reasoning-starved turn rather than
 * mistaking it for a clean empty stop. Everything unrecognized collapses to stop.
 */
function mapFinishReason(fr: string | null | undefined): 'stop' | 'tool_calls' | 'length' {
  if (fr === 'tool_calls') return 'tool_calls';
  if (fr === 'length') return 'length';
  return 'stop';
}

function extractChunkDelta(json: OpenAiCompatibleResponse): HermesStreamDelta {
  const choice = json.choices?.[0];
  const delta = choice?.delta ?? choice?.message;
  return {
    text: firstString(delta?.content, choice?.text) ?? '',
    reasoning: firstString(delta?.reasoning_content) ?? '',
    toolCalls: extractToolCalls(delta?.tool_calls),
  };
}

function extractToolCalls(value: unknown): Array<{ name: string; arguments: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const object = objectOf(item);
    const fn = objectOf(object?.function);
    return {
      name: firstString(fn?.name, object?.name, object?.type) ?? 'tool',
      arguments: fn?.arguments ?? object?.arguments ?? object?.input ?? {},
    };
  });
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

/**
 * Convert `ChatMessage[]` to OpenAI-compatible `messages` array.
 * Handles the `tool` role (tool_call_id → tool_call_id) and `assistant`
 * messages with pending tool calls.
 */
function toChatML(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: typeof m.content === 'string' ? (m.content || null) : null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    const content = Array.isArray(m.content)
      ? m.content.map((block) => {
          if (block.type === 'text') return { type: 'text', text: block.text };
          return block;
        })
      : m.content;
    return { role: m.role, content };
  });
}

/**
 * Extract fully-assembled tool calls from a non-streaming response message.
 * The streaming path accumulates fragments differently; this handles the
 * `content-type: application/json` non-streaming fallback.
 */
function extractToolCallsFull(
  value: unknown,
): Array<{ id: string; name: string; arguments: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const obj = objectOf(item);
    const fn = objectOf(obj?.function);
    const rawArgs = fn?.arguments ?? obj?.arguments ?? obj?.input ?? {};
    let parsedArgs: unknown;
    try {
      parsedArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    } catch {
      parsedArgs = rawArgs;
    }
    return {
      id: String(obj?.id ?? `tc_${Math.random().toString(36).slice(2)}`),
      name: String(fn?.name ?? obj?.name ?? obj?.type ?? 'tool'),
      arguments: parsedArgs,
    };
  });
}

function formatToolDescription(tool: ToolDefinition): string {
  if (!tool.examples?.length) return tool.description;
  const examples = tool.examples.slice(0, 2).map((example, index) => {
    const input = safeJson(example.input).replace(/\s+/g, ' ');
    return `${index + 1}. ${example.description}: ${input}`;
  }).join(' ');
  return `${tool.description}\nExamples: ${examples}`;
}
