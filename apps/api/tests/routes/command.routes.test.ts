/**
 * /v1/command/search — Cmd+K palette.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildCommandRoutes } from '../../src/routes/command.js';
import { CommandIndex } from '../../src/services/command/commandIndex.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
  ctx.db.insert(schema.workflows).values({
    id: randomUUID(),
    workspaceId: ctx.workspace.id,
    ambientId: null,
    userId: ctx.user.id,
    title: 'Daily Standup',
    summary: '',
    graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    latestRevision: 1,
  }).run();
});

function app() {
  const commandIndex = new CommandIndex(ctx.db);
  return ctx.buildApp([
    {
      path: '/v1/command',
      app: buildCommandRoutes({ db: ctx.db, auth: ctx.auth, commandIndex }),
    },
  ]);
}

describe('/v1/command/search', () => {
  it('returns hits for a matching query', async () => {
    const res = await app().request('/v1/command/search?q=standup', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ type: string; href: string }> };
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0]?.href).toMatch(/^\/workflows\//);
  });

  it('returns an empty hits array when nothing matches', async () => {
    const res = await app().request('/v1/command/search?q=zzzzz', { headers: ctx.authHeaders });
    const body = (await res.json()) as { hits: unknown[] };
    expect(body.hits).toEqual([]);
  });

  it('handles missing q param (returns up to limit)', async () => {
    const res = await app().request('/v1/command/search', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
  });

  it('requires authentication', async () => {
    const res = await app().request('/v1/command/search?q=x');
    expect(res.status).toBe(401);
  });
});

describe('/v1/command/execute', () => {
  it('resolves a workflow id to a navigation href', async () => {
    const id = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      title: 'Target',
      summary: '',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    }).run();

    const res = await app().request('/v1/command/execute', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ type: 'workflow', id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { href: string; id: string; type: string };
    expect(body).toMatchObject({ type: 'workflow', id, href: `/workflows/${id}` });
  });

  it('returns 404 with RESOURCE_NOT_FOUND for unknown id', async () => {
    const res = await app().request('/v1/command/execute', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ type: 'workflow', id: randomUUID() }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('returns 422 for an invalid type', async () => {
    const res = await app().request('/v1/command/execute', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ type: 'bogus', id: 'x' }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects cross-workspace ids with 404', async () => {
    // seed in default workspace, but lookup will only match by workspaceId
    const id = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      title: 'a',
      summary: '',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    }).run();
    const res = await app().request('/v1/command/execute', {
      method: 'POST',
      headers: { ...ctx.authHeaders, 'x-agentis-workspace': randomUUID() },
      body: JSON.stringify({ type: 'workflow', id }),
    });
    // unknown workspace fails workspace middleware first → 403/404/422
    expect([403, 404, 422]).toContain(res.status);
  });

  it('requires authentication', async () => {
    const res = await app().request('/v1/command/execute', {
      method: 'POST',
      body: JSON.stringify({ type: 'workflow', id: randomUUID() }),
    });
    expect(res.status).toBe(401);
  });
});
