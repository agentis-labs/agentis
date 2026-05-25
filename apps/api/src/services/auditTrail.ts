/**
 * AuditTrailService — the sacred audit trail (§5.4, Principle #7).
 *
 * Every action in a workflow run is attributed, timestamped, and inspectable:
 * node started/completed/failed, run lifecycle, human-gate decisions, artifacts.
 * Powers `GET /v1/runs/:runId/audit`. Best-effort: an audit write must never
 * break a run, so the engine calls `record()` fire-and-forget and swallows errors.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';

export interface AuditRecordInput {
  workspaceId: string;
  runId: string;
  phaseId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  action: string;
  actorType: 'agent' | 'user' | 'system' | 'scheduler';
  actorId: string;
  inputSummary?: string | null;
  outputSummary?: string | null;
  costCents?: number | null;
}

export class AuditTrailService {
  constructor(private readonly db: AgentisSqliteDb, private readonly logger?: Logger) {}

  /** Append one audit entry. Never throws — failures are logged, not propagated. */
  record(entry: AuditRecordInput): void {
    try {
      this.db.insert(schema.auditEntries).values({
        id: randomUUID(),
        workspaceId: entry.workspaceId,
        runId: entry.runId,
        phaseId: entry.phaseId ?? null,
        nodeId: entry.nodeId ?? null,
        agentId: entry.agentId ?? null,
        action: entry.action,
        actorType: entry.actorType,
        actorId: entry.actorId,
        inputSummary: clip(entry.inputSummary),
        outputSummary: clip(entry.outputSummary),
        costCents: entry.costCents ?? null,
        at: new Date().toISOString(),
      }).run();
    } catch (err) {
      this.logger?.warn('audit.record_failed', { runId: entry.runId, action: entry.action, err: (err as Error).message });
    }
  }

  /**
   * Total cost (cents) attributed to a workspace since an ISO timestamp.
   * Powers the workspace/day budget ceiling (§5.3). Best-effort: returns 0 on error.
   */
  workspaceSpendSince(workspaceId: string, sinceIso: string): number {
    try {
      const row = this.db
        .select({ total: sql<number>`COALESCE(SUM(${schema.auditEntries.costCents}), 0)` })
        .from(schema.auditEntries)
        .where(and(eq(schema.auditEntries.workspaceId, workspaceId), gte(schema.auditEntries.at, sinceIso)))
        .get();
      return row?.total ?? 0;
    } catch (err) {
      this.logger?.warn('audit.spend_query_failed', { workspaceId, err: (err as Error).message });
      return 0;
    }
  }

  list(workspaceId: string, runId: string) {
    return this.db
      .select()
      .from(schema.auditEntries)
      .where(and(eq(schema.auditEntries.workspaceId, workspaceId), eq(schema.auditEntries.runId, runId)))
      .orderBy(asc(schema.auditEntries.at))
      .all();
  }
}

/** Compress a value to a short preview string for the audit log. */
function clip(value: string | null | undefined, max = 280): string | null {
  if (value == null) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
