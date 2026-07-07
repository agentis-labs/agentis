/**
 * /v1/mission — the Mission Control read model (§3.6): resident agents, the subject
 * pipeline (on the spine), and per-variant experiment results.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildMissionControlRoutes } from '../../src/routes/missionControl.js';
import { DurableEntityService } from '../../src/services/durableEntities.js';
import { ExperimentService } from '../../src/services/experiments.js';
import { ConnectionGrantService } from '../../src/services/connectionGrants.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function mkApp() {
  return ctx.buildApp([{
    path: '/v1/mission',
    app: buildMissionControlRoutes({
      db: ctx.db, auth: ctx.auth,
      durableEntities: new DurableEntityService(ctx.db),
      experiments: new ExperimentService(ctx.db),
      connectionGrants: new ConnectionGrantService(ctx.db),
    }),
  }]);
}

function seed() {
  // A resident agent.
  ctx.db.insert(schema.agents).values({
    id: randomUUID(), workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Scout', adapterType: 'http',
    config: { residency: { enabled: true, intervalMinutes: 5 } },
  } as typeof schema.agents.$inferInsert).run();
  // A subject on the spine.
  new DurableEntityService(ctx.db).upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', state: { stage: 'contacted', facts: { name: 'Ana' } } });
  // An experiment with a scored subject.
  const exp = new ExperimentService(ctx.db);
  exp.define({ workspaceId: ctx.workspace.id, key: 'first_message', variants: ['A', 'B'] });
  const v = exp.assign({ workspaceId: ctx.workspace.id, key: 'first_message', subjectKey: 'lead-1' })!;
  exp.record({ workspaceId: ctx.workspace.id, key: 'first_message', subjectKey: 'lead-1', outcome: 'won' });
  return { variant: v };
}

describe('/v1/mission', () => {
  it('summary counts residents, subjects, experiments', async () => {
    seed();
    const res = await mkApp().request('/v1/mission/summary', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { residentAgents: number; subjects: number; experiments: number };
    expect(body.residentAgents).toBe(1);
    expect(body.subjects).toBe(1);
    expect(body.experiments).toBe(1);
  });

  it('subjects returns the pipeline grouped by stage', async () => {
    seed();
    const body = await (await mkApp().request('/v1/mission/subjects', { headers: ctx.authHeaders })).json() as { subjects: Array<{ key: string; stage: string; name: string }>; byStage: Record<string, number>; total: number };
    expect(body.total).toBe(1);
    expect(body.subjects[0]).toMatchObject({ key: 'lead-1', stage: 'contacted', name: 'Ana' });
    expect(body.byStage.contacted).toBe(1);
  });

  it('experiments returns per-variant results', async () => {
    seed();
    const body = await (await mkApp().request('/v1/mission/experiments', { headers: ctx.authHeaders })).json() as { experiments: Array<{ key: string; results: Array<{ variant: string; assigned: number; successRate: number }> }> };
    expect(body.experiments[0]?.key).toBe('first_message');
    expect(body.experiments[0]?.results.map((r) => r.variant).sort()).toEqual(['A', 'B']);
  });

  it('agents lists resident workers + their grant reach', async () => {
    seed();
    const body = await (await mkApp().request('/v1/mission/agents', { headers: ctx.authHeaders })).json() as { agents: Array<{ name: string; resident: boolean; intervalMinutes: number | null }>; residentCount: number };
    expect(body.residentCount).toBe(1);
    expect(body.agents.find((a) => a.name === 'Scout')).toMatchObject({ resident: true, intervalMinutes: 5 });
  });
});
