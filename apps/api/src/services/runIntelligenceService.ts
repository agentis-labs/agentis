/**
 * RunIntelligenceService — closes the compound learning loop (§Layer 4).
 *
 * The platform already promotes episodic memory and absorbs Data records into
 * the Brain. What was missing is the *automatic* feedback loop on run quality:
 *
 *   1. Derived baselines — after every terminal run, recompute the workflow's
 *      performance baseline (success rate, p50/p95 duration) from its recent
 *      run cohort. `AppIntelligenceRuntime` surfaces these baselines into agent
 *      context, so the next run is dispatched against an up-to-date target.
 *
 *   2. Auto-evaluation — if the owning app declares a `terminal_output`
 *      evaluator rubric, the run's terminal output is graded automatically and
 *      the verdict recorded in `run_evaluations` (no operator action needed).
 *
 *   3. Rubric calibration — when an auto-evaluation verdict is *corroborated*
 *      by the run's objective terminal status (COMPLETED↔pass, FAILED↔fail),
 *      it is written back as a calibration example. The run outcome is
 *      independent ground truth, which keeps the calibration loop from feeding
 *      on its own (circular) judgments.
 *
 * This is called from the single terminal-run bus listener in `bootstrap` —
 * it never throws (a learning-loop failure must not affect run execution).
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  AppEvaluatorBinding,
  EvaluatorRubric,
  WorkflowRunState,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { WorkflowBaselineStore } from './workflowBaselineStore.js';
import type { RollingBaselineStore } from './rollingBaselineStore.js';
import type { EvaluatorRuntime } from './evaluatorRuntime.js';
import type { EvaluatorExampleStore } from './evaluatorExampleStore.js';
import type { CollectiveBrainService } from './collectiveBrain.js';

/** Minimum terminal runs before a derived baseline carries signal. */
const MIN_BASELINE_SAMPLE = 3;
/** How many recent terminal runs to aggregate into a baseline. */
const BASELINE_COHORT = 50;
/** Cap on auto-promoted calibration examples per evaluator key. */
const MAX_PROMOTED_EXAMPLES = 40;

export interface RunIntelligenceDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  workflowBaselines: WorkflowBaselineStore;
  rollingBaselines: RollingBaselineStore;
  evaluatorRuntime: EvaluatorRuntime;
  evaluatorExamples: EvaluatorExampleStore;
  /** Brain feedback loop (Gap14) — verdict → injected-atom confidence delta. */
  collectiveBrain?: CollectiveBrainService;
}

export class RunIntelligenceService {
  constructor(private readonly deps: RunIntelligenceDeps) {}

  /**
   * Process one terminal run. Best-effort: derives the baseline, then runs the
   * auto-evaluation. Never throws.
   */
  async onTerminalRun(runId: string, status: string): Promise<void> {
    try {
      const run = this.deps.db
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, runId))
        .get();
      if (!run || run.isEphemeral || !run.workflowId) return;
      const appId = this.#resolveAppId(run.workflowId);

