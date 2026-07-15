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

function seedSubscription(sourceWorkflowId: string, targetWorkflowId: string, eventType = REALTIME_EVENTS.NODE_COMPLETED) {
  const id = randomUUID();
  ctx.db.insert(schema.workflowEventSubscriptions).values({
    id,
    workspaceId: ctx.workspace.id,
    sourceWorkflowId,
    targetWorkflowId,
    eventType,
    sourceNodeId: eventType === REALTIME_EVENTS.NODE_COMPLETED ? 'N' : null,
    inputMapping: { value: 'payload.output.value', sourceRunId: 'run.id' },
    coalescePolicy: 'always_enqueue',
    catchupPolicy: 'enqueue_missed_with_cap:5',
    enabled: true,
  }).run();
  return id;
}

function seedCompletedRun(workflowId: string, graph: WorkflowGraph) {
  const runId = randomUUID();
  ctx.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status: 'COMPLETED',
    runState: buildInitialRunState({ runId, workflowId, graph, inputs: {} }) as unknown as object,
  }).run();
  return runId;
}

function nodeCompletedMessage(runId: string, emittedAt = new Date().toISOString()) {
  return {
    room: `run:${runId}`,
    envelope: {
      event: REALTIME_EVENTS.NODE_COMPLETED,
      emittedAt,
      payload: { runId, nodeId: 'N', output: { value: 42 } },
    },
  } as const;
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

  it('deduplicates replayed events even when their transport timestamp changes', async () => {
    const source = seedWorkflow('source');
    const target = seedWorkflow('target');
    const runId = seedCompletedRun(source.id, source.graph);
    seedSubscription(source.id, target.id);
    const service = new EventChainService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });

    expect((await service.handleMessage(nodeCompletedMessage(runId, '2026-01-01T00:00:00.000Z'))).fired).toBe(1);
    expect((await service.handleMessage(nodeCompletedMessage(runId, '2026-01-01T00:01:00.000Z'))).fired).toBe(0);

    expect(ctx.db.select().from(schema.workflowEventDeliveries).all()).toHaveLength(1);
    expect(ctx.db.select().from(schema.workflowRunQueue).where(eq(schema.workflowRunQueue.workflowId, target.id)).all()).toHaveLength(1);
    expect(ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workflowId, target.id)).all()).toHaveLength(1);
  });

  it('closes the enqueue-before-ack crash window with the same target run after restart', async () => {
    const source = seedWorkflow('source');
    const target = seedWorkflow('target');
    const runId = seedCompletedRun(source.id, source.graph);
    seedSubscription(source.id, target.id);
    const crashingEngine = {
      drainWorkflowQueue: vi.fn().mockRejectedValueOnce(new Error('process died after durable enqueue')),
    };
    const firstProcess = new EventChainService({
      db: ctx.db, bus: ctx.bus, engine: crashingEngine as unknown as WorkflowEngine, logger: ctx.logger,
    });
    expect((await firstProcess.handleMessage(nodeCompletedMessage(runId))).fired).toBe(0);

    const delivery = ctx.db.select().from(schema.workflowEventDeliveries).get()!;
    const originalQueue = ctx.db.select().from(schema.workflowRunQueue).where(eq(schema.workflowRunQueue.workflowId, target.id)).get()!;
    const originalRunId = originalQueue.runId;
    expect(delivery.status).toBe('pending');

    const restarted = new EventChainService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });
    expect(await restarted.retryDelivery(delivery.id)).toBe(true);
    const recovered = ctx.db.select().from(schema.workflowEventDeliveries).where(eq(schema.workflowEventDeliveries.id, delivery.id)).get()!;
    expect(recovered.status).toBe('delivered');
    expect(recovered.targetQueueId).toBe(originalQueue.id);
    expect(recovered.targetRunId).toBe(originalRunId);
    expect(ctx.db.select().from(schema.workflowRunQueue).where(eq(schema.workflowRunQueue.workflowId, target.id)).all()).toHaveLength(1);
    expect(ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workflowId, target.id)).all()).toHaveLength(1);
  });

  it('reclaims an expired delivery lease and resumes it after a process crash', async () => {
    const source = seedWorkflow('source');
    const target = seedWorkflow('target');
    const runId = seedCompletedRun(source.id, source.graph);
    const subscriptionId = seedSubscription(source.id, target.id);
    const deliveryId = randomUUID();
    ctx.db.insert(schema.workflowEventDeliveries).values({
      id: deliveryId,
      workspaceId: ctx.workspace.id,
      subscriptionId,
      eventIdentity: randomUUID(),
      eventType: REALTIME_EVENTS.NODE_COMPLETED,
      eventPayload: { runId, nodeId: 'N', output: { value: 42 } },
      eventEmittedAt: '2026-01-01T00:00:00.000Z',
      sourceRunId: runId,
      sourceNodeId: 'N',
      status: 'processing',
      attempts: 1,
      availableAt: '2026-01-01T00:00:00.000Z',
      leaseOwner: 'dead-process',
      leaseExpiresAt: '2026-01-01T00:00:01.000Z',
    }).run();

    const restarted = new EventChainService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });
    expect(await restarted.poll(new Date('2026-01-01T00:01:00.000Z'))).toBe(1);
    const recovered = ctx.db.select().from(schema.workflowEventDeliveries).where(eq(schema.workflowEventDeliveries.id, deliveryId)).get()!;
    expect(recovered.status).toBe('delivered');
    expect(recovered.attempts).toBe(2);
  });

  it('uses an atomic claim when two consumers receive the same event concurrently', async () => {
    const source = seedWorkflow('source');
    const target = seedWorkflow('target');
    const runId = seedCompletedRun(source.id, source.graph);
    seedSubscription(source.id, target.id);
    const left = new EventChainService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });
    const right = new EventChainService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });
    const results = await Promise.all([
      left.handleMessage(nodeCompletedMessage(runId)),
      right.handleMessage(nodeCompletedMessage(runId)),
    ]);
    expect(results.reduce((sum, item) => sum + item.fired, 0)).toBe(1);
    expect(ctx.db.select().from(schema.workflowRunQueue).where(eq(schema.workflowRunQueue.workflowId, target.id)).all()).toHaveLength(1);
  });

  it('recovers a terminal source event lost between state commit and bus publish', async () => {
    const source = seedWorkflow('source');
    const target = seedWorkflow('target');
    const subscriptionId = randomUUID();
    ctx.db.insert(schema.workflowEventSubscriptions).values({
      id: subscriptionId,
      workspaceId: ctx.workspace.id,
      sourceWorkflowId: source.id,
      targetWorkflowId: target.id,
      eventType: REALTIME_EVENTS.RUN_ACCOMPLISHED,
      inputMapping: { sourceRunId: 'run.id' },
      coalescePolicy: 'always_enqueue',
      catchupPolicy: 'enqueue_missed_with_cap:5',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const runId = seedCompletedRun(source.id, source.graph);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    ctx.db.update(schema.workflowRuns).set({
      runState: { ...(run.runState as object), verdict: { outcome: 'accomplished' } },
      createdAt: '2026-01-01T00:01:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
    }).where(eq(schema.workflowRuns.id, runId)).run();

    const restarted = new EventChainService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });
    expect(await restarted.recoverMissedEvents()).toBe(1);
    const delivery = ctx.db.select().from(schema.workflowEventDeliveries).get();
    expect(delivery).toMatchObject({ status: 'delivered', eventType: REALTIME_EVENTS.RUN_ACCOMPLISHED, sourceRunId: runId });
    expect(ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workflowId, target.id)).all()).toHaveLength(1);
  });
});

