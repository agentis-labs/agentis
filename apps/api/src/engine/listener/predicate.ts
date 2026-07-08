/**
 * Predicate evaluation — EXTENSIONS-AND-LISTENER-10X §1.4.
 *
 * Decides whether a received event should proceed to the fire-policy layer.
 * Five backends:
 *   always    — every event passes
 *   jsonpath  — extract a value and compare with an operator
 *   jmespath  — extract a value and assert truthiness
 *   extension — a sandboxed operation returns { matched, reason }
 *   agent     — semantic judgment (the Agentis moat): an agent reads the event
 *               and decides. Injected as `agentJudge` so the runtime stays
 *               decoupled from the chat infrastructure.
 */

import type { ListenerPredicate, PredicateResult } from '@agentis/core';
import type { ExtensionRuntime } from '../../services/extensionRuntime.js';
import type { Logger } from '../../logger.js';
import { evalJmesLite, getPath, isTruthy } from './jsonpath.js';

export type AgentJudge = (args: {
  agentId: string;
  prompt: string;
  event: Record<string, unknown>;
  outputField: string;
  passValues: string[];
  maxBudgetTokens?: number;
}) => Promise<PredicateResult>;

export interface PredicateDeps {
  workspaceId: string;
  extensionRuntime?: ExtensionRuntime;
  agentJudge?: AgentJudge;
  logger: Logger;
}

interface CacheEntry {
  result: PredicateResult;
  expiresAt: number;
}

export class PredicateEvaluator {
  readonly #cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: PredicateDeps) {}

  async evaluate(predicate: ListenerPredicate | undefined, event: Record<string, unknown>): Promise<PredicateResult> {
    if (!predicate || predicate.kind === 'always') return { matched: true };

    try {
      switch (predicate.kind) {
        case 'jsonpath':
          return evalJsonPath(predicate, event);
        case 'jmespath': {
          const value = evalJmesLite(event, predicate.expression);
          const truthy = predicate.truthy ?? true;
          const matched = isTruthy(value) === truthy;
          return { matched, reason: matched ? undefined : `jmespath(${predicate.expression}) truthy=${isTruthy(value)}` };
        }
        case 'extension':
          return await this.#evalExtension(predicate, event);
        case 'agent':
          return await this.#evalAgent(predicate, event);
        default:
          return { matched: true };
      }
    } catch (err) {
      // Fail closed: a broken predicate must not flood the workflow with fires.
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn('listener.predicate.error', { kind: predicate.kind, reason });
      return { matched: false, reason: `predicate error: ${reason}` };
    }
  }

  async #evalExtension(
    predicate: Extract<ListenerPredicate, { kind: 'extension' }>,
    event: Record<string, unknown>,
  ): Promise<PredicateResult> {
    if (!this.deps.extensionRuntime) {
      return { matched: false, reason: 'extension runtime unavailable' };
    }
    const cacheKey = predicate.cacheWindowMs
      ? `ext:${predicate.extensionId ?? predicate.extensionSlug}:${predicate.operationName}:${stableKey(event)}`
      : null;
    const cached = cacheKey ? this.#readCache(cacheKey) : undefined;
    if (cached) return cached;

    const outcome = await this.deps.extensionRuntime.execute({
      workspaceId: this.deps.workspaceId,
      extensionId: predicate.extensionId,
      extensionSlug: predicate.extensionSlug,
      operationName: predicate.operationName,
      input: { event, config: predicate.config ?? {} },
      scratchpadSnapshot: {},
    });
    let result: PredicateResult;
    if (!outcome.ok) {
      result = { matched: false, reason: `${outcome.errorCode}: ${outcome.message}` };
    } else {
      const matched = Boolean((outcome.output as { matched?: unknown }).matched);
      const reason = typeof (outcome.output as { reason?: unknown }).reason === 'string'
        ? (outcome.output as { reason: string }).reason
        : undefined;
      result = { matched, reason };
    }
    if (cacheKey && predicate.cacheWindowMs) this.#writeCache(cacheKey, result, predicate.cacheWindowMs);
    return result;
  }

  async #evalAgent(
    predicate: Extract<ListenerPredicate, { kind: 'agent' }>,
    event: Record<string, unknown>,
  ): Promise<PredicateResult> {
    if (!this.deps.agentJudge) {
      return { matched: false, reason: 'agent predicate unavailable (no chat runtime wired)' };
    }
    const cacheKey = predicate.cacheWindowMs ? `agent:${predicate.agentId}:${stableKey(event)}` : null;
    const cached = cacheKey ? this.#readCache(cacheKey) : undefined;
    if (cached) return cached;

    const result = await this.deps.agentJudge({
      agentId: predicate.agentId,
      prompt: predicate.prompt,
      event,
      outputField: predicate.outputField ?? 'decision',
      passValues: predicate.passValues ?? ['yes', 'true', '1', 'fire'],
      maxBudgetTokens: predicate.maxBudgetTokens,
    });
    if (cacheKey && predicate.cacheWindowMs) this.#writeCache(cacheKey, result, predicate.cacheWindowMs);
    return result;
  }

  #readCache(key: string): PredicateResult | undefined {
    const entry = this.#cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.#cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  #writeCache(key: string, result: PredicateResult, windowMs: number): void {
    this.#cache.set(key, { result, expiresAt: Date.now() + windowMs });
    if (this.#cache.size > 500) {
      // crude bound: drop the oldest-inserted entry
      const first = this.#cache.keys().next().value;
      if (first) this.#cache.delete(first);
    }
  }
}

export function evalJsonPath(
  predicate: Extract<ListenerPredicate, { kind: 'jsonpath' }>,
  event: Record<string, unknown>,
): PredicateResult {
  const actual = getPath(event, predicate.expression);
  const { operator, expected } = predicate;
  const fail = (detail: string): PredicateResult => ({ matched: false, reason: `jsonpath(${predicate.expression}) ${detail}` });
  switch (operator) {
    case 'exists':
      return actual !== undefined ? { matched: true } : fail('does not exist');
    case 'not_exists':
      return actual === undefined ? { matched: true } : fail('exists');
    case 'eq':
      return looseEq(actual, expected) ? { matched: true } : fail(`!= expected`);
    case 'neq':
      return !looseEq(actual, expected) ? { matched: true } : fail('== expected');
    case 'contains':
      return contains(actual, expected) ? { matched: true } : fail('does not contain expected');
    case 'gt':
      return Number(actual) > Number(expected) ? { matched: true } : fail('not > expected');
    case 'lt':
      return Number(actual) < Number(expected) ? { matched: true } : fail('not < expected');
    default:
      return { matched: true };
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return String(a) === String(b);
}

function contains(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === 'string') return haystack.includes(String(needle));
  if (Array.isArray(haystack)) return haystack.some((item) => looseEq(item, needle));
  return false;
}

function stableKey(event: Record<string, unknown>): string {
  try {
    return JSON.stringify(event);
  } catch {
    return Math.random().toString(36);
  }
}