      this.#deriveBaseline(run.workspaceId, run.workflowId, appId);
      await this.#autoEvaluate({
        runId,
        workspaceId: run.workspaceId,
        workflowId: run.workflowId,
        appId,
        status,
        runState: run.runState as unknown as WorkflowRunState,
      });
    } catch (err) {
      this.deps.logger.warn('run_intelligence.failed', {
        runId,
        err: (err as Error).message,
      });
    }
  }

  // ────────────────────────────────────────────────────────────
  // 1. Derived baselines
  // ────────────────────────────────────────────────────────────

  #deriveBaseline(workspaceId: string, workflowId: string, appId: string | null): void {
    if (!appId) return; // baselines are an app-layer concept
    const runs = this.deps.db
      .select({
        status: schema.workflowRuns.status,
        startedAt: schema.workflowRuns.startedAt,
        completedAt: schema.workflowRuns.completedAt,
      })
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.workflowId, workflowId),
          eq(schema.workflowRuns.isEphemeral, false),
          inArray(schema.workflowRuns.status, ['COMPLETED', 'FAILED']),
        ),
      )
      .orderBy(desc(schema.workflowRuns.completedAt))
      .limit(BASELINE_COHORT)
      .all();
    if (runs.length < MIN_BASELINE_SAMPLE) return;

    const completed = runs.filter((r) => r.status === 'COMPLETED').length;
    const successRate = completed / runs.length;
    const durations = runs
      .map((r) =>
        r.startedAt && r.completedAt
          ? new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()
          : null,
      )
      .filter((d): d is number => d !== null && d >= 0)
      .sort((a, b) => a - b);
    const p50 = percentile(durations, 0.5);
    const p95 = percentile(durations, 0.95);
    const now = new Date().toISOString();
    const windowStart = runs[runs.length - 1]?.completedAt ?? now;

    this.deps.workflowBaselines.write({
      workspaceId,
      appId,
      workflowId,
      source: 'derived',
      successRate,
      ...(p50 !== null ? { p50DurationMs: p50 } : {}),
      ...(p95 !== null ? { p95DurationMs: p95 } : {}),
      sampleSize: runs.length,
      windowStart,
      windowEnd: now,
    });

    // Rolling 7d snapshot — feeds anomaly detection.
    this.deps.rollingBaselines.capture({
      workspaceId,
      appId,
      workflowId,
      window: 'rolling_7d',
      successRate,
      p50LatencyMs: p50 ?? 0,
      p95LatencyMs: p95 ?? 0,
      avgCostMicros: 0,
      avgReplayCount: 0,
      avgApprovalCount: 0,
      evaluatorPassRate: this.#recentEvaluatorPassRate(workflowId),
      sampleSize: runs.length,
      windowStart,
      windowEnd: now,
    });

    this.deps.logger.info('run_intelligence.baseline_derived', {
      workflowId,
      appId,
      successRate: Number(successRate.toFixed(3)),
      sampleSize: runs.length,
    });
  }

  /** Pass rate over the most recent recorded evaluations for a workflow. */
  #recentEvaluatorPassRate(workflowId: string): number {
    const runIds = this.deps.db
      .select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.workflowId, workflowId))
      .orderBy(desc(schema.workflowRuns.completedAt))
      .limit(BASELINE_COHORT)
      .all()
      .map((r) => r.id);
    if (runIds.length === 0) return 0;
    const evals = this.deps.db
      .select({ verdict: schema.runEvaluations.verdict })
      .from(schema.runEvaluations)
      .where(inArray(schema.runEvaluations.runId, runIds))
      .all();
    if (evals.length === 0) return 0;
    const passed = evals.filter((e) => e.verdict === 'pass').length;
    return passed / evals.length;
  }

  // ────────────────────────────────────────────────────────────
  // 2. Auto-evaluation + 3. rubric calibration
  // ────────────────────────────────────────────────────────────

  async #autoEvaluate(args: {
    runId: string;
    workspaceId: string;
    workflowId: string;
    appId: string | null;
    status: string;
    runState: WorkflowRunState;
  }): Promise<void> {
    if (!args.appId) return;
    const app = this.deps.db
      .select({ packageContents: schema.appInstances.packageContents })
      .from(schema.appInstances)
      .where(eq(schema.appInstances.id, args.appId))
      .get();
    const rubrics = (app?.packageContents as { evaluatorRubrics?: EvaluatorRubric[] } | undefined)
      ?.evaluatorRubrics;
    const terminal = rubrics?.find((r) => r.nodeKind === 'terminal_output');
    if (!terminal) return;

    const output = terminalOutput(args.runState);
    if (output === undefined) return;

    const binding: AppEvaluatorBinding = {
      id: `${args.appId}:terminal_output`,
      appliesTo: { kind: 'terminal_output', ref: args.workflowId },
      tier: 'rubric',
      rubric: {
        examples: terminal.examples.map((e) => ({
          input: e.input,
          output: e.expected,
          verdict: e.verdict === 'fail' ? 'fail' : 'pass',
          ...(e.score !== undefined ? { score: e.score } : {}),
        })),
      },
    };

    const evaluation = await this.deps.evaluatorRuntime.evaluate({
      workspaceId: args.workspaceId,
      runId: args.runId,
      binding,
      output,
    });

    // Gap14 — evaluator → brain feedback loop. Credit the atoms injected into
    // this run on PASS, penalise them on FAIL. This is the quality gradient
    // that keeps the brain from being a write-only system.
    if (this.deps.collectiveBrain) {
      try {
        this.deps.collectiveBrain.applyEvaluatorVerdict({
          workspaceId: args.workspaceId,
          runId: args.runId,
          appId: args.appId,
          verdict: evaluation.verdict,
          evaluatorConfidence: evaluation.score,
        });
      } catch (err) {
        this.deps.logger.warn('run_intelligence.brain_feedback_failed', {
          runId: args.runId,
          err: (err as Error).message,
        });
      }
    }

    // Calibration: only when the verdict is corroborated by the objective run
    // outcome. The run's terminal status is ground truth independent of the
    // evaluator, which keeps the loop from reinforcing its own mistakes.
    const objectiveVerdict =
      args.status === 'COMPLETED' ? 'pass' : args.status === 'FAILED' ? 'fail' : null;
    if (
      objectiveVerdict &&
      evaluation.verdict === objectiveVerdict &&
      this.#promotedExampleCount(args.workspaceId, args.appId) < MAX_PROMOTED_EXAMPLES
    ) {
      this.deps.evaluatorExamples.write({
        workspaceId: args.workspaceId,
        appId: args.appId,
        evaluatorKey: 'terminal_output',
        source: 'promotion',
        input: {},
        expected: output,
        verdict: objectiveVerdict,
        ...(evaluation.score !== null ? { score: evaluation.score } : {}),
        reason: `corroborated by run ${args.status.toLowerCase()}`,
        originRunId: args.runId,
      });
      this.deps.logger.info('run_intelligence.rubric_calibrated', {
        runId: args.runId,
        appId: args.appId,
        verdict: objectiveVerdict,
      });
    }
  }

  #promotedExampleCount(workspaceId: string, appId: string): number {
    return this.deps.evaluatorExamples.list({
      workspaceId,
      appId,
      evaluatorKey: 'terminal_output',
      source: 'promotion',
      limit: MAX_PROMOTED_EXAMPLES + 1,
    }).length;
  }

  #resolveAppId(workflowId: string): string | null {
    const wf = this.deps.db
      .select({ appId: schema.workflows.appId })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, workflowId))
      .get();
    if (wf?.appId) return wf.appId;
    const app = this.deps.db
      .select({ id: schema.appInstances.id })
      .from(schema.appInstances)
      .where(eq(schema.appInstances.entryWorkflowId, workflowId))
      .get();
    return app?.id ?? null;
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/** Nearest-rank percentile of a pre-sorted ascending array. */
function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx] ?? null;
}

/** The terminal output of a run — the last completed node's output. */
function terminalOutput(state: WorkflowRunState | null | undefined): unknown {
  if (!state || !Array.isArray(state.completedNodeIds)) return undefined;
  for (let i = state.completedNodeIds.length - 1; i >= 0; i -= 1) {
    const nodeId = state.completedNodeIds[i];
    if (!nodeId) continue;
    const out = state.nodeStates?.[nodeId]?.outputData;
    if (out !== undefined) return out;
  }
  return undefined;
}
