/**
 * WorkflowEngine — durable subflow delegation across a restart (masterplan 1.4).
 *
 * A subflow parent node stays RUNNING while a child WorkflowRun executes. The
 * resume binding (parent ← child) lives in-memory in SubflowExecutor, so a
 * process restart used to (a) lose it — hanging the parent forever — and (b)
 * re-dispatch the subflow node, spawning a DUPLICATE child run.
 *
 * We simulate a restart by persisting a mid-subflow crash state and running
 * recovery on a FRESH engine (empty in-memory pending map). The parent must
 * resume to COMPLETED and NO second child run may be spawned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph, type WorkflowRunState } from '@agentis/core';
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

function buildEngine(): WorkflowEngine {
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

function saveWorkflow(graph: WorkflowGraph): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({ id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'wf', graph, settings: {} }).run();
  return id;
}

function childWorkflow(): WorkflowGraph {
  return {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'CT', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'CO', type: 'return_output', title: 'out', position: { x: 1, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [{ id: 'ce', source: 'CT', target: 'CO' }],
  } as unknown as WorkflowGraph;
}

function countChildRuns(parentRunId: string): number {
  return ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.parentRunId, parentRunId)).all().length;
}

describe('WorkflowEngine — durable subflow delegation', () => {
  it('resumes the parent (no duplicate child) when the child finished during downtime', async () => {
    const childWfId = saveWorkflow(childWorkflow());
    const parentGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'S', type: 'subflow', title: 'sub', position: { x: 1, y: 0 }, config: { kind: 'subflow', workflowId: childWfId } },
        { id: 'O', type: 'return_output', title: 'done', position: { x: 2, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'S' }, { id: 'e2', source: 'S', target: 'O' }],
    } as unknown as WorkflowGraph;
    const parentWfId = saveWorkflow(parentGraph);

    // ── Persist a mid-subflow crash state ──
    const parentRunId = randomUUID();
    const parentState = buildInitialRunState({ runId: parentRunId, workflowId: parentWfId, graph: parentGraph, inputs: {} });
    parentState.status = 'RUNNING';
    parentState.nodeStates['T'] = { nodeId: 'T', status: 'COMPLETED', outputData: {} };
    parentState.completedNodeIds = ['T'];
    parentState.nodeStates['S'] = { nodeId: 'S', status: 'RUNNING', inputData: {} };
    // S already consumed its input from T when it dispatched (pre-crash): the
    // engine removes a node's waitingInputs on dispatch, so reflect that here.
    delete parentState.waitingInputs['S'];
    parentState.activeExecutions = {
      S: { taskId: 'subflow:S', nodeId: 'S', executorType: 'subflow', executorRef: childWfId, startedAt: new Date().toISOString() },
    };
    ctx.db.insert(schema.workflowRuns).values({
      id: parentRunId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id,
      status: 'RUNNING', runState: parentState as unknown as object,
    }).run();

    // The child finished while the process was down: a terminal child run row.
    const childRunId = randomUUID();
    const childState = buildInitialRunState({ runId: childRunId, workflowId: childWfId, graph: childWorkflow(), inputs: {} });
    childState.status = 'COMPLETED';
    childState.nodeStates['CT'] = { nodeId: 'CT', status: 'COMPLETED', outputData: {} };
    childState.nodeStates['CO'] = { nodeId: 'CO', status: 'COMPLETED', outputData: { result: 42 } };
    childState.completedNodeIds = ['CT', 'CO'];
    ctx.db.insert(schema.workflowRuns).values({
      id: childRunId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: childWfId, userId: ctx.user.id,
      status: 'COMPLETED', runState: childState as unknown as object, parentRunId,
    }).run();

    expect(countChildRuns(parentRunId)).toBe(1);

    // ── Restart: a fresh engine has an empty in-memory pending map ──
    const engine = buildEngine();
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('parent did not resume after recovery')), 10_000);
      const off = ctx.bus.subscribe((m) => {
        if (m.room === `run:${parentRunId}` && m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) { clearTimeout(timer); off(); resolve(); }
      });
    });

    await engine.recoverInterruptedRuns();
    await completed;

    const parent = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, parentRunId)).get()!;
    expect(parent.status).toBe('COMPLETED');
    const finalState = parent.runState as unknown as WorkflowRunState;
    // The subflow node carries the child's final output downstream.
    expect(finalState.nodeStates['S']?.outputData).toEqual({ result: 42 });
    expect(finalState.nodeStates['O']?.status).toBe('COMPLETED');
    // No duplicate child run was spawned by recovery.
    expect(countChildRuns(parentRunId)).toBe(1);
  });
});
