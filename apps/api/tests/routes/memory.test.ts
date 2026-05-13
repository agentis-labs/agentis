/**
 * /v1/memory — Persistent Memory route tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { buildMemoryRoutes } from '../../src/routes/memory.js';
import { TeamService } from '../../src/services/teams.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let teams: TeamService;

beforeEach(async () => {
  ctx = await createTestContext();
  teams = new TeamService(ctx.db, ctx.bus);
});

function app() {
  return ctx.buildApp([
    { path: '/v1/memory', app: buildMemoryRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus }) },
  ]);
}

describe('/v1/memory', () => {
  it('creates workspace memory and finds it by query', async () => {
    const capture = ctx.captureBus();
    try {
      const create = await app().request('/v1/memory', {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({ title: 'Pricing rule', content: 'Enterprise quotes require founder review.', kind: 'policy', importance: 8, tags: ['sales'] }),
      });
      expect(create.status).toBe(201);
      const created = (await create.json()) as { memory: { id: string; teamId: string | null; title: string } };
      expect(created.memory).toMatchObject({ teamId: null, title: 'Pricing rule' });
      expect(capture.events).toContainEqual(expect.objectContaining({
        room: REALTIME_ROOMS.workspace(ctx.workspace.id),
        envelope: expect.objectContaining({ event: REALTIME_EVENTS.MEMORY_WRITTEN }),
      }));

      const list = await app().request('/v1/memory?q=founder&kind=policy', { headers: ctx.authHeaders });
      expect(list.status).toBe(200);
      const body = (await list.json()) as { memory: Array<{ id: string }> };
      expect(body.memory.map((entry) => entry.id)).toEqual([created.memory.id]);
    } finally {
      capture.stop();
    }
  });

  it('filters team memory and updates scoped fields', async () => {
    const team = teams.create({ workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Operations' });
    const create = await app().request('/v1/memory', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ teamId: team.id, title: 'Ops fact', content: 'Batch jobs run after approvals clear.', importance: 4 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { memory: { id: string } };

    const patch = await app().request(`/v1/memory/${created.memory.id}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ importance: 10, tags: ['ops', 'jobs'], metadata: { source: 'operator-note' } }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { memory: { importance: number; tags: string[]; metadata: { source?: string } } };
    expect(patched.memory.importance).toBe(10);
    expect(patched.memory.tags).toEqual(['ops', 'jobs']);
    expect(patched.memory.metadata.source).toBe('operator-note');

    const list = await app().request(`/v1/memory?teamId=${team.id}`, { headers: ctx.authHeaders });
    const body = (await list.json()) as { memory: Array<{ id: string; teamId: string }> };
    expect(body.memory).toMatchObject([{ id: created.memory.id, teamId: team.id }]);
  });

  it('archives memory and hides it unless includeArchived=1', async () => {
    const create = await app().request('/v1/memory', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ title: 'Temporary note', content: 'Only visible until archived.' }),
    });
    const created = (await create.json()) as { memory: { id: string } };

    const archive = await app().request(`/v1/memory/${created.memory.id}`, { method: 'DELETE', headers: ctx.authHeaders });
    expect(archive.status).toBe(200);

    const hidden = await app().request('/v1/memory?q=temporary', { headers: ctx.authHeaders });
    expect((await hidden.json()) as { memory: unknown[] }).toMatchObject({ memory: [] });

    const visible = await app().request('/v1/memory?q=temporary&includeArchived=1', { headers: ctx.authHeaders });
    const body = (await visible.json()) as { memory: Array<{ id: string; archivedAt: string | null }> };
    expect(body.memory).toHaveLength(1);
    expect(body.memory[0]?.id).toBe(created.memory.id);
    expect(body.memory[0]?.archivedAt).toEqual(expect.any(String));
  });

  it('rejects unknown team scope', async () => {
    const res = await app().request('/v1/memory', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ teamId: '00000000-0000-0000-0000-000000000000', title: 'Bad scope', content: 'Should fail.' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('rejects unauthenticated access', async () => {
    const res = await app().request('/v1/memory');
    expect(res.status).toBe(401);
  });
});