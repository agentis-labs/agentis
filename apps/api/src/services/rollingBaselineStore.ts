/**
 * RollingBaselineStore — Layer 4 backend.
 *
 *
 * Owns the `rolling_baseline_snapshots` table.
 *
 * Each row is one rolling-window view (rolling_7d / rolling_30d / rolling_90d)
 * of a workflow's performance. The latest row per (workflowId, window) is
 * the active baseline for that window.
 *
 * Anomaly detection (`detectAnomalies`) compares observed metrics against the
 * latest baseline window and returns deviation reports for the policy engine.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type {
  BaselineAnomaly,
  BaselineWindow,
  RollingBaselineSnapshot,
} from '@agentis/core';

export interface CaptureBaselineArgs {
  workspaceId: string;
  scopeId?: string | null;
  workflowId: string;
  window: BaselineWindow;
  successRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgCostMicros: number;
  avgReplayCount: number;
  avgApprovalCount: number;
  evaluatorPassRate: number;
  sampleSize: number;
  windowStart: string;
  windowEnd: string;
}

/**
 * Observed metrics for one run, fed into `detectAnomalies()` to compare
 * against baseline.
 */
export interface ObservedRunMetrics {
  workflowId: string;
  scopeId?: string | null;
  successRate?: number;        // 0|1 for a single run; rolling window for multiple
  latencyMs: number;
  costMicros: number;
  replayCount: number;
  approvalCount: number;
  evaluatorPassRate?: number;  // 0..1
}

const STD_DEV_THRESHOLD = 2.0;       // 2σ deviation triggers anomaly
const RATIO_LATENCY_THRESHOLD = 1.5; // 50% over baseline p95
const RATIO_COST_THRESHOLD = 1.5;    // 50% over baseline avg

export class RollingBaselineStore {
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Capture a new rolling baseline snapshot. */
  capture(args: CaptureBaselineArgs): RollingBaselineSnapshot {
    const id = randomUUID();
    const capturedAt = new Date().toISOString();
    const row = {
      id,
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      workflowId: args.workflowId,
      window: args.window,
      successRate: String(clamp01(args.successRate)),
      p50LatencyMs: Math.max(0, Math.round(args.p50LatencyMs)),
      p95LatencyMs: Math.max(0, Math.round(args.p95LatencyMs)),
      avgCostMicros: Math.max(0, Math.round(args.avgCostMicros)),
      avgReplayCount: String(Math.max(0, args.avgReplayCount)),
      avgApprovalCount: String(Math.max(0, args.avgApprovalCount)),
      evaluatorPassRate: String(clamp01(args.evaluatorPassRate)),
      sampleSize: Math.max(0, Math.round(args.sampleSize)),
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      capturedAt,
    };
    this.db.insert(schema.rollingBaselineSnapshots).values(row).run();
    return rowToSnapshot(row);
  }

  /** Latest baseline per window for one workflow. */
  latest(workspaceId: string, workflowId: string): Record<BaselineWindow, RollingBaselineSnapshot | null> {
    const rows = this.db.select().from(schema.rollingBaselineSnapshots)
      .where(
        and(
          eq(schema.rollingBaselineSnapshots.workspaceId, workspaceId),
          eq(schema.rollingBaselineSnapshots.workflowId, workflowId),
        ),
      )
      .orderBy(desc(schema.rollingBaselineSnapshots.capturedAt))
      .all();
    const result: Record<BaselineWindow, RollingBaselineSnapshot | null> = {
      rolling_7d: null,
      rolling_30d: null,
      rolling_90d: null,
    };
    for (const r of rows) {
      const w = r.window as BaselineWindow;
      if (!result[w]) result[w] = rowToSnapshot(r);
    }
    return result;
  }

