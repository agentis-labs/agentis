/**
 * WorkflowEngine — fan-out across multiple downstream branches.
 *
 * Verifies the D23 fix: after a node completes and fans out to multiple
 * targets, the engine must re-tick so all downstream branches dispatch
 * concurrently and the run settles to COMPLETED once every branch has
 * returned. Specifically guards against the regression where only the
 * first downstream node was promoted from waitingInputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { SkillRuntime } from '../../src/services/skillRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

function buildEngine(skillsOverride?: SkillRuntime) {
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  const skills = skillsOverride ?? ({} as unknown as SkillRuntime);
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    skills,
    adapters,
  });
}

function seedWorkflow(graph: WorkflowGraph) {
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'fanout-wf',
      graph,
      settings: {},
    })
    .run();
  ctx.db
    .insert(schema.workflowRuns)
    .values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      status: 'CREATED',
      runState: {},
    })
    .run();
  return { wfId, runId };
}

function waitForRunStatus(runId: string, target: 'COMPLETED' | 'FAILED'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const evt =
      target === 'COMPLETED' ? REALTIME_EVENTS.RUN_COMPLETED : REALTIME_EVENTS.RUN_FAILED;
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

describe('WorkflowEngine — fan-out / multi-input merge', () => {
  it('drains all downstream branches and settles COMPLETED', async () => {
    // T → A; T → B; A,B → C  (merge requires both branches)
    const graph: WorkflowGraph = {
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
        {
          id: 'A',
          type: 'merge',
          title: 'A',
          position: { x: 100, y: 0 },
          config: { kind: 'merge', requiredInputs: 'all' },
        },
        {
          id: 'B',
          type: 'merge',
          title: 'B',
          position: { x: 100, y: 100 },
          config: { kind: 'merge', requiredInputs: 'all' },
        },
        {
          id: 'C',
          type: 'merge',
          title: 'C',
          position: { x: 200, y: 50 },
          config: { kind: 'merge', requiredInputs: 'all' },
        },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'A' },
        { id: 'e2', source: 'T', target: 'B' },
        { id: 'e3', source: 'A', target: 'C' },
        { id: 'e4', source: 'B', target: 'C' },
      ],
    };
    const { wfId, runId } = seedWorkflow(graph);
    const engine = buildEngine();
    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: { seed: 'go' } });
    await engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: { seed: 'go' },
      initialState,
      graph,
    });
    await waitForRunStatus(runId, 'COMPLETED');

    const row = ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eqRunId(runId))
      .get()!;
    expect(row.status).toBe('COMPLETED');
    const state = row.runState as { completedNodeIds: string[]; nodeStates: Record<string, { status: string }>; waitingInputs: Record<string, unknown> };
    // All four nodes settled.
    expect(state.completedNodeIds.sort()).toEqual(['A', 'B', 'C', 'T']);
    expect(state.nodeStates.C?.status).toBe('COMPLETED');
    // No buffer left dangling — D23 regression.
    expect(Object.keys(state.waitingInputs)).toHaveLength(0);
  });

  it('fans out to two parallel branches with no merge and still settles', async () => {
    // T → A; T → B  (no merge — both branches terminal)
    const graph: WorkflowGraph = {
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
        {
          id: 'A',
          type: 'merge',
          title: 'A',
          position: { x: 100, y: 0 },
          config: { kind: 'merge', requiredInputs: 'all' },
        },
        {
          id: 'B',
          type: 'merge',
          title: 'B',
          position: { x: 100, y: 100 },
          config: { kind: 'merge', requiredInputs: 'all' },
        },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'A' },
        { id: 'e2', source: 'T', target: 'B' },
      ],
    };
    const { wfId, runId } = seedWorkflow(graph);
    const engine = buildEngine();
    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
    await engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState,
      graph,
    });
    await waitForRunStatus(runId, 'COMPLETED');
    const row = ctx.db.select().from(schema.workflowRuns).where(eqRunId(runId)).get()!;
    const state = row.runState as { completedNodeIds: string[] };
    expect(state.completedNodeIds.sort()).toEqual(['A', 'B', 'T']);
  });

  it('fails instead of waiting forever when a failed node blocks downstream inputs', async () => {
    const graph: WorkflowGraph = {
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
        {
          id: 'S',
          type: 'skill_task',
          title: 'bad skill',
          position: { x: 100, y: 0 },
          config: { kind: 'skill_task', skillId: 'bad', inputMapping: {}, outputMapping: {} },
        },
        {
          id: 'D',
          type: 'merge',
          title: 'downstream',
          position: { x: 200, y: 0 },
          config: { kind: 'merge', requiredInputs: 'all' },
        },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'S' },
        { id: 'e2', source: 'S', target: 'D' },
      ],
    };
    const { wfId, runId } = seedWorkflow(graph);
    const skills = {
      execute: async () => ({ ok: false, errorCode: 'INTERNAL_ERROR', message: 'boom' }),
    } as unknown as SkillRuntime;
    const engine = buildEngine(skills);
    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
    await engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState,
      graph,
    });
    await waitForRunStatus(runId, 'FAILED');

    const row = ctx.db.select().from(schema.workflowRuns).where(eqRunId(runId)).get()!;
    expect(row.status).toBe('FAILED');
    const state = row.runState as { nodeStates: Record<string, { status: string }>; waitingInputs: Record<string, unknown> };
    expect(state.nodeStates.S?.status).toBe('FAILED');
    expect(state.nodeStates.D?.status).toBe('SKIPPED');
    expect(Object.keys(state.waitingInputs)).toHaveLength(0);
  });
});

// Tiny helper to keep drizzle eq import local.
import { eq } from 'drizzle-orm';
function eqRunId(runId: string) {
  return eq(schema.workflowRuns.id, runId);
}
