/**
 * WorkflowEngine — `parallel` node semantics.
 *
 * A `parallel` node is a structural fan-out: its branches run concurrently and
 * reconverge at a downstream `merge`. Its `waitFor` / `onBranchError` /
 * `mergeStrategy` settings used to be inert canvas decoration. They are now
 * honored: the governed merge INHERITS the nearest upstream parallel's policy.
 *   - mergeStrategy 'collect_all'    → every branch output kept as an array.
 *   - mergeStrategy 'first_non_null' → first branch with a meaningful payload.
 *   - waitFor 'first'                → merge becomes an OR-join (first-wins).
 *   - onBranchError 'continue_with_results' → a failed branch is absorbed and
 *                                     the merge proceeds with the survivors
 *                                     (instead of the whole run failing).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

function buildEngine() {
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    extensions: {} as unknown as ExtensionRuntime,
    adapters,
  });
}

function seedWorkflow(graph: WorkflowGraph) {
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'parallel-wf', graph, settings: {},
  }).run();
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
    userId: ctx.user.id, status: 'CREATED', runState: {},
  }).run();
  return { wfId, runId };
}

function waitForRunStatus(runId: string, target: 'COMPLETED' | 'FAILED'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const evt = target === 'COMPLETED' ? REALTIME_EVENTS.RUN_COMPLETED : REALTIME_EVENTS.RUN_FAILED;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${target} on ${runId}`)), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && m.envelope.event === evt) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

async function run(graph: WorkflowGraph, target: 'COMPLETED' | 'FAILED' = 'COMPLETED') {
  const { wfId, runId } = seedWorkflow(graph);
  const engine = buildEngine();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  await engine.startRun({
    workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
    userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph,
  });
  await waitForRunStatus(runId, target);
  const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  return {
    status: row.status as string,
    ...(row.runState as {
      nodeStates: Record<string, { status: string; outputData?: Record<string, unknown> }>;
      waitingInputs: Record<string, unknown>;
    }),
  };
}

/** P(parallel) → A, B → M(merge). A/B configs and the parallel policy vary per test. */
function parallelGraph(opts: {
  parallel: { waitFor: 'all' | 'first'; onBranchError: 'fail_all' | 'continue_with_results'; mergeStrategy: 'merge_keys' | 'collect_all' | 'first_non_null' };
  aExpr: string;
  bNodes: WorkflowGraph['nodes'];
  bExpr?: string;
  bEntryId: string; // node id that P connects to for branch B
  bExitId: string;  // node id that connects to M for branch B
}): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'T', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'P', type: 'parallel', title: 'P', position: { x: 100, y: 0 }, config: { kind: 'parallel', ...opts.parallel } },
      { id: 'A', type: 'transform', title: 'A', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: opts.aExpr } },
      ...opts.bNodes,
      { id: 'M', type: 'merge', title: 'M', position: { x: 400, y: 0 }, config: { kind: 'merge', requiredInputs: 'all' } },
    ],
    edges: [
      { id: 'e0', source: 'T', target: 'P' },
      { id: 'e1', source: 'P', target: 'A' },
      { id: 'e2', source: 'P', target: opts.bEntryId },
      // Chain the B branch's entry → exit when it spans multiple nodes
      // (e.g. wait → transform), so the exit is reached THROUGH the entry.
      ...(opts.bEntryId !== opts.bExitId
        ? [{ id: 'eB', source: opts.bEntryId, target: opts.bExitId }]
        : []),
      { id: 'e3', source: 'A', target: 'M' },
      { id: 'e4', source: opts.bExitId, target: 'M' },
    ],
  };
}

