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
});