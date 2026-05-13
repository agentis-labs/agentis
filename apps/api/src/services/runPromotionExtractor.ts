/**
 * RunPromotionExtractor — automatic candidate extraction (§10.2).
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md §10.3.
 *
 * Scans a completed run's artifacts (ledger events, evaluator verdicts,
 * approval rationales, scratchpad final state) and produces promotion
 * candidates. The candidates are then handed to `MemoryPromotion`.
 *
 * Extraction sources (§10.3):
 *   - evaluator failure summaries → 'failure' or 'recovery'
 *   - approval rationales         → 'approval'
 *   - replay root causes          → 'failure'
 *   - tool failure patterns       → 'failure'
 *   - winning output patterns     → 'success_pattern'
 *   - final artifact validation   → 'artifact_outcome'
 *
 * The extractor is conservative: it only emits candidates that meet basic
 * shape requirements. The promotion engine applies the policy (§10.4) to
 * decide whether to actually write each candidate.
 */

import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type {
  PromotionCandidate,
  RuntimeEpisodeOutcome,
  RuntimeEpisodeType,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { MemoryPromotion } from './memoryPromotion.js';

export interface RunPromotionContext {
  workspaceId: string;
  runId: string;
  workflowId: string;
  appId?: string | null;
  /** Final run status: COMPLETED | FAILED | CANCELLED. */
  status: string;
}

export class RunPromotionExtractor {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly promotion: MemoryPromotion,
    private readonly logger: Logger,
  ) {}

  /**
   * Extract candidates from a completed run and run them through promotion.
   *
   * Called by the engine when a run reaches a terminal state (COMPLETED or
   * FAILED). Cancelled runs are skipped (spec §17: "do not let raw transcripts
   * dominate durable memory" — cancellations rarely teach anything).
   */
  extractAndPromote(ctx: RunPromotionContext): { promoted: number; merged: number; superseded: number; rejected: number } {
    if (ctx.status === 'CANCELLED') {
      return { promoted: 0, merged: 0, superseded: 0, rejected: 0 };
    }

    const candidates: PromotionCandidate[] = [];

    // ── Source 1: evaluator outcomes ───────────────────────
    candidates.push(...this.#extractEvaluatorOutcomes(ctx));

    // ── Source 2: approval rationales ──────────────────────
    candidates.push(...this.#extractApprovalRationales(ctx));

    // ── Source 3: replay / failure summary ─────────────────
    candidates.push(...this.#extractFailureLessons(ctx));

    // ── Source 4: success pattern (run completed cleanly) ──
    if (ctx.status === 'COMPLETED') {
      const success = this.#extractSuccessPattern(ctx);
      if (success) candidates.push(success);
    }

    if (candidates.length === 0) {
      return { promoted: 0, merged: 0, superseded: 0, rejected: 0 };
    }

    this.logger.info('memory.run_promotion.extracted', {
      runId: ctx.runId,
      status: ctx.status,
      candidateCount: candidates.length,
    });

    const args: Parameters<typeof this.promotion.promoteFromRun>[0] = {
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      candidates,
    };
    if (ctx.appId !== undefined) args.appId = ctx.appId;
    return this.promotion.promoteFromRun(args);
  }

  // ────────────────────────────────────────────────────────────
  // Source extractors
  // ────────────────────────────────────────────────────────────

  /**
   * Pull evaluator verdicts from `run_evaluations` and emit one candidate
   * per evaluator outcome (pass = success_pattern, fail = failure).
   */
  #extractEvaluatorOutcomes(ctx: RunPromotionContext): PromotionCandidate[] {
    const rows = this.db.select().from(schema.runEvaluations)
      .where(
        and(
          eq(schema.runEvaluations.workspaceId, ctx.workspaceId),
          eq(schema.runEvaluations.runId, ctx.runId),
        ),
      )
      .all();

    const out: PromotionCandidate[] = [];
    for (const r of rows) {
      // Only the LLM-tier verdicts produce useful lessons (rule-tier are
      // structural; rubric-tier are the calibration set itself).
      if (r.tier !== 'llm' && r.tier !== 'rubric') continue;
      const isFail = r.verdict === 'fail';
      const type: RuntimeEpisodeType = isFail ? 'failure' : 'evaluator_outcome';
      const outcomeStatus: RuntimeEpisodeOutcome = isFail ? 'bad' : 'good';
      const details = parseJsonRecord(r.details);
      const detailsText = (details.summary as string) ?? (details.reason as string) ?? '';

      out.push({
        source: 'evaluator_failure_summary',
        title: `${r.evaluatorId}: ${r.verdict}${r.score ? ` (score ${r.score})` : ''}`,
        summary: detailsText || `Evaluator ${r.evaluatorId} returned ${r.verdict} for run ${ctx.runId}.`,
        details: detailsText.length > 200 ? detailsText : undefined,
        type,
        outcomeStatus,
        signals: {
          evaluatorValidated: !isFail,
          confidenceHint: r.score ? Number(r.score) : (isFail ? 0.6 : 0.8),
          importanceHint: isFail ? 0.85 : 0.6,
        },
        tags: ['evaluator', r.evaluatorId, r.tier],
        entities: [r.evaluatorId],
        metadata: {
          tier: r.tier,
          score: r.score,
          nodeId: r.nodeId,
          costCents: r.costCents,
          ...details,
        },
      });
    }
    return out;
  }

  /**
   * Pull approval rationales from `approval_requests`.
   */
  #extractApprovalRationales(ctx: RunPromotionContext): PromotionCandidate[] {
    const rows = this.db.select().from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, ctx.workspaceId),
          eq(schema.approvalRequests.runId, ctx.runId),
        ),
      )
      .all();

    const out: PromotionCandidate[] = [];
    for (const r of rows) {
      // Skip pending — they didn't resolve.
      if (r.status === 'pending' || r.status === 'cancelled') continue;
      const rationale = r.resolutionReason ?? r.summary;
      if (!rationale) continue;

      const approved = r.status === 'approved';
      out.push({
        source: 'approval_rationale',
        title: `Approval ${approved ? 'granted' : 'denied'}: ${r.title}`,
        summary: rationale,
        type: 'approval',
        outcomeStatus: approved ? 'good' : 'bad',
        signals: {
          humanApproved: true,
          importanceHint: 0.7,
          confidenceHint: 0.9,
        },
        tags: ['approval', r.source, r.status],
        entities: [],
        metadata: {
          approvalId: r.id,
          source: r.source,
          confidence: r.confidence,
        },
      });
    }
    return out;
  }

  /**
   * Pull failure summaries from policy events (replan, escalation) +
   * task error messages.
   */
  #extractFailureLessons(ctx: RunPromotionContext): PromotionCandidate[] {
    const out: PromotionCandidate[] = [];

    // Failed tasks.
    const tasks = this.db.select().from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.workspaceId, ctx.workspaceId),
          eq(schema.tasks.runId, ctx.runId),
        ),
      )
      .all();

    for (const t of tasks) {
      if (!t.error) continue;
      out.push({
        source: 'tool_failure_pattern',
        title: `Task '${t.title}' failed: ${truncate(t.error, 80)}`,
        summary: t.error,
        type: 'failure',
        outcomeStatus: 'bad',
        signals: {
          importanceHint: 0.7,
          confidenceHint: 0.7,
        },
        tags: ['task_failure', t.executorType],
        entities: [t.nodeId],
        metadata: {
          taskId: t.id,
          executorType: t.executorType,
          executorRef: t.executorRef,
        },
      });
    }

    // Replan / escalation policy events suggest the run had to recover.
    const policies = this.db.select().from(schema.runPolicyEvents)
      .where(
        and(
          eq(schema.runPolicyEvents.workspaceId, ctx.workspaceId),
          eq(schema.runPolicyEvents.runId, ctx.runId),
        ),
      )
      .all();

    for (const p of policies) {
      if (p.decision !== 'pause' && p.decision !== 'escalate' && p.decision !== 'fail' && p.trigger !== 'replan') continue;
      out.push({
        source: 'replay_root_cause',
        title: `Policy ${p.decision} on ${p.trigger}: ${truncate(p.reason, 60)}`,
        summary: p.reason,
        type: p.decision === 'fail' ? 'failure' : 'recovery',
        outcomeStatus: p.decision === 'fail' ? 'bad' : 'mixed',
        signals: {
          importanceHint: 0.75,
          confidenceHint: 0.75,
        },
        tags: ['policy', p.trigger, p.decision],
        entities: [],
        metadata: { ...parseJsonRecord(p.context), trigger: p.trigger, decision: p.decision },
      });
    }

    return out;
  }

  /**
   * If the run completed cleanly, emit a success_pattern candidate.
   *
   * The signal here is light-touch: just "this workflow succeeded with this
   * input shape". Importance is moderate; promotion will reject most of these
   * unless they accumulate (repeatedCount).
   */
  #extractSuccessPattern(ctx: RunPromotionContext): PromotionCandidate | null {
    // Count prior successful runs of the same workflow to estimate repetition.
    const priorRows = this.db.select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.workspaceId, ctx.workspaceId),
          eq(schema.workflowRuns.workflowId, ctx.workflowId),
          eq(schema.workflowRuns.status, 'COMPLETED'),
        ),
      )
      .all();
    const priorCount = priorRows.length;

    if (priorCount < 3) return null; // need at least 3 prior successes before this is a "pattern"

    return {
      source: 'winning_output_pattern',
      title: `Workflow ${ctx.workflowId} consistently completes successfully`,
      summary: `Run ${ctx.runId} completed without failures. Pattern observed across ${priorCount} prior runs.`,
      type: 'success_pattern',
      outcomeStatus: 'good',
      signals: {
        repeatedCount: priorCount,
        importanceHint: 0.55,
        confidenceHint: 0.7,
      },
      tags: ['success_pattern', 'workflow_completion'],
      entities: [ctx.workflowId],
      metadata: {
        priorSuccessCount: priorCount,
        workflowId: ctx.workflowId,
      },
    };
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
