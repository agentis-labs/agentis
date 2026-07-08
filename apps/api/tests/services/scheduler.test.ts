import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { EventChainService, SchedulerService } from '../../src/services/scheduler.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: { drainWorkflowQueue: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  ctx = await createTestContext();
  engine = { drainWorkflowQueue: vi.fn().mockResolvedValue(undefined) };
});

afterEach(() => ctx.close());

function trivialGraph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: 'start',
        type: 'trigger',
        title: 'Manual',
        position: { x: 0, y: 0 },
        config: { kind: 'trigger', triggerType: 'manual' },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function seedWorkflow(title: string) {
  const id = randomUUID();
  const graph = trivialGraph();
  ctx.db.insert(schema.workflows).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title,
    graph,
    settings: {},
  }).run();
  return { id, graph };
}

function seedTrigger(workflowId: string) {
  const id = randomUUID();
  ctx.db.insert(schema.triggers).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    triggerType: 'manual',
    config: {},
    status: 'active',
  }).run();
  return id;
}

describe('SchedulerService', () => {
  it('fires due schedules by enqueueing a workflow run', async () => {
    const workflow = seedWorkflow('due');
    const triggerId = seedTrigger(workflow.id);
    const scheduleId = randomUUID();
    ctx.db.insert(schema.scheduleRuns).values({
      id: scheduleId,
      workspaceId: ctx.workspace.id,
      workflowId: workflow.id,
      triggerId,
      scheduledAt: new Date(Date.now() - 1_000).toISOString(),
      status: 'active',
    }).run();
    const captured = ctx.captureBus();
    try {
      const scheduler = new SchedulerService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });
      const fired = await scheduler.processDueSchedules(new Date());
      expect(fired).toBe(1);
      expect(engine.drainWorkflowQueue).toHaveBeenCalledWith(workflow.id);

      const schedule = ctx.db.select().from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, scheduleId)).get();
      expect(schedule?.status).toBe('disabled');
      const queueItem = ctx.db.select().from(schema.workflowRunQueue).where(eq(schema.workflowRunQueue.workflowId, workflow.id)).get();
      expect(queueItem?.reason).toBe('schedule_due');
      expect(queueItem?.triggerId).toBe(triggerId);
      const runId = (queueItem?.initialState as { runId?: string } | null)?.runId;
      expect(runId).toBeTruthy();
      expect(ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId!)).get()?.status).toBe('CREATED');
      expect(captured.events.some((event) => event.envelope.event === REALTIME_EVENTS.SCHEDULE_FIRED)).toBe(true);
    } finally {
      captured.stop();
    }
  });
});

describe('EventChainService', () => {
  it('queues target workflows from matching node events', async () => {
    const source = seedWorkflow('source');
    const target = seedWorkflow('target');
    const runId = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: source.id,
      userId: ctx.user.id,
      status: 'COMPLETED',
      runState: buildInitialRunState({ runId, workflowId: source.id, graph: source.graph, inputs: {} }) as unknown as object,
    }).run();
    ctx.db.insert(schema.workflowEventSubscriptions).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      sourceWorkflowId: source.id,
      targetWorkflowId: target.id,
      eventType: REALTIME_EVENTS.NODE_COMPLETED,
      sourceNodeId: 'N',
      inputMapping: { value: 'payload.output.value', sourceRunId: 'run.id' },
      coalescePolicy: 'always_enqueue',
      catchupPolicy: 'enqueue_missed_with_cap:5',
      enabled: true,
    }).run();
    const captured = ctx.captureBus();
    try {
      const service = new EventChainService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });
      const result = await service.handleMessage({
        room: `run:${runId}`,
        envelope: {
          event: REALTIME_EVENTS.NODE_COMPLETED,
          emittedAt: new Date().toISOString(),
          payload: { runId, nodeId: 'N', output: { value: 42 } },
        },
      });
      expect(result.fired).toBe(1);
      expect(engine.drainWorkflowQueue).toHaveBeenCalledWith(target.id);
      const queueItem = ctx.db.select().from(schema.workflowRunQueue).where(eq(schema.workflowRunQueue.workflowId, target.id)).get();
      expect(queueItem?.parentRunId).toBe(runId);
      expect(queueItem?.inputs).toEqual({ value: 42, sourceRunId: runId });
      const targetRunId = (queueItem?.initialState as { runId?: string } | null)?.runId;
      expect(ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, targetRunId!)).get()?.parentRunId).toBe(runId);
      expect(captured.events.some((event) => event.envelope.event === REALTIME_EVENTS.EVENT_CHAIN_FIRED)).toBe(true);
    } finally {
      captured.stop();
    }
  });
});
