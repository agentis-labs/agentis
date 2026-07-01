/**
 * StructuredCompleter — a model- and runtime-agnostic source of structured JSON.
 *
 * Workflow synthesis, the reviewer critic, and similar tool handlers need one
 * thing from a model: "given a system + user prompt, return a JSON object."
 * Two things can provide that:
 *
 *   1. An {@link EvaluatorRuntime} — a configured OpenAI-compatible endpoint
 *      (env or per-workspace model override). It already exposes
 *      `completeStructured`, so it satisfies this interface structurally.
 *
 *   2. The building agent's OWN live adapter — the same brain that is already
 *      answering the operator's chat. We drive it through the universal
 *      `AgentAdapter.chat()` contract, so it works with whatever model that
 *      agent is configured to use, on any runtime that supports interactive
 *      chat. No `temperature` / `response_format` / `max_tokens` negotiation is
 *      involved, so it never trips a model that rejects those parameters.
 *
 * This is the agentic default: if no dedicated synthesis model is configured,
 * the agent you are talking to builds the workflow with its own model. A better
 * model yields a better graph, but the logic is identical for every model.
 */

import type { AgentAdapter, ChatMessage } from '@agentis/core';
import { parseGeneric } from './evaluatorRuntime.js';
import { estimateTokens } from './agentSession.js';

/** Model token consumption for a completion — exact when reported, else estimated. */
export interface CompletionUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface StructuredCompleter {
  /** A short label for the resolved source, used in inspectable build traces. */
  readonly label?: string;
  /** The last failure reason, when a call returned null. */
  readonly lastError?: string | null;
  /** Token usage of the most recent completion (estimated for chat-only runtimes). */
  readonly lastUsage?: CompletionUsage | null;
  completeStructured<T extends Record<string, unknown>>(args: StructuredCompletionArgs): Promise<T | null>;
}

export interface StructuredCompletionArgs {
  system: string;
  user: string;
  maxTokens?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Binds a dynamic completer to the workspace's configured/default runtime. */
  workspaceId?: string;
  /** Abort an in-flight (and any further) completion when the turn is canceled. */
  signal?: AbortSignal;
  /** Public liveness only; callers must not surface private chain-of-thought. */
  onProgress?: (progress: StructuredCompletionProgress) => void;
}

export interface StructuredCompletionProgress {
  phase: 'started' | 'thinking' | 'text' | 'stalled';
  text?: string;
}

/**
 * Drive any chat-capable {@link AgentAdapter} as a structured-JSON completion
 * source. Speaks only `chat()` — the universal contract — accumulating text
 * deltas and parsing the first JSON object out of the reply. Retries with a
 * "strict JSON only" nudge on a parse miss.
 */
export async function completeStructuredViaAdapter<T extends Record<string, unknown>>(
  adapter: AgentAdapter,
  args: {
    system: string;
    user: string;
    maxAttempts?: number;
    signal?: AbortSignal;
    preferredModel?: string;
    maxTokens?: number;
    timeoutMs?: number;
    onProgress?: (progress: StructuredCompletionProgress) => void;
  },
): Promise<{ value: T | null; error: string | null; usage: CompletionUsage }> {
  // No runtime exposes exact usage through the universal chat() stream, so we
  // estimate from prompt + accumulated output text. Tracked across attempts so a
  // retried completion still attributes the tokens the harness actually spent.
  const usage: CompletionUsage = { tokensIn: 0, tokensOut: 0 };
  if (!adapter.chat) return { value: null, error: 'the agent runtime does not support chat completions', usage };
  const attempts = Math.max(1, Math.min(args.maxAttempts ?? 3, 5));
  let user = args.user;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Stop before starting another (billable) attempt once the turn is canceled.
    if (args.signal?.aborted) return { value: null, error: 'canceled', usage };
    let text = '';
    let errored = false;
    let adapterError: string | null = null;
    try {
      const stall = new AbortController();
      const abortFromParent = () => stall.abort();
      args.signal?.addEventListener('abort', abortFromParent, { once: true });
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const requestedTimeoutMs = args.timeoutMs ?? DEFAULT_STRUCTURED_COMPLETION_TIMEOUT_MS;
      // A CLI harness may spend tens of seconds starting its process and model
      // before it emits its first delta. Do not convert that into a synthetic
      // evaluator verdict; the outer request timeout remains the hard bound.
      const stallTimeoutMs = Math.max(30_000, Math.min(requestedTimeoutMs, 120_000));
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          args.onProgress?.({ phase: 'stalled' });
          stall.abort();
        }, stallTimeoutMs);
      };
      args.onProgress?.({ phase: 'started' });
      armStall();
      const messages: ChatMessage[] = [
        { role: 'system', content: args.system },
        { role: 'user', content: user },
      ];
      const options = {
        latencyClass: 'structured' as const,
        toolMode: 'caller_loop' as const,
        timeoutMs: requestedTimeoutMs,
        signal: stall.signal,
        ...(args.preferredModel ? { preferredModel: args.preferredModel } : {}),
        ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
      };
      for await (const delta of adapter.chat(messages, [], options)) {
        armStall();
        if (delta.type === 'text') {
          text += delta.delta;
          args.onProgress?.({ phase: 'text', text: delta.delta.slice(0, 240) });
        } else if (delta.type === 'thinking') {
          args.onProgress?.({ phase: 'thinking' });
        }
        else if (delta.type === 'tool_result' && delta.error) adapterError = delta.error;
        else if (delta.type === 'done') {
          errored = delta.finishReason === 'error';
          break;
        }
      }
      if (stallTimer) clearTimeout(stallTimer);
      args.signal?.removeEventListener('abort', abortFromParent);
      // Attribute the tokens this attempt spent (input prompt + emitted output).
      // Retries accumulate — the harness billed each attempt.
      usage.tokensIn += estimateTokens(args.system) + estimateTokens(user);
      usage.tokensOut += estimateTokens(text);
    } catch (err) {
      lastError = (err as Error).message;
      if (args.signal?.aborted) return { value: null, error: 'canceled', usage };
      if (attempt >= attempts - 1 || !isTransientRuntimeError(lastError)) {
        return { value: null, error: lastError, usage };
      }
      user = retryPrompt(args.user, lastError);
      continue;
    }
    if (errored) {
      lastError = adapterError ?? 'the agent runtime returned an error';
      if (args.signal?.aborted) return { value: null, error: 'canceled', usage };
      if (attempt < attempts - 1 && isTransientRuntimeError(lastError)) {
        user = retryPrompt(args.user, lastError);
        continue;
      }
      return { value: null, error: lastError, usage };
    }
    const parsed = parseGeneric(text) as T | null;
    if (parsed) return { value: parsed, error: null, usage };
    lastError = text.trim().length === 0
      ? 'the agent runtime returned no content'
      : 'the response was not parseable as a JSON object';
    user = retryPrompt(args.user, lastError);
  }
  return { value: null, error: lastError, usage };
}

