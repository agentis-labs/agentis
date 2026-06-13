/**
 * EvaluatorRuntime — LLM-as-judge for the `evaluator` node + `router` llm_route.
 *
 * Calls an OpenAI-compatible chat endpoint with a structured-output system prompt
 * and parses the response into a typed verdict. Designed to be cheap, low-latency,
 * and model-agnostic.
 *
 * Bootstrap constructs this only when the operator has configured an evaluator
 * endpoint via env vars:
 *   - AGENTIS_EVALUATOR_BASE_URL       (e.g. https://api.openai.com/v1)
 *   - AGENTIS_EVALUATOR_API_KEY        (Bearer token, optional for local LLMs)
 *   - AGENTIS_EVALUATOR_MODEL          (e.g. gpt-4o-mini, claude-3-5-haiku, llama-3.1)
 *
 * Without these env vars, `evaluator` nodes throw WORKFLOW_GRAPH_INVALID at
 * dispatch time and `router` nodes in `llm_route` mode fall back to `first_match`
 * semantics with a logger.warn — both are graceful degradations, never crashes.
 */

import { AgentisError } from '@agentis/core';
import type { Logger } from '../logger.js';

export interface EvaluatorVerdict {
  /** 0–10. */
  score: number;
  passed: boolean;
  critique: string;
  dimensionScores?: Array<{ dimension: string; score: number }>;
}

export interface EvaluatorRuntimeOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  logger: Logger;
  /** Override fetch (used by tests to stub network calls). */
  fetchImpl?: typeof fetch;
  /** Per-call timeout (default 30s). */
  timeoutMs?: number;
}

export interface EvaluateArgs {
  workspaceId: string;
  target: unknown;
  criteria: string;
  rubric?: Array<{ dimension: string; weight: number }>;
  passThreshold?: number;
}

export interface RouteBranchArgs {
  workspaceId: string;
  input: unknown;
  branches: Array<{ branchId: string; label: string; condition?: string }>;
}

export class EvaluatorRuntime {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  /**
   * Request parameters this endpoint has rejected as unsupported, learned at
   * runtime via {@link EvaluatorRuntime.#negotiate} so we never re-send them.
   * Keeps the runtime model-agnostic: we adapt to whatever the server says
   * rather than branching on a model family. (`max_tokens` here also covers the
   * `max_completion_tokens` rename — see {@link EvaluatorRuntime.#maxTokensField}.)
   */
  readonly #omit = new Set<string>();
  #maxTokensField: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
  /** The last failure reason, exposed so callers can surface the real error. */
  #lastError: string | null = null;

