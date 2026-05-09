/**
 * MemoryPromotion — the promote-or-reject pipeline.
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md §10.
 *
 * Pipeline (§10.2):
 *
 *   run state / scratchpad / ledger / evaluator outputs
 *     → candidate extraction
 *     → scoring (MemoryTrust)
 *     → dedupe / contradiction check
 *     → episode write (or reject / merge)
 *     → audit-trail event
 *     → embedding enqueue (already done at write time when provider is wired)
 *
 * The pipeline writes one row to `memory_promotion_events` per candidate
 * decision, regardless of outcome — operators can audit every decision.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type {
  CreateRuntimeEpisodeInput,
  MemoryPromotionEvent,
  PromotionCandidate,
  PromotionCandidateSource,
  PromotionReason,
  RuntimeEpisode,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { EpisodicMemoryStore } from './episodicMemoryStore.js';
import {
  computeConfidence,
  computeImportance,
  computeTrust,
  isHighRiskMemory,
  shouldPromote,
} from './memoryTrust.js';

export interface PromoteCandidateArgs {
  workspaceId: string;
  appId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  candidate: PromotionCandidate;
}

export interface PromoteFromRunArgs {
  workspaceId: string;
  runId: string;
  appId?: string | null;
  workflowId?: string | null;
  /** Pre-extracted candidates to consider. */
  candidates: PromotionCandidate[];
}

/**
 * Result of a single promotion attempt. Mirrors the audit-trail row.
 */
export interface PromotionDecision {
  decision: 'promoted' | 'rejected' | 'merged' | 'superseded';
  reason: PromotionReason | 'duplicate' | 'low_importance' | 'low_confidence';
  episode?: RuntimeEpisode;
  /** Existing episode that was merged or superseded (if applicable). */
  matchedEpisode?: RuntimeEpisode;
  score: number;
  notes?: string;
}

