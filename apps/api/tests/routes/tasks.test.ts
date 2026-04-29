/**
 * /v1/tasks — route unit tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildTaskRoutes } from '../../src/routes/tasks.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function app() {
  return ctx.buildApp([
    { path: '/v1/tasks', app: buildTaskRoutes({ db: ctx.db, auth: ctx.auth }) },
  ]);
}

function seedTask(executorRef: string = randomUUID()) {
  const id = randomUUID();
  const wfId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'WF',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      settings: {},
    })
    .run();
  ctx.db
    .insert(schema.tasks)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      runId: null,
      userId: ctx.user.id,
      nodeId: 'n1',
      title: 'Task',
      description: 'desc',
      executorType: 'agent',
      executorRef,
      capabilityTags: [],
      status: 'PENDING',
      inputData: {},
    })
    .run();
  return { id, executorRef };
}

describe('GET /v1/tasks', () => {
  it('lists workspace tasks', async () => {
    seedTask();
    seedTask();
    const res = await app().request('/v1/tasks', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(2);
  });

  it('filters by ?agentId', async () => {
    const { executorRef } = seedTask();
    seedTask(); // different agent
    const res = await app().request(`/v1/tasks?agentId=${executorRef}`, { headers: ctx.authHeaders });
    const body = (await res.json()) as { tasks: Array<{ executorRef: string }> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].executorRef).toBe(executorRef);
  });

  it('clamps ?limit', async () => {
    for (let i = 0; i < 3; i++) seedTask();
    const res = await app().request('/v1/tasks?limit=2', { headers: ctx.authHeaders });
    const body = (await res.json()) as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(2);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/tasks');
    expect(res.status).toBe(401);
  });
});
