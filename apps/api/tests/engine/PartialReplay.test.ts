/**
 * PartialReplayService — V1-SPEC §6.7. Four modes.
 *
 * Each mode produces a fresh runId with a copy-forward of the source
 * run's COMPLETED nodes appropriate to the mode. The new run carries
 * `parentRunId` and an incremented `replanCount`. Approvals from the
 * source are NOT carried over.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AgentisError, type WorkflowGraph, type WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { PartialReplayService } from '../../src/services/partialReplay.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let svc: PartialReplayService;

beforeEach(async () => {
  ctx = await createTestContext();
  svc = new PartialReplayService(ctx.db);
});
afterEach(() => ctx.close());

/** Linear graph A → B → C → D. */
function linearGraph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'A', type: 'trigger', title: 'A', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'B', type: 'merge', title: 'B', position: { x: 100, y: 0 }, config: { kind: 'merge', requiredInputs: 'all' } },
      { id: 'C', type: 'merge', title: 'C', position: { x: 200, y: 0 }, config: { kind: 'merge', requiredInputs: 'all' } },
      { id: 'D', type: 'merge', title: 'D', position: { x: 300, y: 0 }, config: { kind: 'merge', requiredInputs: 'all' } },
    ],
    edges: [
      { id: 'e1', source: 'A', target: 'B' },
      { id: 'e2', source: 'B', target: 'C' },
      { id: 'e3', source: 'C', target: 'D' },
    ],
  };
}

function seedSource(opts: {
  graph: WorkflowGraph;
  completedNodeIds: string[];
  failedNodeIds?: string[];
  outputs?: Record<string, Record<string, unknown>>;
  replanCount?: number;
}) {
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'replay-wf',
      graph: opts.graph,
      settings: {},
    })
    .run();

  const nodeStates: Record<string, unknown> = {};
  for (const node of opts.graph.nodes) {
    if (opts.completedNodeIds.includes(node.id)) {
      nodeStates[node.id] = {
        nodeId: node.id,
        status: 'COMPLETED',
        outputData: opts.outputs?.[node.id] ?? { from: node.id },
      };
    } else if (opts.failedNodeIds?.includes(node.id)) {
      nodeStates[node.id] = { nodeId: node.id, status: 'FAILED', error: 'boom' };
    } else {
      nodeStates[node.id] = { nodeId: node.id, status: 'PENDING' };
    }
  }
  const sourceState: WorkflowRunState = {
    runId,
    workflowId: wfId,
    status: opts.failedNodeIds?.length ? 'FAILED' : 'COMPLETED',
    readyQueue: [],
    waitingInputs: {},
    nodeStates: nodeStates as never,
    activeExecutions: {},
    completedNodeIds: opts.completedNodeIds,
    failedNodeIds: opts.failedNodeIds ?? [],
    skippedNodeIds: [],
    graphRevision: 1,
    replanCount: opts.replanCount ?? 0,
    lastLedgerSequence: 0,
  };
  ctx.db
    .insert(schema.workflowRuns)
    .values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      status: sourceState.status,
      runState: sourceState as unknown as object,
      replanCount: opts.replanCount ?? 0,
    })
    .run();
  return { wfId, runId };
}