  /** All latest baselines for a workspace (one per workflow×window). */
  latestForScope(workspaceId: string, scopeId: string): RollingBaselineSnapshot[] {
    const rows = this.db.select().from(schema.rollingBaselineSnapshots)
      .where(
        and(
          eq(schema.rollingBaselineSnapshots.workspaceId, workspaceId),
          eq(schema.rollingBaselineSnapshots.scopeId, scopeId),
        ),
      )
      .orderBy(desc(schema.rollingBaselineSnapshots.capturedAt))
      .all();

    // Collapse: keep the latest per (workflowId, window).
    const seen = new Set<string>();
    const out: RollingBaselineSnapshot[] = [];
    for (const r of rows) {
      const key = `${r.workflowId}~${r.window}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rowToSnapshot(r));
    }
    return out;
  }

  /** Snapshots over time for a single workflow×window — used for trend charts. */
  history(args: {
    workspaceId: string;
    workflowId: string;
    window: BaselineWindow;
    limit?: number;
  }): RollingBaselineSnapshot[] {
    const limit = Math.min(Math.max(args.limit ?? 30, 1), 200);
    const rows = this.db.select().from(schema.rollingBaselineSnapshots)
      .where(
        and(
          eq(schema.rollingBaselineSnapshots.workspaceId, args.workspaceId),
          eq(schema.rollingBaselineSnapshots.workflowId, args.workflowId),
          eq(schema.rollingBaselineSnapshots.window, args.window),
        ),
      )
      .orderBy(desc(schema.rollingBaselineSnapshots.capturedAt))
      .limit(limit)
      .all();
    return rows.map(rowToSnapshot);
  }

  /**
   * Detect anomalies in observed metrics against the latest baselines.
   *
   * Rules:
   *   - latency_p95: observed > baseline.p95 × RATIO_LATENCY_THRESHOLD
   *   - cost: observed > baseline.avgCostMicros × RATIO_COST_THRESHOLD
   *   - replay_count: observed > baseline.avgReplayCount + 2 (and at least 2)
   *   - approval_count: observed > baseline.avgApprovalCount + 2 (and at least 2)
   *   - evaluator_pass_rate: observed < baseline.evaluatorPassRate − 0.2
   *   - success_rate: observed < baseline.successRate − 0.2
   *
   * Uses the rolling_30d window when available, falls back to rolling_7d,
   * then rolling_90d.
   */
  detectAnomalies(workspaceId: string, observed: ObservedRunMetrics): BaselineAnomaly[] {
    const latest = this.latest(workspaceId, observed.workflowId);
    const baseline = latest.rolling_30d ?? latest.rolling_7d ?? latest.rolling_90d;
    if (!baseline) return []; // no baseline yet; nothing to compare against

    const detectedAt = new Date().toISOString();
    const out: BaselineAnomaly[] = [];

    // Latency
    if (baseline.p95LatencyMs > 0 && observed.latencyMs > baseline.p95LatencyMs * RATIO_LATENCY_THRESHOLD) {
      out.push({
        workflowId: observed.workflowId,
        window: baseline.window,
        dimension: 'latency_p95',
        observed: observed.latencyMs,
        baseline: baseline.p95LatencyMs,
        deviation: observed.latencyMs / baseline.p95LatencyMs,
        reason: `latency ${observed.latencyMs}ms exceeds baseline p95 ${baseline.p95LatencyMs}ms by ${RATIO_LATENCY_THRESHOLD}×`,
        detectedAt,
      });
    }

    // Cost
    if (baseline.avgCostMicros > 0 && observed.costMicros > baseline.avgCostMicros * RATIO_COST_THRESHOLD) {
      out.push({
        workflowId: observed.workflowId,
        window: baseline.window,
        dimension: 'cost',
        observed: observed.costMicros,
        baseline: baseline.avgCostMicros,
        deviation: observed.costMicros / baseline.avgCostMicros,
        reason: `cost ${observed.costMicros}µ exceeds baseline avg ${baseline.avgCostMicros}µ by ${RATIO_COST_THRESHOLD}×`,
        detectedAt,
      });
    }

    // Replay count
    if (observed.replayCount >= 2 && observed.replayCount > baseline.avgReplayCount + 2) {
      out.push({
        workflowId: observed.workflowId,
        window: baseline.window,
        dimension: 'replay_count',
        observed: observed.replayCount,
        baseline: baseline.avgReplayCount,
        deviation: observed.replayCount - baseline.avgReplayCount,
        reason: `replays ${observed.replayCount} exceed baseline avg ${baseline.avgReplayCount.toFixed(1)} by > 2`,
        detectedAt,
      });
    }

    // Approval count
    if (observed.approvalCount >= 2 && observed.approvalCount > baseline.avgApprovalCount + 2) {
      out.push({
        workflowId: observed.workflowId,
        window: baseline.window,
        dimension: 'approval_count',
        observed: observed.approvalCount,
        baseline: baseline.avgApprovalCount,
        deviation: observed.approvalCount - baseline.avgApprovalCount,
        reason: `approvals ${observed.approvalCount} exceed baseline avg ${baseline.avgApprovalCount.toFixed(1)} by > 2`,
        detectedAt,
      });
    }

    // Evaluator pass rate
    if (observed.evaluatorPassRate !== undefined && baseline.evaluatorPassRate > 0) {
      const dropEvalPct = baseline.evaluatorPassRate - observed.evaluatorPassRate;
      if (dropEvalPct >= 0.2) {
        out.push({
          workflowId: observed.workflowId,
          window: baseline.window,
          dimension: 'evaluator_pass_rate',
          observed: observed.evaluatorPassRate,
          baseline: baseline.evaluatorPassRate,
          deviation: dropEvalPct,
          reason: `evaluator pass rate ${(observed.evaluatorPassRate * 100).toFixed(1)}% dropped ${(dropEvalPct * 100).toFixed(1)}% from baseline ${(baseline.evaluatorPassRate * 100).toFixed(1)}%`,
          detectedAt,
        });
      }
    }

    // Success rate (only meaningful for rolling observed window).
    if (observed.successRate !== undefined && baseline.successRate > 0) {
      const drop = baseline.successRate - observed.successRate;
      if (drop >= 0.2) {
        out.push({
          workflowId: observed.workflowId,
          window: baseline.window,
          dimension: 'success_rate',
          observed: observed.successRate,
          baseline: baseline.successRate,
          deviation: drop,
          reason: `success rate ${(observed.successRate * 100).toFixed(1)}% dropped ${(drop * 100).toFixed(1)}% from baseline ${(baseline.successRate * 100).toFixed(1)}%`,
          detectedAt,
        });
      }
    }

    void STD_DEV_THRESHOLD; // reserved for future stddev-based detection
    return out;
  }

}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function rowToSnapshot(row: typeof schema.rollingBaselineSnapshots.$inferSelect): RollingBaselineSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scopeId: row.scopeId,
    workflowId: row.workflowId,
    window: row.window as BaselineWindow,
    successRate: Number(row.successRate) || 0,
    p50LatencyMs: Number(row.p50LatencyMs) || 0,
    p95LatencyMs: Number(row.p95LatencyMs) || 0,
    avgCostMicros: Number(row.avgCostMicros) || 0,
    avgReplayCount: Number(row.avgReplayCount) || 0,
    avgApprovalCount: Number(row.avgApprovalCount) || 0,
    evaluatorPassRate: Number(row.evaluatorPassRate) || 0,
    sampleSize: Number(row.sampleSize) || 0,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    capturedAt: row.capturedAt,
  };
}
