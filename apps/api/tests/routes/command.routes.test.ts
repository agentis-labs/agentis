/**
 * /v1/command/search — Cmd+K palette.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildCommandRoutes } from '../../src/routes/command.js';
import { CommandIndex } from '../../src/services/commandIndex.js';
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
