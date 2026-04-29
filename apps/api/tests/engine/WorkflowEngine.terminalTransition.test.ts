/**
 * WorkflowEngine — terminal transition notifies SubflowExecutor.
 *
 * D15 / D23 contract: when a child run reaches a terminal status
 * (COMPLETED | FAILED | CANCELLED) AND its workflowRuns row has a
 * non-null parentRunId AND a SubflowExecutor is wired in, the engine
 * MUST call subflows.findParentByChildRunId() and then
 * subflows.onChildRunFinished() so the parent run can resume the parent
 * subflow node.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import type { SkillRuntime } from '../../src/services/skillRuntime.js';
import type { SubflowExecutor } from '../../src/services/subflowExecutor.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

interface SubflowStub {
  findParentByChildRunId: ReturnType<typeof vi.fn>;
  onChildRunFinished: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

function buildEngine(subflows: SubflowStub) {
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  const skills = {} as unknown as SkillRuntime;
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
    subflows: subflows as unknown as SubflowExecutor,
  });
}

function trivialGraph(): WorkflowGraph {
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

function seedRun(opts: { parentRunId: string | null }) {
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'child-wf',
      graph: trivialGraph(),
      settings: {},
    })
    .run();
  const values: Record<string, unknown> = {
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: wfId,
    userId: ctx.user.id,
    status: 'CREATED',
    runState: {},
  };
  if (opts.parentRunId) values.parentRunId = opts.parentRunId;
  ctx.db.insert(schema.workflowRuns).values(values as never).run();
  return { wfId, runId };
}

function waitForCompleted(runId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for COMPLETED on ${runId}`)), 2000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

describe('WorkflowEngine — terminal transition + subflow notify', () => {
  it('notifies SubflowExecutor when a child run completes', async () => {
    const parentRunId = randomUUID();
    const { wfId, runId } = seedRun({ parentRunId });
    const subflows: SubflowStub = {
      findParentByChildRunId: vi
        .fn()
        .mockReturnValue({ parentRunId, parentNodeId: 'parent-node-1' }),
      onChildRunFinished: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(),
    };
    const engine = buildEngine(subflows);
    const graph = trivialGraph();
    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: { hi: 1 } });
    await engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: { hi: 1 },
      initialState,
      graph,
    });
    await waitForCompleted(runId);

    expect(subflows.findParentByChildRunId).toHaveBeenCalledWith(runId);
    expect(subflows.onChildRunFinished).toHaveBeenCalledOnce();
    const call = subflows.onChildRunFinished.mock.calls[0]![0] as {
      childRunId: string;
      parentRunId: string;
      parentNodeId: string;
      status: string;
      workspaceId: string;
    };
    expect(call.childRunId).toBe(runId);
    expect(call.parentRunId).toBe(parentRunId);
    expect(call.parentNodeId).toBe('parent-node-1');
    expect(call.status).toBe('COMPLETED');
    expect(call.workspaceId).toBe(ctx.workspace.id);
  });

  it('does NOT notify SubflowExecutor when run has no parentRunId', async () => {
    const { wfId, runId } = seedRun({ parentRunId: null });
    const subflows: SubflowStub = {
      findParentByChildRunId: vi.fn(),
      onChildRunFinished: vi.fn(),
      start: vi.fn(),
    };
    const engine = buildEngine(subflows);
    const graph = trivialGraph();
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
    await waitForCompleted(runId);

    expect(subflows.findParentByChildRunId).not.toHaveBeenCalled();
    expect(subflows.onChildRunFinished).not.toHaveBeenCalled();
  });

  it('skips notification if findParentByChildRunId returns null (registration lost)', async () => {
    const parentRunId = randomUUID();
    const { wfId, runId } = seedRun({ parentRunId });
    const subflows: SubflowStub = {
      findParentByChildRunId: vi.fn().mockReturnValue(null),
      onChildRunFinished: vi.fn(),
      start: vi.fn(),
    };
    const engine = buildEngine(subflows);
    const graph = trivialGraph();
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
    await waitForCompleted(runId);

    expect(subflows.findParentByChildRunId).toHaveBeenCalledWith(runId);
    expect(subflows.onChildRunFinished).not.toHaveBeenCalled();
    // Parent run row untouched.
    const parentRow = ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
    expect(parentRow?.status).toBe('COMPLETED');
  });
});