describe('durable scheduler recovery', () => {
  it('retries a schedule after an enqueue crash without creating another run', async () => {
    const workflow = seedWorkflow('scheduled');
    const triggerId = seedTrigger(workflow.id);
    const scheduleId = randomUUID();
    ctx.db.insert(schema.scheduleRuns).values({
      id: scheduleId,
      workspaceId: ctx.workspace.id,
      workflowId: workflow.id,
      triggerId,
      scheduledAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
    }).run();
    const flakyEngine = { drainWorkflowQueue: vi.fn()
      .mockRejectedValueOnce(new Error('crash after queue commit'))
      .mockResolvedValue(undefined) };
    const scheduler = new SchedulerService({ db: ctx.db, bus: ctx.bus, engine: flakyEngine as unknown as WorkflowEngine, logger: ctx.logger });

    expect(await scheduler.processDueSchedules(new Date('2026-01-01T00:01:00.000Z'))).toBe(0);
    expect(await scheduler.processDueSchedules(new Date('2026-01-01T00:02:00.000Z'))).toBe(1);
    expect(ctx.db.select().from(schema.workflowRunQueue).where(eq(schema.workflowRunQueue.workflowId, workflow.id)).all()).toHaveLength(1);
    expect(ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workflowId, workflow.id)).all()).toHaveLength(1);
    expect(ctx.db.select().from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, scheduleId)).get()?.status).toBe('disabled');
  });

  it('releases a stale queue claim only when its run never left CREATED', async () => {
    const workflow = seedWorkflow('recover queue');
    const runId = seedCompletedRun(workflow.id, workflow.graph);
    ctx.db.update(schema.workflowRuns).set({ status: 'CREATED' }).where(eq(schema.workflowRuns.id, runId)).run();
    ctx.db.insert(schema.workflowRunQueue).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: workflow.id,
      userId: ctx.user.id,
      inputs: {},
      initialState: buildInitialRunState({ runId, workflowId: workflow.id, graph: workflow.graph, inputs: {} }) as unknown as object,
      graphSnapshot: workflow.graph,
      reason: 'recovery-test',
      runId,
      status: 'dequeued',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const scheduler = new SchedulerService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });
    expect((await scheduler.tick(new Date('2026-01-01T01:00:00.000Z'))).queues).toBe(1);
    expect(engine.drainWorkflowQueue).toHaveBeenCalledWith(workflow.id);
  });
});
