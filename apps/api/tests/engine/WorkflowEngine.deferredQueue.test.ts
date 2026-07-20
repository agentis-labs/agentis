/**
 * Deferred queue rows — `scheduledAt` must gate the ROW, not just the sweep.
 *
 * processDueQueue picks WORKFLOWS that have something due and then drains by
 * workflowId. Without a row-level filter, one due row drags every deferred row
 * for the same workflow in with it — collapsing a staggered fan-out (N runs
 * spaced minutes apart) into a single burst. That failure is silent: every run
 * succeeds, they just all happen at once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { ConnectorRegistry } from '@agentis/integrations';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { WorkflowStoreService } from '../../src/services/workflow/workflowStore.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;

const NOW = new Date('2026-07-20T12:00:00.000Z');

beforeEach(async () => {
  ctx = await createTestContext();
  engine = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    skills: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    workflowStore: new WorkflowStoreService(ctx.db),
    connectors: new ConnectorRegistry([]),
    vault: ctx.vault,
  });
});

/**
 * Draining starts REAL runs, which execute asynchronously. Closing the database
 * out from under them surfaces as "connection is not open" long after the
 * assertions passed, so let them settle first.
 */
async function settleRuns(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = ctx.db.select().from(schema.workflowRuns)
      .where(inArray(schema.workflowRuns.status, ['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'PAUSED']))
      .all();
    if (active.length === 0) return;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

afterEach(async () => {
  await settleRuns();
  ctx.close();
});

/** A single no-op node — the assertions are about queue rows, not execution. */
function trivialGraph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'start', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function seedWorkflow(): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'staggered',
    graph: trivialGraph(),
    settings: {},
  }).run();
  return id;
}

/** Queue one pending row, optionally deferred. Mirrors what queueWorkflowRun writes. */
function seedQueueRow(workflowId: string, scheduledAt: string | null): string {
  const runId = randomUUID();
  const graph = trivialGraph();
  ctx.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status: 'CREATED',
    runState: buildInitialRunState({ runId, workflowId, graph, inputs: {} }),
    graphSnapshot: graph,
  }).run();
  ctx.db.insert(schema.workflowRunQueue).values({
    id: randomUUID(),
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    triggerId: null,
    runId,
    inputs: {},
    initialState: buildInitialRunState({ runId, workflowId, graph, inputs: {} }),
    graphSnapshot: graph,
    status: 'pending',
    reason: 'agent_scheduled',
    scheduledAt,
  }).run();
  return runId;
}

function queueStatus(runId: string): string | undefined {
  return ctx.db.select().from(schema.workflowRunQueue)
    .where(eq(schema.workflowRunQueue.runId, runId)).get()?.status;
}

describe('WorkflowEngine.drainWorkflowQueue — scheduledAt gating', () => {
  it('starts due and undated rows but leaves a future row pending', async () => {
    const workflowId = seedWorkflow();
    const immediate = seedQueueRow(workflowId, null);
    const due = seedQueueRow(workflowId, '2026-07-20T11:59:00.000Z');
    const later = seedQueueRow(workflowId, '2026-07-20T12:05:00.000Z');

    const started = await engine.drainWorkflowQueue(workflowId, NOW);

    expect(started).toBe(2);
    expect(queueStatus(immediate)).not.toBe('pending');
    expect(queueStatus(due)).not.toBe('pending');
    // The whole point: a burst-drain would have claimed this one too.
    expect(queueStatus(later)).toBe('pending');
  });

  it('releases each staggered row only as its own moment arrives', async () => {
    const workflowId = seedWorkflow();
    const rows = [0, 5, 10].map((minutes) =>
      seedQueueRow(workflowId, new Date(NOW.getTime() + minutes * 60_000).toISOString()));

    expect(await engine.drainWorkflowQueue(workflowId, NOW)).toBe(1);
    expect(rows.map(queueStatus).filter((s) => s === 'pending')).toHaveLength(2);

    expect(await engine.drainWorkflowQueue(workflowId, new Date(NOW.getTime() + 5 * 60_000))).toBe(1);
    expect(rows.map(queueStatus).filter((s) => s === 'pending')).toHaveLength(1);

    expect(await engine.drainWorkflowQueue(workflowId, new Date(NOW.getTime() + 10 * 60_000))).toBe(1);
    expect(rows.map(queueStatus).filter((s) => s === 'pending')).toHaveLength(0);
  });

  it('defaults to the current clock so undated callers are unaffected', async () => {
    const workflowId = seedWorkflow();
    const immediate = seedQueueRow(workflowId, null);

    expect(await engine.drainWorkflowQueue(workflowId)).toBe(1);
    expect(queueStatus(immediate)).not.toBe('pending');
  });
});
