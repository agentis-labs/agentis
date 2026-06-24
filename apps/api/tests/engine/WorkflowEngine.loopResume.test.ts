/**
 * WorkflowEngine — durable / idempotent loop resume (masterplan 1.4).
 *
 * Crash recovery re-dispatches an interrupted loop node. The loop now persists
 * each completed iteration and SKIPS it on re-run, so side effects fire at most
 * once per iteration instead of the whole loop replaying. We prove the skip by
 * seeding the loop node's persisted `_loopState` and counting how many child
 * runs (one per executed iteration) get spawned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { SubflowExecutor } from '../../src/services/subflowExecutor.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function saveWorkflow(graph: WorkflowGraph): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({ id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'wf', graph, settings: {} }).run();
  return id;
}

/** A trivial child workflow (trigger only) — each loop iteration spawns one child run. */
function childWorkflow(): WorkflowGraph {
  return { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } }], edges: [] } as WorkflowGraph;
}

function buildEngine() {
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  return new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger, scratchpad,
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    subflows: new SubflowExecutor({ db: ctx.db, ledger, scratchpad }),
  });
}

async function runLoop(seedCompleted?: Record<string, unknown>): Promise<{ runId: string; childRuns: number; results: unknown[] }> {
  const childWfId = saveWorkflow(childWorkflow());
  const parent = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'L', type: 'loop', title: 'loop', position: { x: 1, y: 0 }, config: { kind: 'loop', itemsExpression: 'items', maxConcurrency: 1, bodyWorkflowId: childWfId, onIterationError: 'continue', outputArrayKey: 'results', chunkSize: 1 } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'L' }],
  } as unknown as WorkflowGraph;
  const parentWfId = saveWorkflow(parent);

  const runId = randomUUID();
  const inputs = { items: [0, 1, 2] };
  const initialState = buildInitialRunState({ runId, workflowId: parentWfId, graph: parent, inputs });
  if (seedCompleted) {
    // Simulate a crash after some iterations completed: persist their results.
    (initialState.nodeStates['L'] as { outputData?: Record<string, unknown> }).outputData = { _loopState: { completed: seedCompleted } };
  }
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id, status: 'CREATED', runState: initialState as unknown as object }).run();

  const engine = buildEngine();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) { clearTimeout(timer); off(); resolve(); }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id, triggerId: null, inputs, initialState, graph: parent });
  });

  const childRuns = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.parentRunId, runId)).all().length;
  const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  const state = run.runState as { nodeStates: Record<string, { outputData?: { results?: unknown[] } }> };
  return { runId, childRuns, results: state.nodeStates.L?.outputData?.results ?? [] };
}

describe('WorkflowEngine — durable loop resume', () => {
  it('runs every iteration on a fresh loop (one child run per item)', async () => {
    const { childRuns, results } = await runLoop();
    expect(childRuns).toBe(3);
    expect(results).toHaveLength(3);
  });

  it('skips already-completed iterations on a resumed loop (idempotent)', async () => {
    // Iterations 0 and 1 were persisted as done before the "crash".
    const { childRuns, results } = await runLoop({ '0': { reused: 0 }, '1': { reused: 1 } });
    // Only iteration 2 actually executes → one new child run.
    expect(childRuns).toBe(1);
    // The output still has all three, with the persisted ones reused verbatim.
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ reused: 0 });
    expect(results[1]).toEqual({ reused: 1 });
  });
});