function retryPrompt(base: string, err: string): string {
  return `${base}\n\nPREVIOUS ATTEMPT FAILED: ${err}. Respond with ONE strict JSON object only — no prose, no markdown, no code fences.`;
}

/** A {@link StructuredCompleter} backed by a live agent adapter. */
export class AdapterStructuredCompleter implements StructuredCompleter {
  readonly label: string;
  lastError: string | null = null;
  lastUsage: CompletionUsage | null = null;
  /** Default per-call timeout, sized to the adapter's latency profile. */
  readonly #defaultTimeoutMs: number;
  constructor(
    private readonly adapter: AgentAdapter,
    label = 'building agent model',
    private readonly preferredModel?: string,
  ) {
    this.label = label;
    this.#defaultTimeoutMs = structuredTimeoutForAdapter(adapter);
  }

  async completeStructured<T extends Record<string, unknown>>(args: StructuredCompletionArgs): Promise<T | null> {
    const result = await completeStructuredViaAdapter<T>(this.adapter, {
      system: args.system,
      user: args.user,
      ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.onProgress ? { onProgress: args.onProgress } : {}),
      ...(this.preferredModel ? { preferredModel: this.preferredModel } : {}),
      ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
      timeoutMs: args.timeoutMs ?? this.#defaultTimeoutMs,
    });
    this.lastError = result.error;
    this.lastUsage = result.usage;
    return result.value;
  }
}

/**
 * Ordered, bounded runtime fallback. Used by self-healing so a configured
 * healer may hand off once to the orchestrator without broad agent fishing.
 */
export class FallbackStructuredCompleter implements StructuredCompleter {
  readonly label: string;
  lastError: string | null = null;
  lastUsage: CompletionUsage | null = null;
  constructor(private readonly sources: StructuredCompleter[]) {
    this.label = sources.map((source) => source.label ?? 'runtime').join(' → ');
  }

  async completeStructured<T extends Record<string, unknown>>(args: StructuredCompletionArgs): Promise<T | null> {
    for (const source of this.sources) {
      const value = await source.completeStructured<T>(args);
      this.lastUsage = source.lastUsage ?? null;
      if (value) return value;
      this.lastError = source.lastError ?? 'runtime returned no structured result';
      if (args.signal?.aborted) return null;
    }
    return null;
  }
}

/**
 * Default structured-completion timeout for an adapter. A CLI harness
 * (`marker_protocol` / `mcp_native`) re-spawns the binary per call, so graph
 * synthesis on a cold process legitimately needs more wall-clock than a streaming
 * runtime before it's fairly judged a failure. Derived from capabilities, so it
 * applies to every harness (Codex, Claude Code, …) — not a single vendor.
 */
function structuredTimeoutForAdapter(adapter: AgentAdapter): number {
  const forwarding = adapter.capabilities?.().toolForwarding;
  if (forwarding === 'marker_protocol' || forwarding === 'mcp_native') {
    return HARNESS_STRUCTURED_COMPLETION_TIMEOUT_MS;
  }
  return DEFAULT_STRUCTURED_COMPLETION_TIMEOUT_MS;
}

function isTransientRuntimeError(error: string): boolean {
  return /\b(timeout|timed out|aborted|transport|channel closed|request failed|connection|network|temporar|unavailable)\b/i.test(error);
}

const DEFAULT_STRUCTURED_COMPLETION_TIMEOUT_MS = 30_000;
const HARNESS_STRUCTURED_COMPLETION_TIMEOUT_MS = 120_000;
