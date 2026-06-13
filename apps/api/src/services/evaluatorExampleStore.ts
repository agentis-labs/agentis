/**
 * EvaluatorExampleStore — Class 3 of the Workspace Knowledge.
 *
 *
 * Owns the `evaluator_examples` table. Examples are "what good and bad
 * look like" — the runtime's calibration set for rubric-tier evaluators
 * and the source-of-truth for confidence reporting.
 *
 * Sources:
 *   seed       — packaged (`EvaluatorExampleSeed`)
 *   import     — operator dataset whose targetStore=evaluator_examples
 *   operator   — manually entered through the UI (Memory layer)
 *   promotion  — operator-confirmed run verdicts that crossed the bar
 *
 * The store DOES NOT do scoring or comparison — that's `EvaluatorRuntime`'s
 * job. It just persists, lists, and counts.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EvaluatorExample } from '@agentis/core';
import type { Logger } from '../logger.js';

export interface EvaluatorExampleWriteInput {
  workspaceId: string;
  scopeId: string;
  evaluatorKey: string;
  source: EvaluatorExample['source'];
  input: unknown;
  expected: unknown;
  verdict: EvaluatorExample['verdict'];
  score?: number;
  reason?: string;
  originRunId?: string | null;
}

export interface EvaluatorExampleListArgs {
  workspaceId: string;
  scopeId: string;
  evaluatorKey?: string;
  verdict?: EvaluatorExample['verdict'];
  source?: EvaluatorExample['source'];
  /** Default 50, max 500 (rubric tier may load all). */
  limit?: number;
}

export interface EvaluatorExampleUpdateInput {
  evaluatorKey?: string;
  input?: unknown;
  expected?: unknown;
  verdict?: EvaluatorExample['verdict'];
  score?: number | null;
  reason?: string | null;
}

/** Confidence summary surfaced in the the intelligence response. */
export interface EvaluatorConfidence {
  evaluatorKey: string;
  exampleCount: number;
  passCount: number;
  failCount: number;
  /** 0..1 — `passCount / max(1, exampleCount)`. NOT a quality score. */
  passRate: number;
  /**
   * 0..1 — calibration confidence: scales with sample size.
   * Heuristic: confidence = 1 - exp(-exampleCount / 10).
   * 1 example  ~ 0.10
   * 5 examples ~ 0.39
   * 10         ~ 0.63
   * 25         ~ 0.92
   * Independent of pass rate.
   */
  confidence: number;
}

export class EvaluatorExampleStore {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {
    void this.logger;
  }

  write(input: EvaluatorExampleWriteInput): string {
    const id = randomUUID();
    this.db
      .insert(schema.evaluatorExamples)
      .values({
        id,
        workspaceId: input.workspaceId,
        scopeId: input.scopeId,
        evaluatorKey: input.evaluatorKey,
        source: input.source,
        input: input.input as object,
        expected: input.expected as object,
        verdict: input.verdict,
        score: input.score !== undefined ? String(clamp01(input.score)) : null,
        reason: input.reason ?? null,
        originRunId: input.originRunId ?? null,
        createdAt: new Date().toISOString(),
      })
      .run();
    return id;
  }

  writeMany(inputs: EvaluatorExampleWriteInput[]): string[] {
    return inputs.map((i) => this.write(i));
  }

  delete(workspaceId: string, exampleId: string): boolean {
    const result = this.db
      .delete(schema.evaluatorExamples)
      .where(
        and(
          eq(schema.evaluatorExamples.workspaceId, workspaceId),
          eq(schema.evaluatorExamples.id, exampleId),
        ),
      )
      .run();
    return result.changes > 0;
  }

  update(
    workspaceId: string,
    scopeId: string,
    exampleId: string,
    patch: EvaluatorExampleUpdateInput,
  ): EvaluatorExample | null {
    const existing = this.db
      .select()
      .from(schema.evaluatorExamples)
      .where(
        and(
          eq(schema.evaluatorExamples.workspaceId, workspaceId),
          eq(schema.evaluatorExamples.scopeId, scopeId),
          eq(schema.evaluatorExamples.id, exampleId),
        ),
      )
      .get();
    if (!existing) return null;
    const next = {
      evaluatorKey: patch.evaluatorKey ?? existing.evaluatorKey,
      input: patch.input === undefined ? existing.input : (patch.input as object),
      expected: patch.expected === undefined ? existing.expected : (patch.expected as object),
      verdict: patch.verdict ?? existing.verdict,
      score: patch.score === undefined
        ? existing.score
        : patch.score === null
          ? null
          : String(clamp01(patch.score)),
      reason: patch.reason === undefined ? existing.reason : patch.reason,
    };
    this.db
      .update(schema.evaluatorExamples)
      .set(next)
      .where(
        and(
          eq(schema.evaluatorExamples.workspaceId, workspaceId),
          eq(schema.evaluatorExamples.scopeId, scopeId),
          eq(schema.evaluatorExamples.id, exampleId),
        ),
      )
      .run();
    return rowToExample({ ...existing, ...next });
  }

