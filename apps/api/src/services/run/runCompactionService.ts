/**
 * Storage lifecycle for high-volume workflow history.
 *
 * Hot SQLite rows are bounded, but history is never silently discarded:
 * terminal run state, ledger events, and observability events are written to
 * checksum-protected gzip archives before hot rows are compacted/deleted.
 */
import { existsSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import { ColdArchiveStore, type ColdArchiveRef } from '../storage/coldArchiveStore.js';

export interface RunCompactionOptions {
  db: AgentisSqliteDb;
  logger: Logger;
  archiveStore?: ColdArchiveStore;
  dataDir?: string;
  /** Full terminal run state retained hot. Default 7 days. */
  keepFullStateDays?: number;
  /** Ledger rows retained hot. Default 30 days. */
  keepLedgerDays?: number;
  /** Observability rows retained hot. Default 14 days. */
  keepObservabilityDays?: number;
  /** Maintenance cadence. Default 6 hours. */
  intervalMs?: number;
  /** Soft hot-database budget. Default 2 GiB. */
  maxHotDbBytes?: number;
  /** Minimum free disk reserve. Default 2 GiB. */
  minFreeBytes?: number;
  /** Run a bounded pass shortly after boot. */
  runOnStart?: boolean;
  batchSize?: number;
  /** Checkpoint WAL / reclaim incremental-vacuum pages after successful archival. */
  reclaimStorage?: () => void;
}

export interface RunCompactionSummary {
  compactedRunStates: number;
  archivedRunStates: number;
  deletedSnapshots: number;
  archivedLedgerRows: number;
  deletedLedgerRows: number;
  archivedObservabilityRows: number;
  deletedObservabilityRows: number;
  pressureMode: boolean;
  dbBytes: number | null;
  freeBytes: number | null;
  durationMs: number;
}

const TERMINAL_STATUSES = ['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'];
const DAY_MS = 24 * 60 * 60 * 1000;

export class RunCompactionService {
  readonly #db: AgentisSqliteDb;
  readonly #logger: Logger;
  readonly #archive?: ColdArchiveStore;
  readonly #dataDir?: string;
  readonly #keepFullStateDays: number;
  readonly #keepLedgerDays: number;
  readonly #keepObservabilityDays: number;
  readonly #intervalMs: number;
  readonly #maxHotDbBytes: number;
  readonly #minFreeBytes: number;
  readonly #batchSize: number;
  readonly #reclaimStorage?: () => void;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(opts: RunCompactionOptions) {
    this.#db = opts.db;
    this.#logger = opts.logger;
    this.#archive = opts.archiveStore;
    this.#dataDir = opts.dataDir;
    this.#keepFullStateDays = nonNegative(opts.keepFullStateDays, 7);
    this.#keepLedgerDays = nonNegative(opts.keepLedgerDays, 30);
    this.#keepObservabilityDays = nonNegative(opts.keepObservabilityDays, 14);
    this.#intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000;
    this.#maxHotDbBytes = opts.maxHotDbBytes ?? 2 * 1024 ** 3;
    this.#minFreeBytes = opts.minFreeBytes ?? 2 * 1024 ** 3;
    this.#batchSize = Math.min(Math.max(opts.batchSize ?? 2_000, 100), 10_000);
    this.#reclaimStorage = opts.reclaimStorage;
    if (opts.runOnStart) {
      const timer = setTimeout(() => void this.compact().catch(() => {}), 5_000);
      timer.unref?.();
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.compact().catch((err) => {
      this.#logger.warn('run_compaction.unhandled', { err: (err as Error).message });
    }), this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async compact(): Promise<RunCompactionSummary> {
    if (this.#running) return emptySummary(false, null, null);
    this.#running = true;
    const startedAt = Date.now();
    try {
      const storage = this.#storagePressure();
      const pressureMode = storage.dbBytes !== null && storage.dbBytes >= this.#maxHotDbBytes
        || storage.freeBytes !== null && storage.freeBytes <= this.#minFreeBytes;
      // Under pressure, accelerate only operational history. Canonical data and
      // active runs are never touched.
      const stateDays = pressureMode ? Math.min(this.#keepFullStateDays, 1) : this.#keepFullStateDays;
      const ledgerDays = pressureMode ? Math.min(this.#keepLedgerDays, 7) : this.#keepLedgerDays;
      const observabilityDays = pressureMode ? Math.min(this.#keepObservabilityDays, 3) : this.#keepObservabilityDays;
      const now = Date.now();

      let archivedRunStates = 0;
      let compactedRunStates = 0;
      const stateCutoff = new Date(now - stateDays * DAY_MS).toISOString();
      const candidates = this.#db.select({
        id: schema.workflowRuns.id,
        workspaceId: schema.workflowRuns.workspaceId,
        status: schema.workflowRuns.status,
        runState: schema.workflowRuns.runState,
        graphSnapshot: schema.workflowRuns.graphSnapshot,
      }).from(schema.workflowRuns).where(and(
        inArray(schema.workflowRuns.status, TERMINAL_STATUSES),
        lte(schema.workflowRuns.updatedAt, stateCutoff),
      )).limit(this.#batchSize).all();

      for (const row of candidates) {
        const state = row.runState as Record<string, unknown> | null;
        if (!state || state._compacted === true) continue;
        if (!this.#archive) continue; // lossless contract: no archive, no destructive compaction
        const archive = this.#archive.archiveRunState({
          runId: row.id,
          workspaceId: row.workspaceId,
          status: row.status,
          runState: state,
          graphSnapshot: row.graphSnapshot,
        });
        archivedRunStates += 1;
        const compact = compactRunState(row.status, state, archive);
        this.#db.update(schema.workflowRuns).set({ runState: compact as unknown as object })
          .where(eq(schema.workflowRuns.id, row.id)).run();
        compactedRunStates += 1;
      }

      const terminalRunIds = this.#db.select({ id: schema.workflowRuns.id }).from(schema.workflowRuns)
        .where(inArray(schema.workflowRuns.status, TERMINAL_STATUSES)).all().map((row) => row.id);
      let deletedSnapshots = 0;
      for (let i = 0; i < terminalRunIds.length; i += 500) {
        const batch = terminalRunIds.slice(i, i + 500);
        if (!batch.length) continue;
        deletedSnapshots += changes(this.#db.delete(schema.workflowRunSnapshots)
          .where(inArray(schema.workflowRunSnapshots.runId, batch)).run());
      }

      const ledgerCutoff = new Date(now - ledgerDays * DAY_MS).toISOString();
      const ledgerRows = this.#db.select().from(schema.ledgerEvents).where(and(
        isNotNull(schema.ledgerEvents.runId),
        lte(schema.ledgerEvents.createdAt, ledgerCutoff),
      )).limit(this.#batchSize).all();
      let archivedLedgerRows = 0;
      let deletedLedgerRows = 0;
      if (this.#archive && ledgerRows.length) {
        for (const [key, rows] of groupBy(ledgerRows, (row) => `${row.workspaceId}\0${row.runId}`)) {
          const [workspaceId, runId] = key.split('\0');
          this.#archive.archiveLedgerEvents(workspaceId!, runId!, rows as unknown as Record<string, unknown>[]);
          archivedLedgerRows += rows.length;
        }
        deletedLedgerRows = changes(this.#db.delete(schema.ledgerEvents)
          .where(inArray(schema.ledgerEvents.id, ledgerRows.map((row) => row.id))).run());
      }

      const observabilityCutoff = new Date(now - observabilityDays * DAY_MS).toISOString();
      const observationRows = this.#db.select().from(schema.observabilityEvents)
        .where(lte(schema.observabilityEvents.createdAt, observabilityCutoff))
        .limit(this.#batchSize).all();
      let archivedObservabilityRows = 0;
      let deletedObservabilityRows = 0;
      if (this.#archive && observationRows.length) {
        for (const [key, rows] of groupBy(observationRows, (row) => `${row.workspaceId}\0${row.createdAt.slice(0, 10)}`)) {
          const [workspaceId, day] = key.split('\0');
          this.#archive.archiveObservabilityEvents(workspaceId!, day!, rows as unknown as Record<string, unknown>[]);
          archivedObservabilityRows += rows.length;
        }
        deletedObservabilityRows = changes(this.#db.delete(schema.observabilityEvents)
          .where(inArray(schema.observabilityEvents.id, observationRows.map((row) => row.id))).run());
      }

      if (compactedRunStates + deletedSnapshots + deletedLedgerRows + deletedObservabilityRows > 0) {
        try { this.#reclaimStorage?.(); } catch (err) {
          this.#logger.warn('run_compaction.reclaim_failed', { error: (err as Error).message });
        }
      }

      const summary: RunCompactionSummary = {
        compactedRunStates, archivedRunStates, deletedSnapshots,
        archivedLedgerRows, deletedLedgerRows,
        archivedObservabilityRows, deletedObservabilityRows,
        pressureMode, ...storage, durationMs: Date.now() - startedAt,
      };
      this.#logger.info('run_compaction.done', summary as unknown as Record<string, unknown>);
      return summary;
    } finally {
      this.#running = false;
    }
  }

  #storagePressure(): { dbBytes: number | null; freeBytes: number | null } {
    if (!this.#dataDir) return { dbBytes: null, freeBytes: null };
    try {
      const dbPath = join(this.#dataDir, 'data.db');
      const dbBytes = existsSync(dbPath) ? statSync(dbPath).size : null;
      const fs = statfsSync(this.#dataDir);
      return { dbBytes, freeBytes: Number(fs.bavail) * Number(fs.bsize) };
    } catch (err) {
      this.#logger.warn('run_compaction.storage_probe_failed', { error: (err as Error).message });
      return { dbBytes: null, freeBytes: null };
    }
  }
}

function compactRunState(status: string, state: Record<string, unknown>, archive: ColdArchiveRef): Record<string, unknown> {
  return {
    _compacted: true,
    _archive: archive,
    runId: state.runId,
    workflowId: state.workflowId,
    status,
    completedNodeIds: Array.isArray(state.completedNodeIds) ? state.completedNodeIds : [],
    failedNodeIds: Array.isArray(state.failedNodeIds) ? state.failedNodeIds : [],
    skippedNodeIds: Array.isArray(state.skippedNodeIds) ? state.skippedNodeIds : [],
    contractViolations: Array.isArray(state.contractViolations) ? state.contractViolations : undefined,
    verdict: state.verdict,
    error: state.error,
    compactedAt: new Date().toISOString(),
  };
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) out.set(keyOf(row), [...(out.get(keyOf(row)) ?? []), row]);
  return out;
}

function changes(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(0, value);
}

function emptySummary(pressureMode: boolean, dbBytes: number | null, freeBytes: number | null): RunCompactionSummary {
  return {
    compactedRunStates: 0, archivedRunStates: 0, deletedSnapshots: 0,
    archivedLedgerRows: 0, deletedLedgerRows: 0,
    archivedObservabilityRows: 0, deletedObservabilityRows: 0,
    pressureMode, dbBytes, freeBytes, durationMs: 0,
  };
}
