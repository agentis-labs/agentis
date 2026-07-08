/**
 * /v1/interactions — unified agent↔agent interaction feed (Pillar 4).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildInteractionRoutes } from '../../src/routes/interactions.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/interactions', app: buildInteractionRoutes({ db: ctx.db, auth: ctx.auth }) }]);
}

function seedRoom(): string {
  const id = randomUUID();
  ctx.db.insert(schema.rooms).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'War room', kind: 'custom',
  }).run();
  return id;
}

function seedAgentMessage(roomId: string, agentId: string, text: string, at: string): void {
  ctx.db.insert(schema.roomMessages).values({
    id: randomUUID(), roomId, workspaceId: ctx.workspace.id,
    authorType: 'agent', authorId: agentId, contentType: 'text', content: { text }, createdAt: at,
  }).run();
}

function seedActivity(agentId: string, eventType: string, summary: string, at: string): void {
  ctx.db.insert(schema.activityEvents).values({
    id: randomUUID(), workspaceId: ctx.workspace.id, userId: ctx.user.id,
    eventType, actorType: 'agent', actorId: agentId, entityType: 'agent', entityId: agentId,
    summary, createdAt: at,
  }).run();
}

describe('/v1/interactions', () => {
  it('merges agent messages and agent activity into one newest-first timeline', async () => {
    const roomId = seedRoom();
    seedAgentMessage(roomId, 'agent-a', 'Delegating the research to you', '2026-05-31T10:00:00.000Z');
    seedActivity('agent-b', 'task_delegated', 'agent-a delegated a task to agent-b', '2026-05-31T10:00:01.000Z');
    seedAgentMessage(roomId, 'agent-b', 'On it', '2026-05-31T10:00:02.000Z');

    const res = await app().request('/v1/interactions', { headers: ctx.authHeaders });
    const body = await res.json() as { events: Array<{ kind: string; eventType: string; at: string; summary: string }> };
    expect(body.events).toHaveLength(3);
    // Newest first.
    expect(body.events[0]!.summary).toBe('On it');
    expect(body.events[1]!.eventType).toBe('task_delegated');
    expect(body.events[1]!.kind).toBe('activity');
    expect(body.events[2]!.kind).toBe('message');
  });

  it('filters by agentId', async () => {
    const roomId = seedRoom();
    seedAgentMessage(roomId, 'agent-a', 'hello from a', '2026-05-31T10:00:00.000Z');
    seedAgentMessage(roomId, 'agent-b', 'hello from b', '2026-05-31T10:00:01.000Z');

    const res = await app().request('/v1/interactions?agentId=agent-a', { headers: ctx.authHeaders });
    const body = await res.json() as { events: Array<{ actor: { id: string } }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.actor.id).toBe('agent-a');
  });

  it('excludes operator/system messages (agent-to-agent only)', async () => {
    const roomId = seedRoom();
    ctx.db.insert(schema.roomMessages).values({
      id: randomUUID(), roomId, workspaceId: ctx.workspace.id,
      authorType: 'operator', authorId: ctx.user.id, contentType: 'text', content: { text: 'operator note' },
    }).run();
    const res = await app().request('/v1/interactions', { headers: ctx.authHeaders });
    const body = await res.json() as { events: unknown[] };
    expect(body.events).toHaveLength(0);
  });
});
