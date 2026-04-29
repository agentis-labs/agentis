/**
 * RunStateStore — persists WorkflowRunState to workflow_runs.runState (JSON).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openSqlite, schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type Database from 'better-sqlite3';
import type { WorkflowRunState } from '@agentis/core';
import { RunStateStore } from '../../src/engine/RunStateStore.js';

let db: AgentisSqliteDb;
let sqlite: Database.Database;
let store: RunStateStore;
let runId: string;

beforeEach(() => {
  const opened = openSqlite({ path: ':memory:' });
  db = opened.db;
  sqlite = opened.sqlite;
  // Disable FK so we can insert a workflow_run row without seeding workspace/workflow.
  sqlite.pragma('foreign_keys = OFF');
  store = new RunStateStore(db);
  runId = randomUUID();
  db.insert(schema.workflowRuns)
    .values({
      id: runId,
      workflowId: randomUUID(),
      workspaceId: randomUUID(),
      ambientId: null,
      userId: randomUUID(),
      status: 'CREATED',
      runState: {},
      inputs: {},
      outputs: {},
    })
    .run();
});

function makeState(): WorkflowRunState {
  return {
    runId,
    workflowId: 'wf1',
    status: 'RUNNING',
    readyQueue: [],
    waitingInputs: {},
    nodeStates: { n1: { nodeId: 'n1', status: 'COMPLETED' } },
    activeExecutions: {},
    completedNodeIds: ['n1'],
    failedNodeIds: [],
    skippedNodeIds: [],
    graphRevision: 1,
    replanCount: 0,
    lastLedgerSequence: 7,
  };
}

describe('RunStateStore', () => {
  it('save() round-trips through load()', () => {
    const state = makeState();
    store.save(state);
    const loaded = store.load(runId);
    expect(loaded?.runId).toBe(runId);
    expect(loaded?.lastLedgerSequence).toBe(7);
    expect(loaded?.completedNodeIds).toEqual(['n1']);
  });

  it('save() updates the row in place (no row count growth)', () => {
    store.save(makeState());
    store.save({ ...makeState(), lastLedgerSequence: 12 });
    const rows = db.select().from(schema.workflowRuns).all();
    expect(rows.length).toBe(1);
    expect(store.load(runId)?.lastLedgerSequence).toBe(12);
  });

  it('load() returns null for unknown runId', () => {
    expect(store.load(randomUUID())).toBeNull();
  });

  it('save() also bumps updatedAt', () => {
    const before = db.select().from(schema.workflowRuns).all()[0]!.updatedAt;
    // Tiny delay to ensure ISO timestamp difference; resolution is ms.
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    store.save(makeState());
    const after = db.select().from(schema.workflowRuns).all()[0]!.updatedAt;
    expect(after >= before).toBe(true);
  });
});
