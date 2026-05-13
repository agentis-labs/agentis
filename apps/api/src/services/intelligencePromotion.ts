/**
 * IntelligencePromotion — Class 4 promotion engine.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §8.
 *
 * Owns the `app_promoted_patterns` table. The architecture rule (§8.4):
 *
 *   "This layer must be promoted, not dumped. Raw history is not the wedge.
 *    Distilled reusable intelligence is the wedge."
 *
 * Promotion sources (§8.3):
 *   - run outcomes        — finished workflow runs (success/failure)
 *   - approval decisions  — operator-confirmed actions
 *   - evaluator verdicts  — schema/rule/rubric/llm pass/fail
 *   - replay outcomes     — re-runs that confirmed a fix
 *   - operator annotations — manual "remember this" actions
 *
 * Two write paths:
 *
 *   1. `promote()` — first occurrence; creates a row at confidence 0.5,
 *      evidence_count 1.
 *   2. `reinforce()` — subsequent occurrence of the same kind+title; bumps
 *      confidence (capped at 0.97 so nothing claims certainty), bumps
 *      evidence count, updates `reinforced_at` and `provenance.lastEvidence`.
 *
 * The promotion engine ALSO writes selected patterns into `app_memory` so
 * they surface in the recall path. Specifically:
 *   - `business_rule` and `recurring_exception` become memory of kind 'rule'
 *   - `approved_output_pattern` becomes memory of kind 'pattern'
 * Other kinds stay only in `app_promoted_patterns` to keep memory small.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { PromotedPattern, PromotionInput } from '@agentis/core';
import type { Logger } from '../logger.js';
import type { AppMemoryStore } from './appMemoryStore.js';

/** Configuration knobs (all 0..1 unless noted). */
export interface PromotionPolicy {
  /** Confidence at first promotion. Default 0.5. */
  initialConfidence: number;
  /** Per-reinforcement confidence bump. Default 0.07. */
  reinforcementDelta: number;
  /** Hard cap so promotion never claims certainty. Default 0.97. */
  maxConfidence: number;
  /** Minimum confidence to mirror into `app_memory`. Default 0.7. */
  memoryMirrorConfidence: number;
}

const DEFAULT_POLICY: PromotionPolicy = {
  initialConfidence: 0.5,
  reinforcementDelta: 0.07,
  maxConfidence: 0.97,
  memoryMirrorConfidence: 0.7,
};

