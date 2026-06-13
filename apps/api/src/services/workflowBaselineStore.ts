/**
 * WorkflowBaselineStore — per-workflow rolling baselines.
 *
 *
 * Stores `workflow_baselines`: one snapshot per `(scope_id, workflow_id)`
 * version, scoped to the workspace.
 *
 * Each call to `seedFromManifest()` writes one row with `source: 'seed'`.
 * `recordDerived()` writes one row with `source: 'derived'` after a
 * promotion job has aggregated N successful runs.
 *
 * Reads always pick the most recent row per workflow id (the active baseline).
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowBaselineSnapshot } from '@agentis/core';

export interface BaselineWriteInput {
  workspaceId: string;
  scopeId: string;
  workflowId: string;
  source: WorkflowBaselineSnapshot['source'];
  p50DurationMs?: number;
  p95DurationMs?: number;
  successRate?: number;
  costCentsPerRun?: number;
  sampleSize?: number;
  windowStart?: string;
  windowEnd?: string;
}

export class WorkflowBaselineStore {
  constructor(private readonly db: AgentisSqliteDb) {}

  write(input: BaselineWriteInput): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .insert(schema.workflowBaselines)
      .values({
        id,
        workspaceId: input.workspaceId,
        scopeId: input.scopeId,
        workflowId: input.workflowId,
        source: input.source,
        p50DurationMs: input.p50DurationMs ?? null,
        p95DurationMs: input.p95DurationMs ?? null,
        successRate: input.successRate !== undefined ? String(clamp01(input.successRate)) : null,
        costCentsPerRun: input.costCentsPerRun ?? null,
        sampleSize: input.sampleSize ?? 0,
        windowStart: input.windowStart ?? now,
        windowEnd: input.windowEnd ?? now,
        capturedAt: now,
      })
      .run();
    return id;
  }

  /** Latest baseline per workflow id. */
  latest(workspaceId: string, scopeId: string, workflowId: string): WorkflowBaselineSnapshot | null {
    const row = this.db
      .select()
      .from(schema.workflowBaselines)
      .where(
        and(
          eq(schema.workflowBaselines.workspaceId, workspaceId),
          eq(schema.workflowBaselines.scopeId, scopeId),
          eq(schema.workflowBaselines.workflowId, workflowId),
        ),
      )
      .orderBy(desc(schema.workflowBaselines.capturedAt))
      .limit(1)
      .get();
    return row ? rowToSnapshot(row) : null;
  }

  /** All workflow baselines for a workspace — latest only. */
  latestForScope(workspaceId: string, scopeId: string): WorkflowBaselineSnapshot[] {
    // Pull all rows then collapse by workflow id keeping the newest.
    const rows = this.db
      .select()
      .from(schema.workflowBaselines)
      .where(
        and(
          eq(schema.workflowBaselines.workspaceId, workspaceId),
          eq(schema.workflowBaselines.scopeId, scopeId),
        ),
      )
      .orderBy(desc(schema.workflowBaselines.capturedAt))
      .all();
    const seen = new Set<string>();
    const out: WorkflowBaselineSnapshot[] = [];
    for (const r of rows) {
      if (seen.has(r.workflowId)) continue;
      seen.add(r.workflowId);
      out.push(rowToSnapshot(r));
    }
    return out;
  }

  countByScope(workspaceId: string, scopeId: string): number {
    const rows = this.db
      .select({ workflowId: schema.workflowBaselines.workflowId })
      .from(schema.workflowBaselines)
      .where(
        and(
          eq(schema.workflowBaselines.workspaceId, workspaceId),
          eq(schema.workflowBaselines.scopeId, scopeId),
        ),
      )
      .all();
    return new Set(rows.map((r) => r.workflowId)).size;
  }

}

function rowToSnapshot(row: typeof schema.workflowBaselines.$inferSelect): WorkflowBaselineSnapshot {
  const out: WorkflowBaselineSnapshot = {
    id: row.id,
    workspaceId: row.workspaceId,
    scopeId: row.scopeId,
    workflowId: row.workflowId,
    source: row.source as WorkflowBaselineSnapshot['source'],
    sampleSize: row.sampleSize,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    capturedAt: row.capturedAt,
  };
  if (row.p50DurationMs !== null) out.p50DurationMs = row.p50DurationMs;
  if (row.p95DurationMs !== null) out.p95DurationMs = row.p95DurationMs;
  if (row.successRate !== null) out.successRate = Number(row.successRate);
  if (row.costCentsPerRun !== null) out.costCentsPerRun = row.costCentsPerRun;
  return out;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
