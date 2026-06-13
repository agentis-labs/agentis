/**
 * AbilityComposer — the Composer + Conflict Resolver + Ability Cache
 * (docs/ABILITIES_10X_RFC.md §4.2 / §4.4).
 *
 * Stacking abilities is where naïve systems break: composed adapters "fight over
 * the same weight regions" (the production literature is blunt about this). We
 * treat composition as a *resolved* operation, not string concatenation:
 *
 *   • Precedence — pinned/required > deeper depth > higher relevance. Higher
 *     precedence wins a conflict and is surfaced (never silently gambled).
 *   • Rule reconciliation — a NEVER rule that contradicts another ability's
 *     ALWAYS rule is detected; the higher-precedence side wins, the loser is
 *     dropped from the rendered guidance, and the conflict is recorded.
 *   • Prefix-cache discipline — task-INVARIANT tiers (required/pinned/always)
 *     are ordered by content hash so the provider's prompt/prefix cache hits
 *     across turns and tasks (our aLoRA-in-the-context-plane equivalent). The
 *     task-VARIABLE semantic tier stays relevance-ordered.
 *
 * The compose decision depends only on which abilities are in the stack and
 * their content hashes — never on the task text — so it is correctly cacheable.
 * An LRU keyed by the stack signature memoizes it (S-LoRA-style adapter pool).
 *
 * Pure + DB-free → trivially unit-testable.
 */

import type { AbilityDepth } from '@agentis/core';
import { ABILITY_DEPTH_ORDER } from '@agentis/core';

export type AbilityTier = 'required' | 'pinned' | 'always' | 'semantic';

const TIER_RANK: Record<AbilityTier, number> = { required: 0, pinned: 1, always: 2, semantic: 3 };
/** Tiers whose membership does not depend on the task — safe to hash-order for a stable prefix. */
const TASK_INVARIANT_TIERS: ReadonlySet<AbilityTier> = new Set<AbilityTier>(['required', 'pinned', 'always']);

export interface ComposerEntry {
  id: string;
  name: string;
  contentHash: string | null;
  depth: AbilityDepth;
  tier: AbilityTier;
  score: number;
  rulesAlways: string[];
  rulesNever: string[];
  toolHints: string[];
}

export interface AbilityConflict {
  kind: 'rule_conflict' | 'tool_overlap';
  detail: string;
  /** Ability that won the conflict (higher precedence). */
  winnerId: string;
  /** Ability that lost (its rule/hint was dropped). */
  loserId: string;
}

export interface ComposedStack {
  /** Final injection order: stable hashed prefix, then relevance-ordered suffix. */
  ordered: ComposerEntry[];
  conflicts: AbilityConflict[];
  /** Rule phrases suppressed on the losing side, keyed by ability id. */
  suppressed: Map<string, Set<string>>;
  /** Deterministic fingerprint of the stack (drives the prefix cache + cache key). */
  signature: string;
  cacheHit: boolean;
}

interface CachedDecision {
  order: string[];                 // ability ids in final order
  conflicts: AbilityConflict[];
  suppressed: Record<string, string[]>;
}

export interface AbilityComposerOptions {
  /** Max cached compose decisions before LRU eviction. */
  cacheSize?: number;
}

export class AbilityComposer {
  readonly #cache = new Map<string, CachedDecision>();
  readonly #cacheSize: number;
  #hits = 0;
  #misses = 0;

  constructor(opts: AbilityComposerOptions = {}) {
    this.#cacheSize = Math.max(16, opts.cacheSize ?? 256);
  }

  /** Observability for tests + telemetry. */
  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.#hits, misses: this.#misses, size: this.#cache.size };
  }

  compose(entries: ComposerEntry[]): ComposedStack {
    const signature = this.#signature(entries);
    const cached = this.#cache.get(signature);
    if (cached) {
      // LRU touch.
      this.#cache.delete(signature);
      this.#cache.set(signature, cached);
      this.#hits++;
      return this.#hydrate(entries, cached, signature, true);
    }
    this.#misses++;

    const decision = this.#resolve(entries);
    this.#cache.set(signature, decision);
    if (this.#cache.size > this.#cacheSize) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    return this.#hydrate(entries, decision, signature, false);
  }

  // ── Internals ─────────────────────────────────────────────

  #resolve(entries: ComposerEntry[]): CachedDecision {
    // 1. Order: tier first; within task-invariant tiers sort by content hash
    //    (stable prefix → prompt-cache hits); within the semantic tier sort by
    //    relevance score (best first). Final tiebreak = id, for total determinism.
    const ordered = [...entries].sort((a, b) => {
      const tr = TIER_RANK[a.tier] - TIER_RANK[b.tier];
      if (tr !== 0) return tr;
      if (TASK_INVARIANT_TIERS.has(a.tier)) {
        const ha = a.contentHash ?? a.id;
        const hb = b.contentHash ?? b.id;
        if (ha !== hb) return ha < hb ? -1 : 1;
      } else if (a.score !== b.score) {
        return b.score - a.score;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    // 2. Precedence for conflict resolution: tier rank, then DEEPER depth wins,
    //    then higher relevance, then stable id.
    const precedence = (e: ComposerEntry): number =>
      TIER_RANK[e.tier] * 1000
      - depthRank(e.depth) * 10
      - Math.round(e.score * 5);

    const conflicts: AbilityConflict[] = [];
    const suppressed: Record<string, string[]> = {};

    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i]!;
        const b = ordered[j]!;
        // A NEVER on one side that matches an ALWAYS on the other = real conflict.
        for (const [x, y] of [[a, b], [b, a]] as const) {
          for (const never of x.rulesNever) {
            const core = normalizeRule(never);
            if (!core) continue;
            const clash = y.rulesAlways.find((al) => normalizeRule(al) === core);
            if (!clash) continue;
            const winner = precedence(x) <= precedence(y) ? x : y;
            const loser = winner === x ? y : x;
            const loserRule = winner === x ? clash : never;
            (suppressed[loser.id] ??= []).push(loserRule);
            conflicts.push({
              kind: 'rule_conflict',
              detail: `"${winner.name}" ${winner === x ? 'forbids' : 'requires'} «${core}» — overrides "${loser.name}"`,
              winnerId: winner.id,
              loserId: loser.id,
            });
          }
        }
      }
    }

    return { order: ordered.map((e) => e.id), conflicts, suppressed };
  }

  #hydrate(entries: ComposerEntry[], decision: CachedDecision, signature: string, cacheHit: boolean): ComposedStack {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const ordered = decision.order.map((id) => byId.get(id)).filter((e): e is ComposerEntry => Boolean(e));
    const suppressed = new Map<string, Set<string>>();
    for (const [id, rules] of Object.entries(decision.suppressed)) suppressed.set(id, new Set(rules));
    return { ordered, conflicts: decision.conflicts, suppressed, signature, cacheHit };
  }

  #signature(entries: ComposerEntry[]): string {
    return entries
      .map((e) => `${e.tier}:${e.id}:${e.contentHash ?? '-'}:${Math.round(e.score * 100)}`)
      .sort()
      .join('|');
  }
}

function depthRank(depth: AbilityDepth): number {
  const idx = ABILITY_DEPTH_ORDER.indexOf(depth);
  return idx < 0 ? 0 : idx;
}

/** Strip leading "never/always/avoid/do not" + punctuation/case so opposite rules can be matched. */
function normalizeRule(rule: string): string {
  return rule
    .toLowerCase()
    .replace(/^\s*(never|always|avoid|do not|don't|must not|must|should not|should)\s+/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
