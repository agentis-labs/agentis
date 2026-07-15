import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { buildSchedulerRoutes } from '../../src/routes/scheduler.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/scheduler', app: buildSchedulerRoutes({ db: ctx.db, auth: ctx.auth }) }]);
}

function seedWorkflowAndTrigger() {
  const workflowId = randomUUID();
  const triggerId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'scheduled',
    graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, variables: [] },
    settings: {},
  }).run();
  ctx.db.insert(schema.triggers).values({
    id: triggerId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    triggerType: 'cron',
    config: { cron: '* * * * *' },
    status: 'active',
  }).run();
  return { workflowId, triggerId };
}

describe('/v1/scheduler', () => {
  it('creates and lists schedules', async () => {
    const seeded = seedWorkflowAndTrigger();
    const scheduledAt = new Date(Date.now() + 60_000).toISOString();
    const create = await app().request('/v1/scheduler/schedules', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ ...seeded, scheduledAt }),
    });
    expect(create.status).toBe(201);

    const list = await app().request('/v1/scheduler/schedules', { headers: ctx.authHeaders });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { schedules: Array<{ workflowId: string }> };
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0]!.workflowId).toBe(seeded.workflowId);
  });

  it('creates and promotes queue items', async () => {
    const seeded = seedWorkflowAndTrigger();
    const queueId = randomUUID();
    ctx.db.insert(schema.workflowRunQueue).values({
      id: queueId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: seeded.workflowId,
      userId: ctx.user.id,
      triggerId: seeded.triggerId,
      inputs: {},
      priority: 0,
      reason: 'scheduled',
      status: 'pending',
    }).run();

    const promote = await app().request(`/v1/scheduler/queue/${queueId}/promote`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(promote.status).toBe(200);
    const row = ctx.db.select().from(schema.workflowRunQueue).where(eq(schema.workflowRunQueue.id, queueId)).get();
    expect(row?.priority).toBe(1);
  });

  it('lists durable event deliveries and safely releases dead ones for retry', async () => {
    const source = seedWorkflowAndTrigger();
    const target = seedWorkflowAndTrigger();
    const sourceRunId = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({
      id: sourceRunId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: source.workflowId,
      userId: ctx.user.id,
      status: 'COMPLETED',
      runState: {},
    }).run();
    const subscriptionId = randomUUID();
    ctx.db.insert(schema.workflowEventSubscriptions).values({
      id: subscriptionId,
      workspaceId: ctx.workspace.id,
      sourceWorkflowId: source.workflowId,
      targetWorkflowId: target.workflowId,
      eventType: 'run.completed',
    }).run();
    const deliveryId = randomUUID();
    ctx.db.insert(schema.workflowEventDeliveries).values({
      id: deliveryId,
      workspaceId: ctx.workspace.id,
      subscriptionId,
      eventIdentity: randomUUID(),
      eventType: 'run.completed',
      eventPayload: { runId: sourceRunId },
      eventEmittedAt: new Date().toISOString(),
      sourceRunId,
      status: 'dead',
      attempts: 5,
      availableAt: new Date().toISOString(),
      lastError: 'transient outage',
    }).run();

    const list = await app().request('/v1/scheduler/deliveries', { headers: ctx.authHeaders });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { deliveries: unknown[] }).deliveries).toHaveLength(1);

    const retry = await app().request(`/v1/scheduler/deliveries/${deliveryId}/retry`, {
      method: 'POST', headers: ctx.authHeaders,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, status: 'pending', replayed: true });
    expect(ctx.db.select().from(schema.workflowEventDeliveries).where(eq(schema.workflowEventDeliveries.id, deliveryId)).get())
      .toMatchObject({ status: 'pending', lastError: null });

    ctx.db.update(schema.workflowEventDeliveries).set({ status: 'delivered', targetRunId: sourceRunId })
      .where(eq(schema.workflowEventDeliveries.id, deliveryId)).run();
    const noDuplicate = await app().request(`/v1/scheduler/deliveries/${deliveryId}/retry`, {
      method: 'POST', headers: ctx.authHeaders,
    });
    expect(await noDuplicate.json()).toMatchObject({ ok: true, status: 'delivered', replayed: false, targetRunId: sourceRunId });
  });
});
