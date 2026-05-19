/**
 * /v1/teams — Fleet Organization Layer route tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildTeamRoutes } from '../../src/routes/teams.js';
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
    { path: '/v1/teams', app: buildTeamRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus, teams }) },
  ]);
}

describe('/v1/teams', () => {
  it('lists ambient-backed teams and creates missing context rows', async () => {
    const res = await app().request('/v1/teams', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { teams: Array<{ id: string; ambientId: string; stats: { agents: number } }> };
    expect(body.teams).toHaveLength(1);
    expect(body.teams[0]).toMatchObject({ id: ctx.ambient.id, ambientId: ctx.ambient.id, stats: { agents: 0 } });

    const context = ctx.db.select().from(schema.teamContext).all();
    expect(context).toHaveLength(1);
    expect(context[0]?.teamId).toBe(ctx.ambient.id);
  });

  it('creates a team, ambient, and context row', async () => {
    const capture = ctx.captureBus();
    try {
      const res = await app().request('/v1/teams', {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({ name: 'Engineering', description: 'Build and review product systems.', colorHex: '#2f7dd1' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { team: { id: string; ambientId: string; name: string; slug: string } };
      expect(body.team).toMatchObject({ name: 'Engineering', slug: 'engineering' });
      expect(body.team.id).toBe(body.team.ambientId);

      expect(ctx.db.select().from(schema.ambients).all().some((ambient) => ambient.id === body.team.ambientId)).toBe(true);
      expect(ctx.db.select().from(schema.teamContext).all().some((context) => context.teamId === body.team.id)).toBe(true);
      expect(capture.events).toContainEqual(expect.objectContaining({
        room: REALTIME_ROOMS.workspace(ctx.workspace.id),
        envelope: expect.objectContaining({ event: REALTIME_EVENTS.TEAM_CREATED }),
      }));
    } finally {
      capture.stop();
    }
  });

  it('updates team context and can apply a Team Architect proposal', async () => {
    const created = await app().request('/v1/teams', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'Research' }),
    });
    const { team } = (await created.json()) as { team: { id: string } };

    const contextRes = await app().request(`/v1/teams/${team.id}/context`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ operatingPrinciples: 'Use sourced evidence.', sharedPrompt: 'Research durable market signals.' }),
    });
    expect(contextRes.status).toBe(200);
    const contextBody = (await contextRes.json()) as { context: { operatingPrinciples: string; sharedPrompt: string } };
    expect(contextBody.context.operatingPrinciples).toBe('Use sourced evidence.');
    expect(contextBody.context.sharedPrompt).toBe('Research durable market signals.');

    const designRes = await app().request(`/v1/teams/${team.id}/design`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ brief: 'Competitive research and insight synthesis', applyContext: true }),
    });
    expect(designRes.status).toBe(200);
    const designBody = (await designRes.json()) as {
      applied: boolean;
      proposal: { agents: Array<{ name: string }> };
      context: { sharedPrompt: string; handoffs: string };
    };
    expect(designBody.applied).toBe(true);
    expect(designBody.proposal.agents.map((agent) => agent.name)).toContain('Research Lead');
    expect(designBody.context.sharedPrompt).toContain('Competitive research');
    expect(designBody.context.handoffs).toContain('Research Lead');
  });

  it('rejects unauthenticated access', async () => {
    const res = await app().request('/v1/teams');
    expect(res.status).toBe(401);
  });
});