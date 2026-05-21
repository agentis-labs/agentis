import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildHistoryRoutes } from '../../src/routes/history.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/history',
      app: buildHistoryRoutes({ db: ctx.db, auth: ctx.auth }),
    },
  ]);
}

describe('GET /v1/history', () => {
  it('returns run, activity, and audit events from the active workspace', async () => {
    const workflowId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'Daily review',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    }).run();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      status: 'COMPLETED',
      runState: {},
    }).run();
    ctx.db.insert(schema.activityEvents).values([
      {
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        eventType: 'agent.task.completed',
        actorType: 'agent',
        actorId: null,
        entityType: 'task',
        entityId: 'task-1',
        summary: 'Agent completed task',
        metadata: {},
      },
      {
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        eventType: 'agent.update',
        actorType: 'user',
        actorId: ctx.user.id,
        entityType: 'agent',
        entityId: 'agent-1',
        summary: 'operator update agent agent-1',
        metadata: { method: 'PATCH', path: '/v1/agents/agent-1' },
      },
    ]).run();

    const all = await app().request('/v1/history?type=all&limit=10', { headers: ctx.authHeaders });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { events: Array<{ title: string; type: string }> };
    expect(allBody.events.map((event) => event.title)).toContain('Daily review completed');
    expect(allBody.events.map((event) => event.title)).toContain('Agent completed task');
    expect(allBody.events.map((event) => event.type)).toContain('audit');

    const audit = await app().request('/v1/history?type=audit&limit=10', { headers: ctx.authHeaders });
    const auditBody = (await audit.json()) as { events: Array<{ type: string }> };
    expect(auditBody.events).toHaveLength(1);
    expect(auditBody.events[0]!.type).toBe('audit');
  });
});
