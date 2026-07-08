/**
 * WorkflowEngine.applyGraphPatch — V1-SPEC §6.6.
 *
 * Validates revision conflicts, validation failures, in-place mutation of
 * the live RunningContext.graph, and emission of the
 * `workflow.graph_patched` realtime event.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph, type WorkflowGraphPatch } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
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
let engine: WorkflowEngine;

beforeEach(async () => {
  ctx = await createTestContext();
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  const extensions = {} as unknown as ExtensionRuntime;
  engine = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    extensions,
    adapters,
  });
});
afterEach(() => ctx.close());

function baseGraph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'T',
        type: 'trigger',
        title: 'trigger',
        position: { x: 0, y: 0 },
        config: { kind: 'trigger', triggerType: 'manual' },
      },
    ],
    edges: [],
  };
}

function seedRun(): { wfId: string; runId: string } {
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'wf',
    graph: baseGraph(),
    settings: {},
  }).run();
  const state = buildInitialRunState({ runId, workflowId: wfId, graph: baseGraph(), inputs: {} });
  ctx.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: wfId,
    userId: ctx.user.id,
    status: 'RUNNING',
    runState: state,
  }).run();
  return { wfId, runId };
}

function patch(overrides: Partial<WorkflowGraphPatch> = {}): WorkflowGraphPatch {
  return {
    patchId: randomUUID(),
    reason: 'planner_replan',
    baseGraphRevision: 1,
    addNodes: [],
    updateNodes: [],
    removeNodeIds: [],
    addEdges: [],
    removeEdgeIds: [],
    ...overrides,
  };
}

describe('WorkflowEngine.applyGraphPatch', () => {
  it('adds nodes + edges, bumps revision, persists graph, emits event', async () => {
    const { wfId, runId } = seedRun();
    const events: string[] = [];
    ctx.bus.subscribe((m) => {
      if (m.envelope.event === REALTIME_EVENTS.WORKFLOW_GRAPH_PATCHED) events.push(m.room);
    });

    const result = await engine.applyGraphPatch({
      runId,
      patch: patch({
        addNodes: [
          {
            id: 'A',
            type: 'extension_task',
            title: 'add',
            position: { x: 100, y: 0 },
            config: { kind: 'extension_task', extensionId: 'noop', operationName: 'run', inputMapping: {}, outputMapping: {} },
          },
        ],
        addEdges: [{ id: 'T-A', source: 'T', target: 'A' }],
      }),
    });

    expect(result.newRevision).toBe(2);
    expect(events).toContain(`run:${runId}`);

    const wf = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, wfId)).get();
    const graph = wf!.graph as WorkflowGraph;
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['A', 'T']);
    expect(graph.edges.map((e) => e.id)).toEqual(['T-A']);

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    expect((run!.runState as { graphRevision: number }).graphRevision).toBe(2);
  });

  it('rejects with GRAPH_REVISION_CONFLICT when baseGraphRevision stale', async () => {
    const { runId } = seedRun();
    await expect(
      engine.applyGraphPatch({ runId, patch: patch({ baseGraphRevision: 99 }) }),
    ).rejects.toMatchObject({ code: 'GRAPH_REVISION_CONFLICT' });
  });

  it('rejects with GRAPH_PATCH_INVALID when removing missing node', async () => {
    const { runId } = seedRun();
    await expect(
      engine.applyGraphPatch({ runId, patch: patch({ removeNodeIds: ['ghost'] }) }),
    ).rejects.toMatchObject({ code: 'GRAPH_PATCH_INVALID' });
  });

  it('rejects with GRAPH_PATCH_INVALID when patch introduces a cycle', async () => {
    const { runId } = seedRun();
    await expect(
      engine.applyGraphPatch({
        runId,
        patch: patch({
          addNodes: [
            {
              id: 'A',
              type: 'extension_task',
              title: 'a',
              position: { x: 0, y: 0 },
              config: { kind: 'extension_task', extensionId: 'x', operationName: 'run', inputMapping: {}, outputMapping: {} },
            },
          ],
          addEdges: [
            { id: 'T-A', source: 'T', target: 'A' },
            { id: 'A-T', source: 'A', target: 'T' },
          ],
        }),
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_PATCH_INVALID' });
  });

  it('rejects with WORKFLOW_RUN_NOT_FOUND for unknown run', async () => {
    await expect(
      engine.applyGraphPatch({ runId: randomUUID(), patch: patch() }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_NOT_FOUND' });
  });
});
