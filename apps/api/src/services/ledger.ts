/**
 * Append-only ledger.
 *
 * Spec invariants (V1-SPEC §6.4):
 *  - Strictly monotonic per-run sequence number (UNIQUE INDEX
 *    uq_ledger_run_seq guarantees this at the database layer).
 *  - Cursor-paginated reads in sequence order; no offset/limit anti-patterns.
 *  - Every append also fans out as a `ledger.event` realtime envelope so the
 *    dashboard's Ledger Strip shows new events without polling.
 *
 * Concurrency: SQLite serializes writes per-process. The in-memory `seqCache`
 * Map keeps a per-run high-water-mark to avoid round-tripping for sequence
 * lookup on the hot path. If the cache misses we fall back to MAX(sequence).
 */

import { randomUUID } from 'node:crypto';
import { eq, max as drizzleMax } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';

export interface LedgerAppendArgs {
  workspaceId: string;
  ambientId: string | null;
  runId: string;
  eventType: string;
  nodeId?: string | null;
  taskId?: string | null;
  payload?: Record<string, unknown>;
}

export interface LedgerEvent {
  id: string;
  runId: string;
  sequenceNumber: number;
  eventType: string;
  nodeId: string | null;
  taskId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class LedgerService {
  readonly #seqCache = new Map<string, number>();

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
  ) {}

  async append(args: LedgerAppendArgs): Promise<LedgerEvent> {
    const seq = await this.#nextSeq(args.runId);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const payload = args.payload ?? {};

    this.db
      .insert(schema.ledgerEvents)
      .values({
        id,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        runId: args.runId,
        sequenceNumber: seq,
        eventType: args.eventType,
        nodeId: args.nodeId ?? null,
        taskId: args.taskId ?? null,
        payload,
        createdAt,
      })
      .run();

    const event: LedgerEvent = {
      id,
      runId: args.runId,
      sequenceNumber: seq,
      eventType: args.eventType,
      nodeId: args.nodeId ?? null,
      taskId: args.taskId ?? null,
      payload,
      createdAt,
    };

    this.bus.publish(REALTIME_ROOMS.run(args.runId), REALTIME_EVENTS.LEDGER_EVENT, event);
    return event;
  }

  /** Cursor-paginated read; pass `afterSequence` from the prior page's last event. */
  async listForRun(args: {
    runId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<LedgerEvent[]> {
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
    const after = args.afterSequence ?? -1;
    const rows = this.db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.runId, args.runId))
      .all();
    return rows
      .filter((r) => r.sequenceNumber > after)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        runId: r.runId,
        sequenceNumber: r.sequenceNumber,
        eventType: r.eventType,
        nodeId: r.nodeId,
        taskId: r.taskId,
        payload: r.payload as Record<string, unknown>,
        createdAt: r.createdAt,
      }));
  }

  async #nextSeq(runId: string): Promise<number> {
    const cached = this.#seqCache.get(runId);
    if (cached !== undefined) {
      const next = cached + 1;
      this.#seqCache.set(runId, next);
      return next;
    }
    const row = this.db
      .select({ m: drizzleMax(schema.ledgerEvents.sequenceNumber) })
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.runId, runId))
      .get();
    const next = (row?.m ?? 0) + 1;
    this.#seqCache.set(runId, next);
    return next;
  }
}
