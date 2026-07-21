/**
 * StrategyEvolutionService — the Evolution Loop's controller (EVOLVE arc).
 *
 * Reads an App's competing strategies (grouped by the experiment they compete in),
 * decides whether there is a STATISTICALLY-REAL winner, and — in ACT mode —
 * promotes it, retires the clear losers, and recommends spawning the next
 * generation from the winner. In SURFACE mode it only proposes; the operator (or
 * owner agent) disposes. This keeps the decision deterministic and testable and
 * the LLM out of the core: the controller says WHAT should change; a human or the
 * owner agent (via agentis.strategy.propose) generates the new variants.
 *
 * Honesty guards (no promotion on noise):
 *   - each arm needs ≥ MIN_TRIALS_PER_ARM outcomes;
 *   - the winner must lead the runner-up by ≥ MIN_LEAD in win rate;
 *   - the difference must clear a two-proportion z-test at ~95% (|z| ≥ 1.96).
 */

import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { StrategyRecord, StrategyService } from './strategyService.js';

const MIN_TRIALS_PER_ARM = 20;
const MIN_LEAD = 0.05;
const Z_95 = 1.96;

export type EvolutionMode = 'surface' | 'act';

export interface EvolutionDecision {
  appId: string;
  experimentKey: string;
  status: 'insufficient_data' | 'no_clear_winner' | 'winner';
  /** Strategy keys in the group, best-first, with their measured stats. */
  standings: Array<{ key: string; hypothesis: string; variant: string | null; winRate: number; trials: number; confidence: number; status: string }>;
  winnerKey?: string;
  retireKeys?: string[];
  /** Recommend spawning the next generation from this strategy. */
  spawnFromKey?: string;
  z?: number;
  rationale: string;
}

export interface EvolutionResult {
  applied: boolean;
  promoted?: string;
  retired: string[];
}

/** Two-proportion z-test statistic for two arms' success counts. */
export function twoProportionZ(w1: number, n1: number, w2: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 0;
  const p1 = w1 / n1;
  const p2 = w2 / n2;
  const p = (w1 + w2) / (n1 + n2);
  const denom = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!Number.isFinite(denom) || denom === 0) return 0;
  return (p1 - p2) / denom;
}

export interface StrategyEvolutionDeps {
  strategies: Pick<StrategyService, 'list' | 'promote' | 'retire'>;
  logger: Logger;
  /** Optional — enables the autonomous cadence sweep across all Apps. */
  db?: AgentisSqliteDb;
}

export class StrategyEvolutionService {
  constructor(private readonly deps: StrategyEvolutionDeps) {}

  /** Evaluate every experiment group in an App and return one decision per group. */
  evaluate(workspaceId: string, appId: string): EvolutionDecision[] {
    const all = this.deps.strategies.list(workspaceId, appId).filter((s) => s.status !== 'retired' && s.experimentKey);
    const groups = new Map<string, StrategyRecord[]>();
    for (const s of all) {
      const key = s.experimentKey!;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
    }
    const decisions: EvolutionDecision[] = [];
    for (const [experimentKey, arms] of groups) {
      decisions.push(this.#evaluateGroup(appId, experimentKey, arms));
    }
    return decisions;
  }

  #evaluateGroup(appId: string, experimentKey: string, arms: StrategyRecord[]): EvolutionDecision {
    const ranked = [...arms].sort((a, b) => b.winRate - a.winRate || b.trials - a.trials);
    const standings = ranked.map((s) => ({ key: s.key, hypothesis: s.hypothesis, variant: s.variant, winRate: s.winRate, trials: s.trials, confidence: s.confidence, status: s.status }));
    const base = { appId, experimentKey, standings };

    if (arms.length < 2 || ranked.some((s) => s.trials < MIN_TRIALS_PER_ARM)) {
      return { ...base, status: 'insufficient_data', rationale: `Need ≥ ${MIN_TRIALS_PER_ARM} outcomes on each of ≥ 2 arms before deciding.` };
    }
    const winner = ranked[0]!;
    const runnerUp = ranked[1]!;
    const lead = winner.winRate - runnerUp.winRate;
    const z = twoProportionZ(winner.wins, winner.trials, runnerUp.wins, runnerUp.trials);
    if (lead < MIN_LEAD || Math.abs(z) < Z_95) {
      return { ...base, status: 'no_clear_winner', z, rationale: `No significant winner yet (lead ${(lead * 100).toFixed(1)}%, z=${z.toFixed(2)}). Keep exploring.` };
    }
    // Retire arms that are significantly worse than the winner.
    const retireKeys = ranked.slice(1)
      .filter((s) => winner.winRate - s.winRate >= MIN_LEAD && Math.abs(twoProportionZ(winner.wins, winner.trials, s.wins, s.trials)) >= Z_95)
      .map((s) => s.key);
    return {
      ...base,
      status: 'winner',
      winnerKey: winner.key,
      retireKeys,
      spawnFromKey: winner.key,
      z,
      rationale: `"${winner.key}" wins: ${(winner.winRate * 100).toFixed(1)}% vs ${(runnerUp.winRate * 100).toFixed(1)}% (lead ${(lead * 100).toFixed(1)}%, z=${z.toFixed(2)}). Promote it, retire ${retireKeys.length} loser(s), and spawn the next generation from it.`,
    };
  }

  /**
   * Apply a winner decision: promote the winner + retire the losers. Only acts on
   * a `winner` decision; SURFACE mode never calls this. Spawning the next
   * generation is left to the owner agent (it generates the new variants).
   */
  async apply(workspaceId: string, decision: EvolutionDecision, mode: EvolutionMode): Promise<EvolutionResult> {
    if (mode !== 'act' || decision.status !== 'winner' || !decision.winnerKey) {
      return { applied: false, retired: [] };
    }
    await this.deps.strategies.promote(workspaceId, decision.appId, decision.winnerKey);
    const retired: string[] = [];
    for (const key of decision.retireKeys ?? []) {
      if (this.deps.strategies.retire(workspaceId, decision.appId, key)) retired.push(key);
    }
    this.deps.logger.info('evolution.applied', { appId: decision.appId, experimentKey: decision.experimentKey, promoted: decision.winnerKey, retired });
    return { applied: true, promoted: decision.winnerKey, retired };
  }

  /**
   * Autonomous cadence sweep across every App with active strategies. In SURFACE
   * mode it only evaluates (proposals are read live via Mission Control); in ACT
   * mode it promotes winners + retires losers. ACT is operator-gated — off by
   * default (operator sovereignty). Returns how many winner-actions were applied.
   */
  async sweep(mode: EvolutionMode): Promise<{ apps: number; decided: number; applied: number }> {
    if (!this.deps.db) return { apps: 0, decided: 0, applied: 0 };
    const rows = this.deps.db.selectDistinct({ workspaceId: schema.strategies.workspaceId, appId: schema.strategies.appId })
      .from(schema.strategies).where(eq(schema.strategies.status, 'active')).all();
    let decided = 0;
    let applied = 0;
    for (const { workspaceId, appId } of rows) {
      for (const d of this.evaluate(workspaceId, appId)) {
        if (d.status !== 'winner') continue;
        decided += 1;
        const r = await this.apply(workspaceId, d, mode);
        if (r.applied) applied += 1;
      }
    }
    if (decided > 0) this.deps.logger.info('evolution.sweep', { mode, apps: rows.length, decided, applied });
    return { apps: rows.length, decided, applied };
  }
}