  deleteForExample(workspaceId: string, scopeId: string, exampleId: string): boolean {
    const result = this.db
      .delete(schema.evaluatorExamples)
      .where(
        and(
          eq(schema.evaluatorExamples.workspaceId, workspaceId),
          eq(schema.evaluatorExamples.scopeId, scopeId),
          eq(schema.evaluatorExamples.id, exampleId),
        ),
      )
      .run();
    return result.changes > 0;
  }

  list(args: EvaluatorExampleListArgs): EvaluatorExample[] {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
    const rows = this.db
      .select()
      .from(schema.evaluatorExamples)
      .where(
        and(
          eq(schema.evaluatorExamples.workspaceId, args.workspaceId),
          eq(schema.evaluatorExamples.scopeId, args.scopeId),
          ...(args.evaluatorKey
            ? [eq(schema.evaluatorExamples.evaluatorKey, args.evaluatorKey)]
            : []),
          ...(args.verdict ? [eq(schema.evaluatorExamples.verdict, args.verdict)] : []),
          ...(args.source ? [eq(schema.evaluatorExamples.source, args.source)] : []),
        ),
      )
      .orderBy(desc(schema.evaluatorExamples.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToExample);
  }

  /** Per-evaluator-key counts — feeds the intelligence response.evaluators. */
  confidenceForScope(workspaceId: string, scopeId: string): EvaluatorConfidence[] {
    const rows = this.db
      .select({
        evaluatorKey: schema.evaluatorExamples.evaluatorKey,
        verdict: schema.evaluatorExamples.verdict,
        count: sql<number>`count(*)`,
      })
      .from(schema.evaluatorExamples)
      .where(
        and(
          eq(schema.evaluatorExamples.workspaceId, workspaceId),
          eq(schema.evaluatorExamples.scopeId, scopeId),
        ),
      )
      .groupBy(schema.evaluatorExamples.evaluatorKey, schema.evaluatorExamples.verdict)
      .all();

    type Bucket = { pass: number; fail: number };
    const byKey = new Map<string, Bucket>();
    for (const r of rows) {
      const b = byKey.get(r.evaluatorKey) ?? { pass: 0, fail: 0 };
      const c = Number(r.count) || 0;
      if (r.verdict === 'pass') b.pass += c;
      else b.fail += c;
      byKey.set(r.evaluatorKey, b);
    }
    const out: EvaluatorConfidence[] = [];
    for (const [key, b] of byKey) {
      const exampleCount = b.pass + b.fail;
      const passRate = exampleCount > 0 ? b.pass / exampleCount : 0;
      const confidence = 1 - Math.exp(-exampleCount / 10);
      out.push({
        evaluatorKey: key,
        exampleCount,
        passCount: b.pass,
        failCount: b.fail,
        passRate,
        confidence,
      });
    }
    out.sort((a, b) => b.exampleCount - a.exampleCount);
    return out;
  }

  /** Total count for a workspace. */
  countByScope(workspaceId: string, scopeId: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.evaluatorExamples)
      .where(
        and(
          eq(schema.evaluatorExamples.workspaceId, workspaceId),
          eq(schema.evaluatorExamples.scopeId, scopeId),
        ),
      )
      .get();
    return Number(row?.count ?? 0);
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function rowToExample(
  row: typeof schema.evaluatorExamples.$inferSelect,
): EvaluatorExample {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scopeId: row.scopeId,
    evaluatorKey: row.evaluatorKey,
    source: row.source as EvaluatorExample['source'],
    input: row.input,
    expected: row.expected,
    verdict: row.verdict as EvaluatorExample['verdict'],
    score: row.score !== null ? Number(row.score) : undefined,
    reason: row.reason ?? undefined,
    originRunId: row.originRunId,
    createdAt: row.createdAt,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
