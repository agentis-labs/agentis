/**
 * RunCompactionService — keeps the workflow_runs / ledger_events tables
 * from growing unbounded by archiving the heavy JSON of old completed runs.
 *
 * Strategy:
 *   - On a daily cadence, scan `workflow_runs` rows older than
 *     `keepFullStateDays` (default 30) that finished in a terminal status
 *     (COMPLETED / COMPLETED_WITH_CONTRACT_VIOLATION / FAILED / CANCELLED).
 *   - For each, replace `runState` with a compact summary (status, completed
 *     and failed node ids, error if any) so the row keeps its history value
 *     without the multi-MB blob.
 *   - Delete ledger_events for runs older than `keepLedgerDays` (default 90).
 *
 * Pure background work — never blocks request handling and never touches
 * runs that are still active. Brain-apps will plug into the same service to
 * archive memory promotions older than its retention window.
 */

import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';

export interface RunCompactionOptions {
  db: AgentisSqliteDb;
  logger: Logger;
  /** Days of full runState to retain. Older completed runs get compacted. Default 30. */
  keepFullStateDays?: number;
  /** Days of ledger events to retain. Default 90. */
  keepLedgerDays?: number;
  /** How often to run the compaction pass. Default 24 hours. */
  intervalMs?: number;
  /** When true, schedule the first pass immediately on start(). Default false (one interval delay). */
  runOnStart?: boolean;
}

interface RunCompactionSummary {
  compactedRunStates: number;
  deletedLedgerRows: number;
  durationMs: number;
}

const TERMINAL_STATUSES = ['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'FAILED', 'CANCELLED'];

export class RunCompactionService {
  readonly #db: AgentisSqliteDb;
  readonly #logger: Logger;
  readonly #keepFullStateDays: number;
  readonly #keepLedgerDays: number;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | null = null;

  constructor(opts: RunCompactionOptions) {
    this.#db = opts.db;
    this.#logger = opts.logger;
    this.#keepFullStateDays = opts.keepFullStateDays ?? 30;
    this.#keepLedgerDays = opts.keepLedgerDays ?? 90;
    this.#intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;
    if (opts.runOnStart) {
      // Defer the very first pass so bootstrap can complete first.
      setTimeout(() => void this.compact().catch(() => {}), 5000);
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.compact().catch((err) => {
        this.#logger.warn('run_compaction.unhandled', { err: (err as Error).message });
      });
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** One-shot compaction pass. Returns counts so callers can log or assert. */
  async compact(): Promise<RunCompactionSummary> {
    const startedAt = Date.now();
    const stateCutoff = new Date(Date.now() - this.#keepFullStateDays * 24 * 60 * 60 * 1000).toISOString();
    const ledgerCutoff = new Date(Date.now() - this.#keepLedgerDays * 24 * 60 * 60 * 1000).toISOString();

    // 1) Compact runState of old terminal runs that haven't been compacted yet.
    //    "Already compacted" is detected by checking for the `_compacted: true`
    //    marker we write below, so we don't keep rewriting the same row.
    const candidates = this.#db
      .select({
        id: schema.workflowRuns.id,
        runState: schema.workflowRuns.runState,
        status: schema.workflowRuns.status,
      })
      .from(schema.workflowRuns)
      .where(
        and(
          inArray(schema.workflowRuns.status, TERMINAL_STATUSES),
          lte(schema.workflowRuns.updatedAt, stateCutoff),
        ),
      )
      .all();

    let compactedRunStates = 0;
    for (const row of candidates) {
      const state = row.runState as Record<string, unknown> | null;
      if (!state || state._compacted === true) continue;
      const compact = {
        _compacted: true,
        status: row.status,
        completedNodeIds: Array.isArray(state.completedNodeIds) ? state.completedNodeIds : [],
        failedNodeIds: Array.isArray(state.failedNodeIds) ? state.failedNodeIds : [],
        skippedNodeIds: Array.isArray(state.skippedNodeIds) ? state.skippedNodeIds : [],
        contractViolations: Array.isArray(state.contractViolations) ? state.contractViolations : undefined,
        compactedAt: new Date().toISOString(),
      };
      this.#db
        .update(schema.workflowRuns)
        .set({ runState: compact as unknown as object })
        .where(eq(schema.workflowRuns.id, row.id))
        .run();
      compactedRunStates += 1;
    }

    // 2) Delete ledger events whose run finished long ago. We key off the
    //    event's createdAt (cheaper) and let foreign-key cascade handle any
    //    orphans from already-deleted runs.
    const deletedLedger = this.#db
      .delete(schema.ledgerEvents)
      .where(
        and(
          isNotNull(schema.ledgerEvents.runId),
          lte(schema.ledgerEvents.createdAt, ledgerCutoff),
        ),
      )
      .run();
    const deletedLedgerRows = (deletedLedger as { changes?: number }).changes ?? 0;

    const summary = {
      compactedRunStates,
      deletedLedgerRows,
      durationMs: Date.now() - startedAt,
    };
    this.#logger.info('run_compaction.done', summary as unknown as Record<string, unknown>);
    return summary;
  }
}