export class IntelligencePromotion {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly memory: AppMemoryStore,
    private readonly logger: Logger,
    private readonly policy: PromotionPolicy = DEFAULT_POLICY,
  ) {}

  /**
   * Promote a new pattern OR reinforce an existing one. Returns the
   * resulting persisted pattern. Idempotent on `(appId, kind, title)`.
   */
  promoteOrReinforce(input: PromotionInput): PromotedPattern {
    const existing = this.#findExisting(input.workspaceId, input.appId, input.kind, input.title);
    if (existing) {
      return this.#reinforce(existing, input);
    }
    return this.#create(input);
  }

  /** Read a list of patterns for an app — used by routes and runtime. */
  list(args: {
    workspaceId: string;
    appId: string;
    kind?: PromotedPattern['kind'];
    limit?: number;
  }): PromotedPattern[] {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = this.db
      .select()
      .from(schema.appPromotedPatterns)
      .where(
        and(
          eq(schema.appPromotedPatterns.workspaceId, args.workspaceId),
          eq(schema.appPromotedPatterns.appId, args.appId),
          ...(args.kind ? [eq(schema.appPromotedPatterns.kind, args.kind)] : []),
        ),
      )
      .orderBy(desc(schema.appPromotedPatterns.reinforcedAt))
      .limit(limit)
      .all();
    return rows.map(rowToPattern);
  }

  byId(workspaceId: string, id: string): PromotedPattern | null {
    const row = this.db
      .select()
      .from(schema.appPromotedPatterns)
      .where(
        and(
          eq(schema.appPromotedPatterns.workspaceId, workspaceId),
          eq(schema.appPromotedPatterns.id, id),
        ),
      )
      .get();
    return row ? rowToPattern(row) : null;
  }

  delete(workspaceId: string, id: string): boolean {
    const result = this.db
      .delete(schema.appPromotedPatterns)
      .where(
        and(
          eq(schema.appPromotedPatterns.workspaceId, workspaceId),
          eq(schema.appPromotedPatterns.id, id),
        ),
      )
      .run();
    return result.changes > 0;
  }

  /**
   * Demote — operator action: drops confidence by `delta` (default 0.2).
   * If confidence falls below 0.1, the pattern is deleted entirely so it
   * doesn't keep surfacing in retrieval.
   */
  demote(workspaceId: string, id: string, delta = 0.2): PromotedPattern | null {
    const pattern = this.byId(workspaceId, id);
    if (!pattern) return null;
    const next = clamp01(pattern.confidence - delta);
    if (next < 0.1) {
      this.delete(workspaceId, id);
      return null;
    }
    const now = new Date().toISOString();
    this.db
      .update(schema.appPromotedPatterns)
      .set({ confidence: String(next), updatedAt: now })
      .where(eq(schema.appPromotedPatterns.id, id))
      .run();
    return { ...pattern, confidence: next, updatedAt: now };
  }

  countByApp(workspaceId: string, appId: string): number {
    const rows = this.db
      .select({ id: schema.appPromotedPatterns.id })
      .from(schema.appPromotedPatterns)
      .where(
        and(
          eq(schema.appPromotedPatterns.workspaceId, workspaceId),
          eq(schema.appPromotedPatterns.appId, appId),
        ),
      )
      .all();
    return rows.length;
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  #findExisting(
    workspaceId: string,
    appId: string,
    kind: PromotedPattern['kind'],
    title: string,
  ): PromotedPattern | null {
    const rows = this.db
      .select()
      .from(schema.appPromotedPatterns)
      .where(
        and(
          eq(schema.appPromotedPatterns.workspaceId, workspaceId),
          eq(schema.appPromotedPatterns.appId, appId),
          eq(schema.appPromotedPatterns.kind, kind),
          eq(schema.appPromotedPatterns.title, title),
        ),
      )
      .limit(1)
      .all();
    return rows[0] ? rowToPattern(rows[0]) : null;
  }

  #create(input: PromotionInput): PromotedPattern {
    const id = randomUUID();
    const now = new Date().toISOString();
    const confidence = clamp01(
      input.confidenceHint ?? this.policy.initialConfidence,
      this.policy.maxConfidence,
    );
    const provenance = {
      ...input.provenance,
      firstSeenAt: now,
      lastEvidenceAt: now,
    };
    this.db
      .insert(schema.appPromotedPatterns)
      .values({
        id,
        workspaceId: input.workspaceId,
        appId: input.appId,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        payload: input.payload,
        confidence: String(confidence),
        trust: '0.8',
        evidenceCount: 1,
        provenance,
        reinforcedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const pattern: PromotedPattern = {
      id,
      workspaceId: input.workspaceId,
      appId: input.appId,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      payload: input.payload,
      confidence,
      trust: 0.8,
      evidenceCount: 1,
      provenance,
      reinforcedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.#mirrorToMemoryIfEligible(pattern);

    this.logger.info('promotion.created', {
      workspaceId: input.workspaceId,
      appId: input.appId,
      kind: input.kind,
      title: input.title,
      confidence,
    });
    return pattern;
  }

  #reinforce(existing: PromotedPattern, input: PromotionInput): PromotedPattern {
    const now = new Date().toISOString();
    const nextConfidence = Math.min(
      this.policy.maxConfidence,
      existing.confidence + this.policy.reinforcementDelta,
    );
    const nextEvidence = existing.evidenceCount + 1;
    const provenance = {
      ...existing.provenance,
      ...input.provenance,
      lastEvidenceAt: now,
    };
    this.db
      .update(schema.appPromotedPatterns)
      .set({
        confidence: String(nextConfidence),
        evidenceCount: nextEvidence,
        provenance,
        // Update summary if the new one is longer (heuristic: more detail = better).
        summary:
          input.summary.length > existing.summary.length ? input.summary : existing.summary,
        reinforcedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.appPromotedPatterns.id, existing.id))
      .run();
    const next: PromotedPattern = {
      ...existing,
      confidence: nextConfidence,
      evidenceCount: nextEvidence,
      summary:
        input.summary.length > existing.summary.length ? input.summary : existing.summary,
      provenance,
      reinforcedAt: now,
      updatedAt: now,
    };

    this.#mirrorToMemoryIfEligible(next);

    this.logger.info('promotion.reinforced', {
      workspaceId: input.workspaceId,
      appId: input.appId,
      patternId: existing.id,
      confidence: nextConfidence,
      evidence: nextEvidence,
    });
    return next;
  }

  /**
   * Mirror selected patterns into `app_memory` so they surface during
   * memory recall. Only crosses the threshold once per pattern: we use
   * a deterministic title prefix (`[promoted] ...`) so we can find and
   * update the same memory row on reinforcement.
   */
  #mirrorToMemoryIfEligible(pattern: PromotedPattern): void {
    if (pattern.confidence < this.policy.memoryMirrorConfidence) return;

    const memoryKind = mapPatternKindToMemoryKind(pattern.kind);
    if (memoryKind === null) return;

    // We re-use the AppMemoryStore but bypass `write` on reinforcement so we
    // don't duplicate. AppMemoryStore.list with title filter is good enough
    // since titles are short and the per-app row count is small.
    const mirroredTitle = `[promoted] ${pattern.title}`;
    const candidates = this.memory.list({
      workspaceId: pattern.workspaceId,
      appId: pattern.appId,
      source: 'promotion',
      limit: 200,
    });
    const existing = candidates.find((m) => m.title === mirroredTitle);
    if (existing) {
      this.memory.update(pattern.workspaceId, existing.id, {
        title: mirroredTitle,
        content: pattern.summary,
        trust: pattern.trust,
        importance: Math.min(0.9, 0.5 + pattern.confidence * 0.4),
      });
      return;
    }

    this.memory.write({
      workspaceId: pattern.workspaceId,
      appId: pattern.appId,
      kind: memoryKind,
      source: 'promotion',
      title: mirroredTitle,
      content: pattern.summary,
      trust: pattern.trust,
      importance: Math.min(0.9, 0.5 + pattern.confidence * 0.4),
      provenance: {
        kind: 'promoted_pattern_mirror',
        patternId: pattern.id,
        patternKind: pattern.kind,
      },
    });
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function rowToPattern(row: typeof schema.appPromotedPatterns.$inferSelect): PromotedPattern {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    appId: row.appId,
    kind: row.kind as PromotedPattern['kind'],
    title: row.title,
    summary: row.summary,
    payload: parseJsonRecord(row.payload),
    confidence: Number(row.confidence),
    trust: Number(row.trust),
    evidenceCount: row.evidenceCount,
    provenance: parseJsonRecord(row.provenance),
    reinforcedAt: row.reinforcedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function clamp01(n: number, max = 1): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > max) return max;
  return n;
}

function mapPatternKindToMemoryKind(
  kind: PromotedPattern['kind'],
): 'rule' | 'pattern' | 'lesson' | null {
  switch (kind) {
    case 'business_rule':
    case 'recurring_exception':
      return 'rule';
    case 'approved_output_pattern':
      return 'pattern';
    case 'failure_with_fix':
      return 'lesson';
    case 'successful_playbook':
      return null; // playbooks live only in promoted_patterns to keep memory small
    default:
      return null;
  }
}
