/**
 * LedgerService — V1-SPEC §6.4 monotonic per-run sequence.
 *
 * Uses an in-memory SQLite via openSqlite(':memory:') so each test gets a
 * pristine schema without polluting the operator's data dir.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openSqlite, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { LedgerService } from '../src/services/ledger.js';
import { createInProcessEventBus } from '../src/event-bus.js';

let db: AgentisSqliteDb;
let svc: LedgerService;

beforeEach(() => {
  // Open fresh in-memory schema, then disable FK enforcement so the tests
  // can append ledger rows referencing synthetic workspace/run ids without
  // having to seed the entire 22-table graph.
  const opened = openSqlite({ path: ':memory:' });
  db = opened.db;
  opened.sqlite.pragma('foreign_keys = OFF');
  svc = new LedgerService(db, createInProcessEventBus());
});

describe('LedgerService', () => {
  it('assigns monotonic per-run sequence numbers', async () => {
    const a = await svc.append({
      workspaceId: 'ws1', ambientId: null, runId: 'r1', eventType: 'run.started',
    });
    const b = await svc.append({
      workspaceId: 'ws1', ambientId: null, runId: 'r1', eventType: 'node.started',
    });
    const c = await svc.append({
      workspaceId: 'ws1', ambientId: null, runId: 'r1', eventType: 'node.completed',
    });
    expect([a.sequenceNumber, b.sequenceNumber, c.sequenceNumber]).toEqual([1, 2, 3]);
  });

  it('keeps sequence numbers independent across runs', async () => {
    const a = await svc.append({ workspaceId: 'ws1', ambientId: null, runId: 'r1', eventType: 'x' });
    const b = await svc.append({ workspaceId: 'ws1', ambientId: null, runId: 'r2', eventType: 'x' });
    expect(a.sequenceNumber).toBe(1);
    expect(b.sequenceNumber).toBe(1);
  });

  it('listForRun returns events in sequence order with cursor pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await svc.append({ workspaceId: 'ws1', ambientId: null, runId: 'r1', eventType: `e${i}` });
    }
    const first = await svc.listForRun({ runId: 'r1', limit: 3 });
    expect(first.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]);
    const next = await svc.listForRun({ runId: 'r1', afterSequence: 3 });
    expect(next.map((e) => e.sequenceNumber)).toEqual([4, 5]);
  });

  it('rebuilds the seq cache from the database after restart', async () => {
    await svc.append({ workspaceId: 'ws1', ambientId: null, runId: 'r1', eventType: 'a' });
    await svc.append({ workspaceId: 'ws1', ambientId: null, runId: 'r1', eventType: 'b' });
    // New service instance, same DB — must NOT reset sequence to 1.
    const fresh = new LedgerService(db, createInProcessEventBus());
    const next = await fresh.append({
      workspaceId: 'ws1', ambientId: null, runId: 'r1', eventType: 'c',
    });
    expect(next.sequenceNumber).toBe(3);
  });
});
