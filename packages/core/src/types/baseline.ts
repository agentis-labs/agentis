/**
 * Baseline types — Layer 4 of the Memory Architecture.
 *
 *
 * The wedge already exposes a `WorkflowBaselineSnapshot` for per-workflow
 * baselines. This file adds the rolling-window vocabulary the Memory
 * Architecture needs (`rolling_7d`, `rolling_30d`, `rolling_90d`) and
 * companion types for richer baseline tracking (replay counts, approval
 * counts, evaluator pass rates).
 *
 * Note: this complements `appIntelligence.ts:WorkflowBaselineSnapshot`,
 * not replacing it. Older snapshots without window metadata still load.
 */

/** Rolling baseline windows. */
export type BaselineWindow = 'rolling_7d' | 'rolling_30d' | 'rolling_90d';

/**
 * Richer baseline snapshot used by the policy engine and anomaly detector.
 *
 * The wedge's `WorkflowBaselineSnapshot` carries the basics; this adds:
 *   - explicit window vocabulary
 *   - replay/approval counts (so the runtime can track healing pressure)
 *   - evaluator pass rate (Layer 4 cross-talk)
 *   - sample size + cost in micros (consistent with cost compiler)
 */
export interface RollingBaselineSnapshot {
  id: string;
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
  /** When the rolling window started (for explanation in the UI). */
  windowStart: string;
  windowEnd: string;
  capturedAt: string;
}

/**
 * Anomaly detected against a baseline. Surfaced to the policy engine so it
 * can degrade or escalate.
 */
export interface BaselineAnomaly {
  workflowId: string;
  window: BaselineWindow;
  /** Which dimension was anomalous. */
  dimension:
    | 'success_rate'
    | 'latency_p95'
    | 'cost'
    | 'replay_count'
    | 'approval_count'
    | 'evaluator_pass_rate';
  /** The current observed value. */
  observed: number;
  /** The baseline value being compared against. */
  baseline: number;
  /** How many standard deviations off the baseline (or simple ratio). */
  deviation: number;
  /** Free-form explanation. */
  reason: string;
  detectedAt: string;
}
