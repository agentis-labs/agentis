/**
 * turnStateStore — AGENT-FIRST-ARCHITECTURE.md Plane 3.
 *
 * Externalises multi-turn agent_task state so the run-state JSON does not
 * bloat with raw transcripts. Each turn writes a compact row:
 *
 *   - turn_index            monotonic counter per (run, node)
 *   - summary               compact working-memory blob for the next turn
 *   - payload               last response, tool results, evaluator status
 *   - blockers              active escalation triggers
 *   - cost_cents            tokens / model-tier cost incurred this turn
 *
 * The engine reads the latest turn before dispatching the next iteration;
 * the inspector tools read this table to render turn-by-turn detail.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { TurnStateRecord } from '@agentis/core';

export interface AppendTurnArgs {
  workspaceId: string;
  runId: string;
  nodeId: string;
  summary?: string | null;
  payload?: Record<string, unknown>;
  blockers?: string[];
  costCents?: number;
}

export class TurnStateStore {
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Append a new turn. Returns the new turn record. */
  append(args: AppendTurnArgs): TurnStateRecord {
    const last = this.db
      .select({ turnIndex: schema.turnState.turnIndex })
      .from(schema.turnState)
      .where(
        and(
          eq(schema.turnState.runId, args.runId),
          eq(schema.turnState.nodeId, args.nodeId),
        ),
      )
      .orderBy(desc(schema.turnState.turnIndex))
      .limit(1)
      .get();
    const nextIndex = (last?.turnIndex ?? -1) + 1;
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const record: TurnStateRecord = {
      runId: args.runId,
      nodeId: args.nodeId,
      turnIndex: nextIndex,
      summary: args.summary ?? null,
      payload: args.payload ?? {},
      blockers: args.blockers ?? [],
      costCents: args.costCents ?? 0,
      createdAt,
    };
    this.db
      .insert(schema.turnState)
      .values({
        id,
        workspaceId: args.workspaceId,
        runId: args.runId,
        nodeId: args.nodeId,
        turnIndex: nextIndex,
        summary: record.summary,
        payload: record.payload,
        blockers: record.blockers,
        costCents: record.costCents,
        createdAt,
      })
      .run();
    return record;
  }

  /** Latest turn for a (run, node) pair, or null. */
  latest(runId: string, nodeId: string): TurnStateRecord | null {
    const row = this.db
      .select()
      .from(schema.turnState)
      .where(and(eq(schema.turnState.runId, runId), eq(schema.turnState.nodeId, nodeId)))
      .orderBy(desc(schema.turnState.turnIndex))
      .limit(1)
      .get();
    if (!row) return null;
    return this.#fromRow(row);
  }

  /** Full history for a (run, node) pair in chronological order. */
  history(runId: string, nodeId: string): TurnStateRecord[] {
    const rows = this.db
      .select()
      .from(schema.turnState)
      .where(and(eq(schema.turnState.runId, runId), eq(schema.turnState.nodeId, nodeId)))
      .all();
    return rows
      .sort((a, b) => a.turnIndex - b.turnIndex)
      .map((r) => this.#fromRow(r));
  }

  /** Current turn count for a (run, node). */
  count(runId: string, nodeId: string): number {
    const row = this.db
      .select({ c: sql<number>`count(*)` })
      .from(schema.turnState)
      .where(and(eq(schema.turnState.runId, runId), eq(schema.turnState.nodeId, nodeId)))
      .get();
    return row?.c ?? 0;
  }

  /** Total cost for the entire run. Used by the cost compiler / inspector. */
  costForRun(runId: string): number {
    const rows = this.db
      .select({ cost: schema.turnState.costCents })
      .from(schema.turnState)
      .where(eq(schema.turnState.runId, runId))
      .all();
    return rows.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  }

  #fromRow(row: typeof schema.turnState.$inferSelect): TurnStateRecord {
    return {
      runId: row.runId,
      nodeId: row.nodeId,
      turnIndex: row.turnIndex,
      summary: row.summary,
      payload: (row.payload as Record<string, unknown>) ?? {},
      blockers: (row.blockers as string[]) ?? [],
      costCents: row.costCents ?? 0,
      createdAt: row.createdAt,
    };
  }
}