  constructor(private readonly opts: EvaluatorRuntimeOptions) {
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** The last failure reason from a completion that returned null, or null. */
  get lastError(): string | null {
    return this.#lastError;
  }

  async evaluate(args: EvaluateArgs): Promise<EvaluatorVerdict> {
    const passThreshold = args.passThreshold ?? 7;
    const rubricBlock = args.rubric && args.rubric.length > 0
      ? `\n\nRUBRIC DIMENSIONS (assign a score 0-10 per dimension, weights guide your overall judgement):\n${
        args.rubric.map((d) => `- ${d.dimension} (weight ${d.weight})`).join('\n')
      }`
      : '';
    const systemPrompt =
      'You are a strict, fair quality evaluator. Score the OUTPUT against the CRITERIA. '
      + 'Respond with a single JSON object only — no prose, no markdown, no code fences. '
      + 'Schema: { "score": number 0-10, "passed": boolean, "critique": string'
      + (args.rubric && args.rubric.length > 0 ? ', "dimensionScores": [{"dimension": string, "score": number}]' : '')
      + ' }';
    const userPrompt =
      `CRITERIA:\n${args.criteria}\n\nOUTPUT TO EVALUATE:\n${stringifyTarget(args.target)}${rubricBlock}`;

    const raw = await this.#callJson({
      system: systemPrompt,
      user: userPrompt,
      maxTokens: 600,
    });
    const parsed = parseVerdict(raw);
    if (!parsed) {
      // The model failed to return parseable JSON — score 0 with a structured
      // critique so the eval-retry loop can still react.
      this.opts.logger.warn('evaluator.parse_failed', { raw });
      return {
        score: 0,
        passed: false,
        critique: 'evaluator response was not valid JSON; treating as failure',
      };
    }
    return {
      score: parsed.score,
      passed: parsed.passed ?? parsed.score >= passThreshold,
      critique: parsed.critique ?? '',
      dimensionScores: parsed.dimensionScores,
    };
  }

  async routeBranch(args: RouteBranchArgs): Promise<string | null> {
    const branchList = args.branches
      .map((b) => `- ${b.branchId}: ${b.label}${b.condition ? ` (condition hint: ${b.condition})` : ''}`)
      .join('\n');
    const systemPrompt =
      'You are a workflow router. Given an INPUT and a list of branches, pick the single best '
      + 'branchId to follow. Respond with one JSON object only: { "branchId": string }';
    const userPrompt = `INPUT:\n${stringifyTarget(args.input)}\n\nBRANCHES:\n${branchList}`;

    try {
      const raw = await this.#callJson({
        system: systemPrompt,
        user: userPrompt,
        maxTokens: 80,
      });
      const decision = (parseGeneric(raw) as { branchId?: unknown } | null)?.branchId;
      return typeof decision === 'string' ? decision : null;
    } catch (err) {
      this.opts.logger.warn('evaluator.route_failed', { err: (err as Error).message });
      return null;
    }
  }

  /**
   * Generic structured-JSON completion. Used by NL workflow synthesis and any
   * other tool handler that wants the same OpenAI-compatible endpoint without
   * inventing its own.
   *
   * Retries up to `maxAttempts` times if the response can't be parsed as a
   * JSON object — each retry includes the parse error so the model can correct.
   */
  async completeStructured<T extends Record<string, unknown>>(args: {
    system: string;
    user: string;
    maxTokens?: number;
    maxAttempts?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<T | null> {
    const attempts = Math.max(1, Math.min(args.maxAttempts ?? 3, 5));
    const callTimeout = args.timeoutMs ?? this.#timeoutMs;
    let lastError: string | null = null;
    let userPrompt = args.user;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // Stop before starting another (billable) attempt once the turn is canceled.
      if (args.signal?.aborted) {
        this.#lastError = 'canceled';
        return null;
      }
      try {
        const raw = await this.#callJson({
          system: args.system,
          user: userPrompt,
          maxTokens: args.maxTokens ?? 1500,
          timeoutMs: callTimeout,
          ...(args.signal ? { signal: args.signal } : {}),
        });
        const parsed = parseGeneric(raw) as T | null;
        if (parsed) {
          this.#lastError = null;
          return parsed;
        }
        lastError = 'response was not parseable as a JSON object';
      } catch (err) {
        lastError = (err as Error).message;
      }
      userPrompt = `${args.user}\n\nPREVIOUS ATTEMPT FAILED: ${lastError}. Return strict JSON only — no prose, no code fences.`;
    }
    this.#lastError = lastError;
    this.opts.logger.warn('evaluator.completeStructured.exhausted', { lastError, attempts });
    return null;
  }

  async #callJson(req: { system: string; user: string; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<string> {
    const url = this.opts.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers['authorization'] = `Bearer ${this.opts.apiKey}`;
    const messages = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ];

    // We start with the broadly-useful params (deterministic temperature, JSON
    // response format, a token cap) and, if the endpoint rejects one as
    // unsupported, drop/adapt it and retry. This negotiation is generic — it
    // reacts to the server's own error, so it works for any model/provider
    // without hardcoding model-family quirks. The loop is bounded by the small,
    // fixed set of negotiable params.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const body: Record<string, unknown> = { model: this.opts.model, messages };
      if (!this.#omit.has('temperature')) body.temperature = 0;
      if (!this.#omit.has('response_format')) body.response_format = { type: 'json_object' };
      if (!this.#omit.has('max_tokens')) body[this.#maxTokensField] = req.maxTokens ?? 800;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? this.#timeoutMs);
      // Fold the external cancel signal into this request's controller so a client
      // disconnect aborts the in-flight HTTP call (not just the next attempt).
      const onExternalAbort = () => controller.abort();
      if (req.signal) {
        if (req.signal.aborted) controller.abort();
        else req.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      let res: Response;
      try {
        res = await this.#fetch(url, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) });
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onExternalAbort);
      }

      if (res.ok) {
        const parsed = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new AgentisError('INTEGRATION_OPERATION_FAILED', 'model backend returned no content');
        }
        return content;
      }

      const text = await res.text();
      // If the failure is an unsupported parameter we can adapt, retry; the
      // learned omission persists on this runtime so later calls skip it too.
      if (this.#negotiate(res.status, text)) {
        this.opts.logger.debug?.('evaluator.param_negotiated', {
          status: res.status,
          omit: [...this.#omit],
          maxTokensField: this.#maxTokensField,
        });
        continue;
      }
      throw new AgentisError(
        'INTEGRATION_OPERATION_FAILED',
        `model backend returned ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    throw new AgentisError('INTEGRATION_OPERATION_FAILED', 'model backend rejected every supported parameter combination');
  }

  /**
   * Inspect a 4xx error body and, if it names a request parameter the endpoint
   * doesn't support, drop or adapt it for the retry. Returns true when an
   * adjustment was made (so the caller should retry), false otherwise.
   */
  #negotiate(status: number, body: string): boolean {
    if (status !== 400 && status !== 422 && status !== 404) return false;
    const t = body.toLowerCase();
    const looksUnsupported = /unsupported|not supported|does ?n[o']t support|unexpected|unknown|unrecognized|invalid(?:_request)?|use ['"]?max_completion_tokens/.test(t);
    if (!looksUnsupported) return false;
    // max_tokens rename — the most common modern divergence. Try the alternate
    // field name before giving up on a token cap entirely.
    if (this.#maxTokensField === 'max_tokens' && !this.#omit.has('max_tokens')
        && (t.includes('max_tokens') || t.includes('max_completion_tokens'))) {
      this.#maxTokensField = 'max_completion_tokens';
      return true;
    }
    for (const param of ['temperature', 'response_format', 'max_tokens'] as const) {
      const mentioned = param === 'max_tokens'
        ? t.includes('max_tokens') || t.includes('max_completion_tokens')
        : t.includes(param);
      if (mentioned && !this.#omit.has(param)) {
        this.#omit.add(param);
        return true;
      }
    }
    return false;
  }
}

function stringifyTarget(target: unknown): string {
  if (typeof target === 'string') return target;
  try {
    return JSON.stringify(target, null, 2);
  } catch {
    return String(target);
  }
}

export function parseGeneric(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // Strip code fences if the model wrapped the JSON.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  // Fallback: extract first { ... } block.
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseVerdict(raw: string): {
  score: number;
  passed?: boolean;
  critique?: string;
  dimensionScores?: Array<{ dimension: string; score: number }>;
} | null {
  const obj = parseGeneric(raw);
  if (!obj) return null;
  const score = Number(obj.score);
  if (!Number.isFinite(score)) return null;
  const result: ReturnType<typeof parseVerdict> & object = {
    score: Math.max(0, Math.min(10, score)),
  };
  if (typeof obj.passed === 'boolean') result.passed = obj.passed;
  if (typeof obj.critique === 'string') result.critique = obj.critique;
  if (Array.isArray(obj.dimensionScores)) {
    result.dimensionScores = (obj.dimensionScores as Array<unknown>)
      .filter((d): d is { dimension: string; score: number } => {
        return (
          d !== null
          && typeof d === 'object'
          && typeof (d as { dimension?: unknown }).dimension === 'string'
          && Number.isFinite((d as { score?: unknown }).score)
        );
      })
      .map((d) => ({ dimension: d.dimension, score: Math.max(0, Math.min(10, Number(d.score))) }));
  }
  return result;
}
