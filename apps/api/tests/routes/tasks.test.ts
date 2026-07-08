/**
 * /v1/tasks — route unit tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildTaskRoutes } from '../../src/routes/tasks.js';
import { AgentSessionService } from '../../src/services/agent/agentSession.js';
import { PlanService } from '../../src/services/planService.js';
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

function spineApp(plans: PlanService, sessions: AgentSessionService) {
  return ctx.buildApp([
    { path: '/v1/tasks', app: buildTaskRoutes({ db: ctx.db, auth: ctx.auth, plans, sessions }) },
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

describe('task spine inspector routes', () => {
  it('redirects a task spine by recording a decision and injecting session observations', async () => {
    const plans = new PlanService(ctx.db, ctx.bus);
    const sessions = new AgentSessionService(ctx.db, ctx.logger);
    const realtimeEvents: string[] = [];
    const unsubscribe = ctx.bus.subscribe((msg) => {
      if (msg.room === REALTIME_ROOMS.workspace(ctx.workspace.id)) realtimeEvents.push(msg.envelope.event);
    });
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Agent',
      adapterType: 'http',
      capabilityTags: [],
      config: {},
      status: 'offline',
    }).run();
    const session = sessions.create({
      agentId,
      workspaceId: ctx.workspace.id,
      runId: randomUUID(),
      nodeId: 'S',
      taskBlock: 'Original task',
    });
    const task = plans.createTask({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      objective: 'Handle a long task',
    });
    plans.bindSession(ctx.workspace.id, ctx.user.id, task.id, session.id);

    const res = await spineApp(plans, sessions).request(`/v1/tasks/spines/${task.id}/redirect`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ instruction: 'Use the safer path.', reason: 'Operator correction' }),
    });
    unsubscribe();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { injected: boolean; task: { decisions: Array<{ summary: string }> } };
    const updatedSession = sessions.get(session.id)!;
    expect(body.injected).toBe(true);
    expect(body.task.decisions[0]?.summary).toBe('Operator redirected task');
    expect(updatedSession.observationsBlock).toContain('Use the safer path.');
    expect(realtimeEvents).toContain(REALTIME_EVENTS.TASK_SPINE_DECISION_RECORDED);
    expect(realtimeEvents).toContain(REALTIME_EVENTS.TASK_SPINE_REDIRECTED);
  });
});
