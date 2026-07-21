/**
 * StrategyService — the Evolution Loop's competing, outcome-weighted approaches.
 *
 * A Strategy is one way an App pursues its Goal (e.g. "open with a question", or
 * "lead with a demo video"). Strategies COMPETE: each maps to an experiment arm,
 * accrues MEASURED outcomes (wins/trials), and earns a confidence that tracks its
 * win rate — NOT how often it recurs (the gap the audit flagged). A PROVEN
 * strategy is mirrored into the App Brain as a recallable atom so future runs use
 * the winning approach; the controller (Phase 3) promotes winners and spawns the
 * next generation.
 *
 * Confidence is Laplace-smoothed (`(wins+1)/(trials+2)`) so a 1/1 strategy is not
 * treated as certain — small samples pull toward 0.5 until evidence accrues.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { SharedIntelligenceService } from '../sharedIntelligence.js';

/** Outcomes that count as a win (aligned with ExperimentService). */
export const STRATEGY_SUCCESS_OUTCOMES = new Set(['won', 'success', 'positive', 'converted']);

export interface StrategyRecord {
  id: string;
  appId: string;
  key: string;
  hypothesis: string;
  experimentKey: string | null;
  variant: string | null;
  generation: number;
  parentId: string | null;
  metric: string | null;
  status: 'active' | 'proven' | 'retired';
  wins: number;
  trials: number;
  /** wins / trials (0 when untried). */
  winRate: number;
  /** Laplace-smoothed, sample-aware recall weight. */
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProposeStrategyInput {
  workspaceId: string;
  appId: string;
  key: string;
  hypothesis: string;
  experimentKey?: string | null;
  variant?: string | null;
  parentId?: string | null;
  metric?: string | null;
  generation?: number;
}

export interface StrategyServiceDeps {
  db: AgentisSqliteDb;
  shared: Pick<SharedIntelligenceService, 'commitDurableAtom'>;
  logger: Logger;
}

/** Laplace-smoothed win rate — the outcome-weighted, sample-aware confidence. */
export function strategyConfidence(wins: number, trials: number): number {
  return (wins + 1) / (trials + 2);
}

export class StrategyService {
  constructor(private readonly deps: StrategyServiceDeps) {}