describe('WorkflowEngine — parallel node policy (inherited by the governed merge)', () => {
  it("mergeStrategy 'collect_all' keeps each branch output as a distinct array entry", async () => {
    const graph = parallelGraph({
      parallel: { waitFor: 'all', onBranchError: 'fail_all', mergeStrategy: 'collect_all' },
      aExpr: '({ a: 1 })',
      bExpr: '({ b: 2 })',
      bEntryId: 'B', bExitId: 'B',
      bNodes: [{ id: 'B', type: 'transform', title: 'B', position: { x: 200, y: 100 }, config: { kind: 'transform', expression: '({ b: 2 })' } }],
    });
    const state = await run(graph);
    expect(state.nodeStates.M?.status).toBe('COMPLETED');
    const results = state.nodeStates.M?.outputData?.results as Array<Record<string, unknown>>;
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(2);
    // Both branch payloads are present, distinct (not key-merged into one object).
    expect(results).toEqual(expect.arrayContaining([{ a: 1 }, { b: 2 }]));
  });

  it("mergeStrategy 'first_non_null' returns the first branch with a meaningful payload", async () => {
    // Only branch A produces a payload; B yields an empty object.
    const graph = parallelGraph({
      parallel: { waitFor: 'all', onBranchError: 'fail_all', mergeStrategy: 'first_non_null' },
      aExpr: '({ a: 1 })',
      bEntryId: 'B', bExitId: 'B',
      bNodes: [{ id: 'B', type: 'transform', title: 'B', position: { x: 200, y: 100 }, config: { kind: 'transform', expression: '({})' } }],
    });
    const state = await run(graph);
    expect(state.nodeStates.M?.status).toBe('COMPLETED');
    expect(state.nodeStates.M?.outputData).toMatchObject({ a: 1 });
  });

  it("waitFor 'first' turns the governed merge into an OR-join", async () => {
    // Branch B is slowed with a wait so A always reaches the merge first.
    const graph = parallelGraph({
      parallel: { waitFor: 'first', onBranchError: 'fail_all', mergeStrategy: 'merge_keys' },
      aExpr: '({ fast: true })',
      bEntryId: 'Bw', bExitId: 'B',
      bNodes: [
        { id: 'Bw', type: 'wait', title: 'Bw', position: { x: 200, y: 100 }, config: { kind: 'wait', delayMs: 400 } },
        { id: 'B', type: 'transform', title: 'B', position: { x: 280, y: 100 }, config: { kind: 'transform', expression: '({ slow: true })' } },
      ],
    });
    const state = await run(graph);
    expect(state.nodeStates.M?.status).toBe('COMPLETED');
    expect(state.nodeStates.M?.outputData).toMatchObject({ fast: true });
    expect(state.nodeStates.M?.outputData?.slow).toBeUndefined();
  });

  it("onBranchError 'continue_with_results' absorbs a failed branch so the merge still produces output", async () => {
    // Branch B throws (no error edge). With fail_all the merge is skipped and the
    // run fails hard. With continue_with_results the failed branch is absorbed,
    // the merge COMPLETES on the survivor (branch A), and the run reaches a
    // terminal completed-with-errors state (surfaced as RUN_FAILED for honesty,
    // since a node did error — but, crucially, the merge produced a result).
    const graph = parallelGraph({
      parallel: { waitFor: 'all', onBranchError: 'continue_with_results', mergeStrategy: 'merge_keys' },
      aExpr: '({ a: 1 })',
      bEntryId: 'B', bExitId: 'B',
      bNodes: [{ id: 'B', type: 'transform', title: 'B', position: { x: 200, y: 100 }, config: { kind: 'transform', expression: 'input.no.such.deep' } }],
    });
    const state = await run(graph, 'FAILED');
    expect(state.status).toBe('COMPLETED_WITH_ERRORS');
    // The merge ran and carries the survivor's payload — the whole point of
    // continue_with_results (fail_all would leave M SKIPPED).
    expect(state.nodeStates.M?.status).toBe('COMPLETED');
    expect(state.nodeStates.M?.outputData).toMatchObject({ a: 1 });
    expect(Object.keys(state.waitingInputs)).toHaveLength(0);
  });

  it("onBranchError 'fail_all' (default) fails the run and skips the merge when a branch errors", async () => {
    const graph = parallelGraph({
      parallel: { waitFor: 'all', onBranchError: 'fail_all', mergeStrategy: 'merge_keys' },
      aExpr: '({ a: 1 })',
      bEntryId: 'B', bExitId: 'B',
      bNodes: [{ id: 'B', type: 'transform', title: 'B', position: { x: 200, y: 100 }, config: { kind: 'transform', expression: 'input.no.such.deep' } }],
    });
    const state = await run(graph, 'FAILED');
    expect(state.status).toBe('FAILED');
    expect(state.nodeStates.B?.status).toBe('FAILED');
    // The merge never ran — fail_all does not produce partial results.
    expect(state.nodeStates.M?.status).not.toBe('COMPLETED');
  });
});