describe('PartialReplayService — four modes', () => {
  it('replay-from-node keeps strict ancestors and rebuilds downstream', () => {
    // A → B → C → D, all completed. Replay from C: keep {A, B}; reset C, D.
    const graph = linearGraph();
    const { wfId, runId } = seedSource({ graph, completedNodeIds: ['A', 'B', 'C', 'D'] });
    const out = svc.prepare({
      workspaceId: ctx.workspace.id,
      sourceRunId: runId,
      mode: 'replay-from-node',
      targetNodeId: 'C',
      userId: ctx.user.id,
    });
    expect(out.workflowId).toBe(wfId);
    expect(out.runId).not.toBe(runId);
    expect(out.initialState.completedNodeIds.sort()).toEqual(['A', 'B']);
    expect(out.initialState.nodeStates.C?.status).toBe('PENDING');
    expect(out.initialState.nodeStates.D?.status).toBe('PENDING');
    // C should be ready to fire (B's output pre-fed).
    const readyIds = out.initialState.readyQueue.map((r) => r.nodeId);
    expect(readyIds).toContain('C');
    // D still waiting on C.
    expect(out.initialState.waitingInputs.D?.requiredInputs).toEqual(['C']);
  });

  it('replay-failed-branch resets the entire failed lineage (failed node + all its ancestors)', () => {
    // Linear A → B → C → D where C failed. Keep set is computed as
    // (completed) - (ancestors-of-failed ∪ failed) = {A,B} - {A,B,C} = ∅.
    // The trigger A re-fires from scratch.
    const graph = linearGraph();
    const { runId } = seedSource({
      graph,
      completedNodeIds: ['A', 'B'],
      failedNodeIds: ['C'],
    });
    const out = svc.prepare({
      workspaceId: ctx.workspace.id,
      sourceRunId: runId,
      mode: 'replay-failed-branch',
      userId: ctx.user.id,
    });
    expect(out.initialState.completedNodeIds).toEqual([]);
    expect(out.initialState.failedNodeIds).toEqual([]);
    const readyIds = out.initialState.readyQueue.map((r) => r.nodeId);
    expect(readyIds).toContain('A');
    expect(out.initialState.nodeStates.B?.status).toBe('PENDING');
    expect(out.initialState.nodeStates.C?.status).toBe('PENDING');
  });

  it('replay-failed-branch preserves completed siblings of the failed branch', () => {
    // Forked graph:  A → B  ;  A → C → D (D failed).
    // Failed lineage = {D, C, A}. Completed B is NOT an ancestor of D.
    // Keep set = {B}. But B's only input is A, which we discarded — so B
    // remains pre-seeded with the source's recorded outputData and stays
    // COMPLETED in the new run.
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'A', type: 'trigger', title: 'A', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'B', type: 'merge', title: 'B', position: { x: 100, y: 0 }, config: { kind: 'merge', requiredInputs: 'all' } },
        { id: 'C', type: 'merge', title: 'C', position: { x: 100, y: 100 }, config: { kind: 'merge', requiredInputs: 'all' } },
        { id: 'D', type: 'merge', title: 'D', position: { x: 200, y: 100 }, config: { kind: 'merge', requiredInputs: 'all' } },
      ],
      edges: [
        { id: 'e1', source: 'A', target: 'B' },
        { id: 'e2', source: 'A', target: 'C' },
        { id: 'e3', source: 'C', target: 'D' },
      ],
    };
    const { runId } = seedSource({
      graph,
      completedNodeIds: ['A', 'B', 'C'],
      failedNodeIds: ['D'],
    });
    const out = svc.prepare({
      workspaceId: ctx.workspace.id,
      sourceRunId: runId,
      mode: 'replay-failed-branch',
      userId: ctx.user.id,
    });
    expect(out.initialState.completedNodeIds).toContain('B');
    expect(out.initialState.completedNodeIds).not.toContain('A');
    expect(out.initialState.completedNodeIds).not.toContain('C');
  });

  it('replay-with-edited-node patches the target node config without mutating the source workflow', () => {
    const graph = linearGraph();
    const { wfId, runId } = seedSource({ graph, completedNodeIds: ['A', 'B', 'C', 'D'] });
    const out = svc.prepare({
      workspaceId: ctx.workspace.id,
      sourceRunId: runId,
      mode: 'replay-with-edited-node',
      targetNodeId: 'C',
      nodeConfigPatch: { requiredInputs: 'any' },
      userId: ctx.user.id,
    });
    const patchedC = out.graph.nodes.find((n) => n.id === 'C')!;
    expect((patchedC.config as { requiredInputs: string }).requiredInputs).toBe('any');
    // Source workflow row untouched (deep-clone guarantee).
    const sourceWf = ctx.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, wfId))
      .get()!;
    const sourceC = (sourceWf.graph as WorkflowGraph).nodes.find((n) => n.id === 'C')!;
    expect((sourceC.config as { requiredInputs: string }).requiredInputs).toBe('all');
  });

  it('replay-with-edited-node throws REPLAY_TARGET_INVALID without patch', () => {
    const graph = linearGraph();
    const { runId } = seedSource({ graph, completedNodeIds: ['A', 'B', 'C', 'D'] });
    expect(() =>
      svc.prepare({
        workspaceId: ctx.workspace.id,
        sourceRunId: runId,
        mode: 'replay-with-edited-node',
        targetNodeId: 'C',
        userId: ctx.user.id,
      }),
    ).toThrow(AgentisError);
  });

  it('replay-from-checkpoint keeps ancestors of the checkpoint and resets the checkpoint itself', () => {
    const graph = linearGraph();
    const { runId } = seedSource({ graph, completedNodeIds: ['A', 'B', 'C', 'D'] });
    // Treat C as a checkpoint; keep A,B; reset C,D.
    const out = svc.prepare({
      workspaceId: ctx.workspace.id,
      sourceRunId: runId,
      mode: 'replay-from-checkpoint',
      targetNodeId: 'C',
      userId: ctx.user.id,
    });
    expect(out.initialState.completedNodeIds.sort()).toEqual(['A', 'B']);
    expect(out.initialState.nodeStates.C?.status).toBe('PENDING');
  });

  it('rejects an unknown source run with WORKFLOW_RUN_NOT_FOUND', () => {
    expect(() =>
      svc.prepare({
        workspaceId: ctx.workspace.id,
        sourceRunId: randomUUID(),
        mode: 'replay-from-node',
        targetNodeId: 'C',
        userId: ctx.user.id,
      }),
    ).toThrow(/not found/);
  });

  it('rejects a source run from a different workspace', () => {
    const graph = linearGraph();
    const { runId } = seedSource({ graph, completedNodeIds: ['A'] });
    expect(() =>
      svc.prepare({
        workspaceId: 'someone-elses-ws',
        sourceRunId: runId,
        mode: 'replay-from-node',
        targetNodeId: 'B',
        userId: ctx.user.id,
      }),
    ).toThrow(AgentisError);
  });

  it('persistChildRun inserts a new workflow_runs row with parentRunId + incremented replanCount', () => {
    const graph = linearGraph();
    const { wfId, runId } = seedSource({ graph, completedNodeIds: ['A'], replanCount: 2 });
    const prepared = svc.prepare({
      workspaceId: ctx.workspace.id,
      sourceRunId: runId,
      mode: 'replay-from-node',
      targetNodeId: 'B',
      userId: ctx.user.id,
    });
    svc.persistChildRun({
      runId: prepared.runId,
      workspaceId: prepared.workspaceId,
      ambientId: prepared.ambientId,
      workflowId: prepared.workflowId,
      userId: prepared.userId,
      parentRunId: runId,
      initialState: prepared.initialState,
      parentReplanCount: 2,
    });
    const child = ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, prepared.runId))
      .get();
    expect(child?.parentRunId).toBe(runId);
    expect(child?.replanCount).toBe(3);
    expect(child?.workflowId).toBe(wfId);
    expect(child?.status).toBe('CREATED');
    expect(child?.triggerId).toBeNull();
  });
});