  /** Create or update a strategy (idempotent by app+key). Updates hypothesis/links when re-proposed. */
  propose(input: ProposeStrategyInput): StrategyRecord {
    const now = new Date().toISOString();
    const existing = this.#row(input.workspaceId, input.appId, input.key);
    if (existing) {
      this.deps.db.update(schema.strategies).set({
        hypothesis: input.hypothesis,
        ...(input.experimentKey !== undefined ? { experimentKey: input.experimentKey } : {}),
        ...(input.variant !== undefined ? { variant: input.variant } : {}),
        ...(input.metric !== undefined ? { metric: input.metric } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        updatedAt: now,
      }).where(eq(schema.strategies.id, existing.id)).run();
      return this.#toRecord(this.#byId(existing.id)!);
    }
    const id = randomUUID();
    this.deps.db.insert(schema.strategies).values({
      id,
      workspaceId: input.workspaceId,
      appId: input.appId,
      key: input.key,
      hypothesis: input.hypothesis,
      experimentKey: input.experimentKey ?? null,
      variant: input.variant ?? null,
      generation: input.generation ?? 0,
      parentId: input.parentId ?? null,
      metric: input.metric ?? null,
      status: 'active',
      wins: 0,
      trials: 0,
      confidence: strategyConfidence(0, 0),
      atomId: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.#toRecord(this.#byId(id)!);
  }

  list(workspaceId: string, appId: string): StrategyRecord[] {
    return this.deps.db.select().from(schema.strategies)
      .where(and(eq(schema.strategies.workspaceId, workspaceId), eq(schema.strategies.appId, appId)))
      .orderBy(desc(schema.strategies.confidence))
      .all()
      .map((r) => this.#toRecord(r));
  }

  get(workspaceId: string, appId: string, key: string): StrategyRecord | null {
    const row = this.#row(workspaceId, appId, key);
    return row ? this.#toRecord(row) : null;
  }

  /** Record one measured outcome against a strategy — updates wins/trials + confidence. */
  recordOutcome(input: { workspaceId: string; appId: string; key: string; success: boolean }): StrategyRecord | null {
    const row = this.#row(input.workspaceId, input.appId, input.key);
    if (!row) return null;
    const wins = row.wins + (input.success ? 1 : 0);
    const trials = row.trials + 1;
    this.deps.db.update(schema.strategies).set({
      wins, trials, confidence: strategyConfidence(wins, trials), updatedAt: new Date().toISOString(),
    }).where(eq(schema.strategies.id, row.id)).run();
    return this.#toRecord(this.#byId(row.id)!);
  }

  /** Bridge from ExperimentService.record: map (experimentKey, variant) → its strategy and count the outcome. */
  recordExperimentOutcome(input: { workspaceId: string; experimentKey: string; variant: string; outcome: string }): StrategyRecord | null {
    const row = this.deps.db.select().from(schema.strategies)
      .where(and(
        eq(schema.strategies.workspaceId, input.workspaceId),
        eq(schema.strategies.experimentKey, input.experimentKey),
        eq(schema.strategies.variant, input.variant),
      )).get();
    if (!row) return null;
    return this.recordOutcome({ workspaceId: input.workspaceId, appId: row.appId, key: row.key, success: STRATEGY_SUCCESS_OUTCOMES.has(input.outcome) });
  }

  /** Mark a strategy proven and mirror it into the App Brain so runs recall the winning approach. */
  async promote(workspaceId: string, appId: string, key: string): Promise<StrategyRecord | null> {
    const row = this.#row(workspaceId, appId, key);
    if (!row) return null;
    this.deps.db.update(schema.strategies).set({ status: 'proven', updatedAt: new Date().toISOString() })
      .where(eq(schema.strategies.id, row.id)).run();
    const record = this.#toRecord(this.#byId(row.id)!);
    await this.#mirror(workspaceId, record);
    return record;
  }

  /** Retire a losing strategy — it stops competing and loses recall weight. */
  retire(workspaceId: string, appId: string, key: string): StrategyRecord | null {
    const row = this.#row(workspaceId, appId, key);
    if (!row) return null;
    this.deps.db.update(schema.strategies).set({ status: 'retired', updatedAt: new Date().toISOString() })
      .where(eq(schema.strategies.id, row.id)).run();
    return this.#toRecord(this.#byId(row.id)!);
  }

  /** Mirror a proven strategy as a recallable, outcome-weighted App-Brain atom. */
  async #mirror(workspaceId: string, s: StrategyRecord): Promise<void> {
    try {
      const pct = (s.winRate * 100).toFixed(0);
      const res = await this.deps.shared.commitDurableAtom({
        workspaceId,
        scopeId: s.appId,
        title: `Proven strategy — ${s.hypothesis.slice(0, 72)}`,
        content: `Proven approach for ${s.metric ? `"${s.metric}"` : 'this App'}: ${s.hypothesis} (win rate ${pct}% over ${s.trials} trials). Prefer this approach.`,
        type: 'success_pattern',
        source: 'system_write',
        tags: ['strategy', 'proven', `strategy:${s.key}`],
        confidence: s.confidence,
        importance: Math.min(0.9, 0.6 + Math.min(0.3, s.trials / 100)),
        outcomeStatus: 'good',
        metadata: { kind: 'strategy', strategyKey: s.key, appId: s.appId, winRate: s.winRate, trials: s.trials, metric: s.metric },
      });
      if (res?.atomId) {
        this.deps.db.update(schema.strategies).set({ atomId: res.atomId })
          .where(and(eq(schema.strategies.workspaceId, workspaceId), eq(schema.strategies.appId, s.appId), eq(schema.strategies.key, s.key)))
          .run();
      }
    } catch (err) {
      this.deps.logger.warn('strategy.mirror_failed', { key: s.key, err: (err as Error).message });
    }
  }

  #row(workspaceId: string, appId: string, key: string) {
    return this.deps.db.select().from(schema.strategies)
      .where(and(eq(schema.strategies.workspaceId, workspaceId), eq(schema.strategies.appId, appId), eq(schema.strategies.key, key)))
      .get() ?? null;
  }

  #byId(id: string) {
    return this.deps.db.select().from(schema.strategies).where(eq(schema.strategies.id, id)).get() ?? null;
  }

  #toRecord(row: typeof schema.strategies.$inferSelect): StrategyRecord {
    return {
      id: row.id,
      appId: row.appId,
      key: row.key,
      hypothesis: row.hypothesis,
      experimentKey: row.experimentKey,
      variant: row.variant,
      generation: row.generation,
      parentId: row.parentId,
      metric: row.metric,
      status: row.status as StrategyRecord['status'],
      wins: row.wins,
      trials: row.trials,
      winRate: row.trials > 0 ? row.wins / row.trials : 0,
      confidence: row.confidence,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
