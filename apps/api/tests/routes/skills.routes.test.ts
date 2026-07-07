import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { buildSkillRoutes } from '../../src/routes/skills.js';
import { SkillService } from '../../src/services/skillService.js';
import { MemoryStore } from '../../src/services/memoryStore.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let skills: SkillService;

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  const brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  const memory = new MemoryStore(ctx.db, ctx.logger);
  memory.setEpisodicStore(episodes);
  skills = new SkillService(ctx.db, memory, brain, ctx.logger);
});

afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/skills', app: buildSkillRoutes({ db: ctx.db, auth: ctx.auth, skills }) }]);
}

describe('/v1/skills', () => {
  it('creates, lists, reads, updates, and deletes a skill', async () => {
    const created = await app().request('/v1/skills', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'Deploy Migrations Safely', description: 'Gate migrations behind a flag.', body: '# Steps\n1. Flag it.' }),
    });
    expect(created.status).toBe(201);
    const { skill } = (await created.json()) as { skill: { id: string; slug: string; body: string } };
    expect(skill.slug).toBe('deploy-migrations-safely');

    const list = await app().request('/v1/skills', { headers: ctx.authHeaders });
    const listBody = (await list.json()) as { skills: Array<{ id: string; name: string }> };
    expect(listBody.skills.some((s) => s.id === skill.id)).toBe(true);

    const detail = await app().request(`/v1/skills/${skill.id}`, { headers: ctx.authHeaders });
    const detailBody = (await detail.json()) as { skill: { body: string }; examples: unknown[]; lessons: unknown[] };
    expect(detailBody.skill.body).toContain('Flag it');

    const patched = await app().request(`/v1/skills/${skill.id}`, {
      method: 'PATCH', headers: ctx.authHeaders, body: JSON.stringify({ body: '# Steps\n1. Flag it.\n2. Verify.' }),
    });
    expect(patched.status).toBe(200);
    expect(skills.getSkill(ctx.workspace.id, skill.id)?.body).toContain('Verify');

    const del = await app().request(`/v1/skills/${skill.id}`, { method: 'DELETE', headers: ctx.authHeaders });
    expect(del.status).toBe(200);
    expect(skills.getSkill(ctx.workspace.id, skill.id)).toBeNull();
  });

  it('lists example atoms via /examples', async () => {
    const s = skills.upsertSkill({ workspaceId: ctx.workspace.id, scopeId: null, name: 'Teachable', description: '', body: 'x' });
    skills.promoteExample({ workspaceId: ctx.workspace.id, skillId: s.id, inputText: 'add a column', outputText: 'flag, migrate, verify' });

    const res = await app().request('/v1/skills/examples', { headers: ctx.authHeaders });
    const body = (await res.json()) as { examples: Array<{ content: string }> };
    expect(body.examples).toHaveLength(1);
    expect(body.examples[0]!.content).toContain('flag, migrate, verify');
  });

  it('404s an unknown skill', async () => {
    const res = await app().request('/v1/skills/nope', { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
  });
});