export class MemoryPromotion {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly episodes: EpisodicMemoryStore,
    private readonly logger: Logger,
  ) {}

  // ────────────────────────────────────────────────────────────
  // Single-candidate API
  // ────────────────────────────────────────────────────────────

  /**
   * Run one candidate through the pipeline.
   *
   * Outcomes:
   *   - `promoted`   → new episode written
   *   - `merged`     → matched a similar existing episode; reinforced it
   *   - `superseded` → contradicts existing high-trust episode; old archived
   *   - `rejected`   → didn't meet promotion rules; nothing written
   *
   * In all cases, an audit row is written to `memory_promotion_events`.
   */
  promoteCandidate(args: PromoteCandidateArgs): PromotionDecision {
    const { workspaceId, candidate } = args;
    const source = mapCandidateToEpisodeSource(candidate.source);

    const trust = computeTrust(source, candidate.signals);
    const confidence = computeConfidence(source, candidate.signals);
    const importance = computeImportance(candidate.type, candidate.signals);

    // High-risk memory requires human approval.
    if (isHighRiskMemory(candidate) && !candidate.signals.humanApproved) {
      const decision: PromotionDecision = {
        decision: 'rejected',
        reason: 'low_confidence',
        score: confidence,
        notes: 'high-risk memory requires human approval (§11.3)',
      };
      this.#writeAuditRow(workspaceId, args, candidate, decision);
      return decision;
    }

    // Promotion rules check.
    const verdict = shouldPromote(candidate, { trust, confidence, importance });
    if (!verdict.ok) {
      const decision: PromotionDecision = {
        decision: 'rejected',
        reason: verdict.reason,
        score: importance,
      };
      this.#writeAuditRow(workspaceId, args, candidate, decision);
      return decision;
    }

    // Dedupe / contradiction check.
    const findArgs: { workspaceId: string; appId?: string | null; type?: string; title: string; summary: string } = {
      workspaceId,
      title: candidate.title,
      summary: candidate.summary,
    };
    if (args.appId !== undefined) findArgs.appId = args.appId;
    findArgs.type = candidate.type;
    const similar = this.episodes.findSimilar(workspaceId, findArgs, 0.75);

    if (similar.length > 0) {
      const match = similar[0]!;
      // Contradiction check: if outcomes disagree and the existing trust is
      // higher, mark new as superseded; if the new is more trusted, supersede the old.
      const newOutcome = candidate.outcomeStatus ?? null;
      const oldOutcome = match.outcomeStatus ?? null;
      const contradicts = newOutcome && oldOutcome && newOutcome !== oldOutcome;

      if (contradicts) {
        // Resolve by trust.
        if (trust > match.trust + 0.1) {
          // New is more trusted — supersede the old.
          const newEpisode = this.episodes.write(
            buildCreateInput(args, candidate, source, { trust, confidence, importance }),
          );
          this.episodes.supersede(workspaceId, match.id, newEpisode.id);
          const decision: PromotionDecision = {
            decision: 'superseded',
            reason: verdict.reason,
            episode: newEpisode,
            matchedEpisode: match,
            score: importance,
            notes: `superseded existing episode '${match.id}' due to contradicting outcome and higher trust`,
          };
          this.#writeAuditRow(workspaceId, args, candidate, decision);
          return decision;
        } else {
          // Existing is more trusted — reject the new candidate.
          const decision: PromotionDecision = {
            decision: 'rejected',
            reason: 'low_confidence',
            matchedEpisode: match,
            score: trust,
            notes: `contradicts higher-trust existing episode '${match.id}'`,
          };
          this.#writeAuditRow(workspaceId, args, candidate, decision);
          return decision;
        }
      }

      // Compatible duplicate → merge by reinforcing the existing episode.
      const reinforced = this.episodes.reinforce(workspaceId, match.id, {
        confidenceDelta: 0.05,
        trustDelta: 0.03,
        importanceDelta: 0.02,
      });
      const decision: PromotionDecision = {
        decision: 'merged',
        reason: 'duplicate',
        ...(reinforced ? { episode: reinforced } : {}),
        matchedEpisode: match,
        score: importance,
        notes: `merged into existing episode '${match.id}'`,
      };
      this.#writeAuditRow(workspaceId, args, candidate, decision);
      return decision;
    }

    // Write a new episode.
    const newEpisode = this.episodes.write(
      buildCreateInput(args, candidate, source, { trust, confidence, importance }),
    );

    const decision: PromotionDecision = {
      decision: 'promoted',
      reason: verdict.reason,
      episode: newEpisode,
      score: importance,
    };
    this.#writeAuditRow(workspaceId, args, candidate, decision);

    this.logger.info('memory.promotion.promoted', {
      workspaceId,
      appId: args.appId ?? null,
      runId: args.runId ?? null,
      episodeId: newEpisode.id,
      reason: verdict.reason,
      type: candidate.type,
      trust, confidence, importance,
    });

    return decision;
  }

  // ────────────────────────────────────────────────────────────
  // Batch API — promote everything from a run
  // ────────────────────────────────────────────────────────────

  /**
   * Promote a batch of candidates extracted from a single run.
   *
   * Returns a summary so the run summary UI can show "N lessons learned, M rejected, K merged".
   */
  promoteFromRun(args: PromoteFromRunArgs): {
    promoted: number;
    merged: number;
    superseded: number;
    rejected: number;
    decisions: PromotionDecision[];
  } {
    const decisions: PromotionDecision[] = [];
    let promoted = 0, merged = 0, superseded = 0, rejected = 0;
    for (const candidate of args.candidates) {
      const promoteArgs: PromoteCandidateArgs = {
        workspaceId: args.workspaceId,
        runId: args.runId,
        candidate,
      };
      if (args.appId !== undefined) promoteArgs.appId = args.appId;
      if (args.workflowId !== undefined) promoteArgs.workflowId = args.workflowId;
      const d = this.promoteCandidate(promoteArgs);
      decisions.push(d);
      if (d.decision === 'promoted') promoted++;
      else if (d.decision === 'merged') merged++;
      else if (d.decision === 'superseded') superseded++;
      else rejected++;
    }
    this.logger.info('memory.promotion.batch_complete', {
      workspaceId: args.workspaceId,
      runId: args.runId,
      total: args.candidates.length,
      promoted, merged, superseded, rejected,
    });
    return { promoted, merged, superseded, rejected, decisions };
  }

  // ────────────────────────────────────────────────────────────
  // Audit trail read API
  // ────────────────────────────────────────────────────────────

  /** List recent promotion events for an app/workspace. */
  listEvents(args: {
    workspaceId: string;
    appId?: string;
    runId?: string;
    limit?: number;
  }): MemoryPromotionEvent[] {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
    const conds = [eq(schema.memoryPromotionEvents.workspaceId, args.workspaceId)];
    if (args.appId) conds.push(eq(schema.memoryPromotionEvents.appId, args.appId));
    if (args.runId) conds.push(eq(schema.memoryPromotionEvents.runId, args.runId));
    const rows = this.db.select().from(schema.memoryPromotionEvents)
      .where(and(...conds))
      .orderBy(sql`${schema.memoryPromotionEvents.createdAt} DESC`)
      .limit(limit)
      .all();
    return rows.map(rowToEvent);
  }

  /** Stats summary for the dashboard. */
  statsByApp(workspaceId: string, appId: string): { byDecision: Record<string, number>; total: number } {
    const rows = this.db.select({
      decision: schema.memoryPromotionEvents.decision,
      count: sql<number>`count(*)`,
    })
      .from(schema.memoryPromotionEvents)
      .where(
        and(
          eq(schema.memoryPromotionEvents.workspaceId, workspaceId),
          eq(schema.memoryPromotionEvents.appId, appId),
        ),
      )
      .groupBy(schema.memoryPromotionEvents.decision)
      .all();
    let total = 0;
    const byDecision: Record<string, number> = {};
    for (const r of rows) {
      const c = Number(r.count) || 0;
      byDecision[r.decision] = c;
      total += c;
    }
    return { byDecision, total };
  }

  // ────────────────────────────────────────────────────────────
  // Internal: audit row writer
  // ────────────────────────────────────────────────────────────

  #writeAuditRow(
    workspaceId: string,
    args: PromoteCandidateArgs | PromoteFromRunArgs,
    candidate: PromotionCandidate,
    decision: PromotionDecision,
  ): void {
    try {
      this.db.insert(schema.memoryPromotionEvents).values({
        id: randomUUID(),
        workspaceId,
        appId: ('appId' in args ? args.appId : null) ?? null,
        runId: ('runId' in args ? args.runId : null) ?? null,
        candidateTitle: candidate.title,
        candidatePayload: {
          type: candidate.type,
          summary: candidate.summary,
          details: candidate.details,
          tags: candidate.tags,
          entities: candidate.entities,
          metadata: candidate.metadata,
          signals: candidate.signals,
        },
        candidateSource: candidate.source,
        decision: decision.decision,
        reason: decision.reason,
        episodeId: decision.episode?.id ?? null,
        score: String(decision.score),
        notes: decision.notes ?? null,
        createdAt: new Date().toISOString(),
      }).run();
    } catch (err) {
      // Never fail a promotion because the audit write failed.
      this.logger.warn('memory.promotion.audit_failed', {
        message: (err as Error).message,
        workspaceId,
        decision: decision.decision,
      });
    }
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function buildCreateInput(
  args: PromoteCandidateArgs,
  candidate: PromotionCandidate,
  source: ReturnType<typeof mapCandidateToEpisodeSource>,
  scores: { trust: number; confidence: number; importance: number },
): CreateRuntimeEpisodeInput {
  const input: CreateRuntimeEpisodeInput = {
    workspaceId: args.workspaceId,
    type: candidate.type,
    title: candidate.title,
    summary: candidate.summary,
    source,
    confidence: scores.confidence,
    importance: scores.importance,
    trust: scores.trust,
  };
  if (args.appId !== undefined) input.appId = args.appId;
  if (args.workflowId !== undefined) input.workflowId = args.workflowId;
  if (args.runId !== undefined) input.runId = args.runId;
  if (args.agentId !== undefined) input.agentId = args.agentId;
  if (candidate.details !== undefined) input.details = candidate.details;
  if (candidate.tags !== undefined) input.tags = candidate.tags;
  if (candidate.entities !== undefined) input.entities = candidate.entities;
  if (candidate.outcomeStatus !== undefined) input.outcomeStatus = candidate.outcomeStatus;
  if (candidate.metadata !== undefined) input.metadata = candidate.metadata;
  return input;
}

function mapCandidateToEpisodeSource(s: PromotionCandidateSource):
  | 'run_promotion'
  | 'agent_write'
  | 'operator_write'
  | 'evaluator_write'
  | 'system_write' {
  switch (s) {
    case 'operator_distillation': return 'operator_write';
    case 'agent_proposal':        return 'agent_write';
    case 'evaluator_failure_summary': return 'evaluator_write';
    case 'approval_rationale':    return 'operator_write';
    case 'replay_root_cause':
    case 'tool_failure_pattern':
    case 'winning_output_pattern':
    case 'final_artifact_validation':
      return 'run_promotion';
  }
}

function rowToEvent(row: typeof schema.memoryPromotionEvents.$inferSelect): MemoryPromotionEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    appId: row.appId,
    runId: row.runId,
    candidateTitle: row.candidateTitle,
    candidatePayload: parseJsonRecord(row.candidatePayload),
    candidateSource: row.candidateSource as MemoryPromotionEvent['candidateSource'],
    decision: row.decision as MemoryPromotionEvent['decision'],
    reason: row.reason as MemoryPromotionEvent['reason'],
    episodeId: row.episodeId,
    score: Number(row.score) || 0,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}

