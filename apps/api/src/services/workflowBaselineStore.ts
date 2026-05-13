/**
 * WorkflowBaselineStore — per-workflow rolling baselines.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §11.6.
 *
 * Stores `workflow_baselines`: one snapshot per `(app_id, workflow_id)`
 * version, distinct from the cross-app `app_baseline_snapshots` (Plane 8).
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
  appId: string;
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
        appId: input.appId,
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
  latest(workspaceId: string, appId: string, workflowId: string): WorkflowBaselineSnapshot | null {
    const row = this.db
      .select()
      .from(schema.workflowBaselines)
      .where(
        and(
          eq(schema.workflowBaselines.workspaceId, workspaceId),
          eq(schema.workflowBaselines.appId, appId),
          eq(schema.workflowBaselines.workflowId, workflowId),
        ),
      )
      .orderBy(desc(schema.workflowBaselines.capturedAt))
      .limit(1)
      .get();
    return row ? rowToSnapshot(row) : null;
  }

  /** All workflow baselines for an app — latest only. */
  latestForApp(workspaceId: string, appId: string): WorkflowBaselineSnapshot[] {
    // Pull all rows then collapse by workflow id keeping the newest.
    const rows = this.db
      .select()
      .from(schema.workflowBaselines)
      .where(
        and(
          eq(schema.workflowBaselines.workspaceId, workspaceId),
          eq(schema.workflowBaselines.appId, appId),
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

  countByApp(workspaceId: string, appId: string): number {
    const rows = this.db
      .select({ workflowId: schema.workflowBaselines.workflowId })
      .from(schema.workflowBaselines)
      .where(
        and(
          eq(schema.workflowBaselines.workspaceId, workspaceId),
          eq(schema.workflowBaselines.appId, appId),
        ),
      )
      .all();
    return new Set(rows.map((r) => r.workflowId)).size;
  }

  deleteForApp(workspaceId: string, appId: string, source?: WorkflowBaselineSnapshot['source']): number {
    const where = source
      ? and(
          eq(schema.workflowBaselines.workspaceId, workspaceId),
          eq(schema.workflowBaselines.appId, appId),
          eq(schema.workflowBaselines.source, source),
        )
      : and(
          eq(schema.workflowBaselines.workspaceId, workspaceId),
          eq(schema.workflowBaselines.appId, appId),
        );
    return this.db.delete(schema.workflowBaselines).where(where).run().changes;
  }
}

function rowToSnapshot(row: typeof schema.workflowBaselines.$inferSelect): WorkflowBaselineSnapshot {
  const out: WorkflowBaselineSnapshot = {
    id: row.id,
    workspaceId: row.workspaceId,
    appId: row.appId,
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
