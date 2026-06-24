/**
 * /v1/specialists — route unit tests.
 *
 * Verifies the registry surface lists custom/generated specialists with
 * materialization status, and that POST authors a specialist that the engine
 * can route to immediately (custom agentRole becomes legal at dispatch).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { randomUUID } from 'node:crypto';
import { buildSpecialistRoutes, type SpecialistSummary } from '../../src/routes/specialists.js';
import { SpecialistAgentService } from '../../src/services/specialistAgents.js';
import { AgentLibraryService } from '../../src/services/agentLibrary.js';
import { SpecialistLoadoutService } from '../../src/services/specialistLoadoutService.js';
import { SpecialistProfileService } from '../../src/services/specialistProfileService.js';
import { SpecialistMindService } from '../../src/services/specialistMindService.js';
import { SpecialistRuntimeService } from '../../src/services/specialistRuntimeService.js';
import { SpecialistEvalService } from '../../src/services/specialistEvalService.js';
import { SpecialistDemandRouter } from '../../src/services/specialistDemandRouter.js';
import { SpecialistTemplateService } from '../../src/services/specialistTemplateService.js';
import { AbilityService } from '../../src/services/abilityService.js';
import { WorkspaceVolumeService } from '../../src/services/workspaceVolume.js';
import { createLogger } from '../../src/logger.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let specialists: SpecialistAgentService;
let agentLibrary: AgentLibraryService;
let loadouts: SpecialistLoadoutService;
let abilities: AbilityService;
let profiles: SpecialistProfileService;
let mind: SpecialistMindService;
let runtime: SpecialistRuntimeService;
let evals: SpecialistEvalService;
let router: SpecialistDemandRouter;
let templates: SpecialistTemplateService;
let dataDir: string;

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-spec-route-'));
  agentLibrary = new AgentLibraryService(new WorkspaceVolumeService(dataDir));
  specialists = new SpecialistAgentService(ctx.db, agentLibrary);
  loadouts = new SpecialistLoadoutService(ctx.db);
  const logger = createLogger({ level: 'error' });
  abilities = new AbilityService(ctx.db, logger);
  profiles = new SpecialistProfileService(ctx.db);
  mind = new SpecialistMindService({ db: ctx.db, logger, embeddings: () => new StubEmbeddingProvider() });
  runtime = new SpecialistRuntimeService(ctx.db);
  evals = new SpecialistEvalService(ctx.db, mind);
  templates = new SpecialistTemplateService(ctx.db);
  templates.seedPlatformTemplates();
  router = new SpecialistDemandRouter({ db: ctx.db, logger, specialists, profiles, loadouts, abilities, mind, runtime });
});

afterEach(async () => {
  ctx.close();
  // maxRetries: the agent library writes platform/*.md lazily; on Windows a
  // recursive rmdir can race those writes (ENOTEMPTY) — retry briefly.
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function app() {
  return ctx.buildApp([
    { path: '/v1/specialists', app: buildSpecialistRoutes({ db: ctx.db, auth: ctx.auth, specialists, agentLibrary, loadouts, abilities, profiles, mind, router, runtime, evals, templates }) },
  ]);
}

function seedAbility(name: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.abilities).values({ id, workspaceId: ctx.workspace.id, name, slug: name.toLowerCase().replace(/\s+/g, '_'), compileStatus: 'ready' }).run();
  return id;
}

describe('GET /v1/specialists', () => {
  it('does not list platform specialists in an empty workspace', async () => {
    const res = await app().request('/v1/specialists', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { specialists: SpecialistSummary[]; count: number };
    expect(body.count).toBe(0);
    expect(body.specialists).toEqual([]);
  });

  it('reflects materialization status for a seeded specialist', async () => {
    const id = specialists.ensureRole(ctx.workspace.id, ctx.user.id, 'reviewer');
    ctx.db.update(schema.agents).set({ status: 'online' }).where(eq(schema.agents.id, id)).run();
    const res = await app().request('/v1/specialists', { headers: ctx.authHeaders });
    const body = (await res.json()) as { specialists: SpecialistSummary[] };
    const reviewer = body.specialists.find((s) => s.role === 'reviewer');
    expect(reviewer?.status).toBe('live');
    expect(reviewer?.agentId).toBe(id);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/specialists');
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/specialists', () => {
  it('authors a custom specialist and materializes it', async () => {
    const res = await app().request('/v1/specialists', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'SEO Writer',
        description: 'Writes search-optimized long-form content.',
        instructions: 'You are the SEO Writer. Optimize for intent and clarity.',
        capabilityTags: ['seo', 'writing'],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { specialist: SpecialistSummary; created: boolean };
    expect(body.created).toBe(true);
    expect(body.specialist.role).toBe('seo_writer');
    expect(body.specialist.source).toBe('custom');
    expect(body.specialist.agentId).not.toBeNull();

    // Engine-facing resolution now returns the authored persona.
    const def = specialists.defForRole(ctx.workspace.id, 'seo_writer');
    expect(def.systemPrompt).toMatch(/Optimize for intent/);
  });

  it('rejects a body with neither role nor name (422)', async () => {
    const res = await app().request('/v1/specialists', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ description: 'no identity' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('Ability loadouts', () => {
  it('PUT sets a loadout entry and GET returns it joined with the ability', async () => {
    const abilityId = seedAbility('Design Taste');
    const put = await app().request(`/v1/specialists/frontend_architect/abilities/${abilityId}`, {
      method: 'PUT',
      headers: ctx.authHeaders,
      body: JSON.stringify({ mode: 'required', priority: 5 }),
    });
    expect(put.status).toBe(200);

    const get = await app().request('/v1/specialists/frontend_architect/abilities', { headers: ctx.authHeaders });
    const body = (await get.json()) as { loadout: Array<{ abilityId: string; mode: string; ability: { name: string } | null }>; abilities: unknown[] };
    expect(body.loadout).toHaveLength(1);
    expect(body.loadout[0]!.mode).toBe('required');
    expect(body.loadout[0]!.ability?.name).toBe('Design Taste');
    expect(body.abilities.length).toBeGreaterThan(0);
  });

  it('PUT for an unknown ability is 404; DELETE removes the entry', async () => {
    const missing = await app().request('/v1/specialists/frontend_architect/abilities/nope', {
      method: 'PUT', headers: ctx.authHeaders, body: JSON.stringify({ mode: 'required' }),
    });
    expect(missing.status).toBe(404);

    const abilityId = seedAbility('Legacy jQuery');
    await app().request(`/v1/specialists/frontend_architect/abilities/${abilityId}`, {
      method: 'PUT', headers: ctx.authHeaders, body: JSON.stringify({ mode: 'forbidden' }),
    });
    const del = await app().request(`/v1/specialists/frontend_architect/abilities/${abilityId}`, { method: 'DELETE', headers: ctx.authHeaders });
    expect(del.status).toBe(200);
    const get = await app().request('/v1/specialists/frontend_architect/abilities', { headers: ctx.authHeaders });
    const body = (await get.json()) as { loadout: unknown[] };
    expect(body.loadout).toHaveLength(0);
  });
});

describe('Specialist profile + card (Phase 1)', () => {
  it('GET /:role returns a lazily-created profile; GET /:role/card synthesizes a card', async () => {
    const ability = seedAbility('Design Taste');
    await app().request(`/v1/specialists/coder/abilities/${ability}`, {
      method: 'PUT', headers: ctx.authHeaders, body: JSON.stringify({ mode: 'required' }),
    });

    const prof = await app().request('/v1/specialists/coder', { headers: ctx.authHeaders });
    expect(prof.status).toBe(200);
    const profBody = (await prof.json()) as { profile: { role: string; status: string } };
    expect(profBody.profile.role).toBe('coder');
    expect(profBody.profile.status).toBe('draft');

    const card = await app().request('/v1/specialists/coder/card', { headers: ctx.authHeaders });
    const cardBody = (await card.json()) as { card: { role: string; abilities: Array<{ name: string; mode: string }>; tools: string[] } };
    expect(cardBody.card.role).toBe('coder');
    expect(cardBody.card.abilities).toEqual([{ name: 'Design Taste', mode: 'required' }]);
    expect(cardBody.card.tools.length).toBeGreaterThan(0);
  });

  it('PATCH /:role updates identity + status and bumps version on ready', async () => {
    const res = await app().request('/v1/specialists/coder', {
      method: 'PATCH', headers: ctx.authHeaders,
      body: JSON.stringify({ title: 'Senior Engineer', status: 'ready' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profile: { title: string; status: string; version: number } };
    expect(body.profile.title).toBe('Senior Engineer');
    expect(body.profile.status).toBe('ready');
    expect(body.profile.version).toBe(2);
  });
});

describe('Specialist mind, router, runtime, and evals', () => {
  it('ingests mind sources, compiles, routes with an explainable trace, and promotes eval output', async () => {
    const source = await app().request('/v1/specialists/frontend_architect/mind/sources', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        kind: 'text',
        title: 'Design rules',
        content: 'Use dense operational layouts, avoid generic purple gradients, prefer clear component hierarchy.',
      }),
    });
    expect(source.status).toBe(201);

    const compile = await app().request('/v1/specialists/frontend_architect/compile', {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(compile.status).toBe(200);
    const compiled = (await compile.json()) as { profile: { status: string }; mind: { atomCount: number }; evals: { cases: number } };
    expect(compiled.profile.status).toBe('ready');
    expect(compiled.mind.atomCount).toBeGreaterThan(0);
    expect(compiled.evals.cases).toBeGreaterThanOrEqual(3);

    const request = await app().request('/v1/specialists/request', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ task: 'Review a React dashboard UI for visual hierarchy and code quality.', modality: 'text' }),
    });
    expect(request.status).toBe(200);
    const routed = (await request.json()) as { route: { selectedRole: string; selectedAgentId: string | null; explanation: string; specialistRun: { id: string } | null } };
    expect(routed.route.selectedAgentId).toBeTruthy();
    expect(routed.route.explanation).toMatch(/Selected/);
    expect(routed.route.specialistRun?.id).toBeTruthy();

    const evalsRes = await app().request('/v1/specialists/frontend_architect/evals', { headers: ctx.authHeaders });
    const evalsBody = (await evalsRes.json()) as { cases: Array<{ id: string }> };
    const run = await app().request(`/v1/specialists/frontend_architect/evals/${evalsBody.cases[0]!.id}/run`, {
      method: 'POST',
      headers: ctx.authHeaders,
      // Cover the expected terms of ALL three starter eval cases (Bounded task,
      // Boundary recognition, Artifact discipline) so the score is high regardless
      // of which case sorts first — the starters share a createdAt and have random
      // ids, so cases[0] ordering is not stable. (Was missing "outside domain",
      // which dropped the score to exactly 0.5 whenever cases[0] was Boundary recognition.)
      body: JSON.stringify({ output: 'Assumptions approach output risks outside domain delegate escalate artifact summary coordinator' }),
    });
    expect(run.status).toBe(201);
    const runBody = (await run.json()) as { run: { id: string; score: number } };
    expect(runBody.run.score).toBeGreaterThan(0.5);

    const promote = await app().request(`/v1/specialists/frontend_architect/evals/runs/${runBody.run.id}/promote`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(promote.status).toBe(200);
    const mindRes = await app().request('/v1/specialists/frontend_architect/mind', { headers: ctx.authHeaders });
    const mindBody = (await mindRes.json()) as { mind: { atoms: Array<{ atomType: string }> } };
    expect(mindBody.mind.atoms.some((atom) => atom.atomType === 'example')).toBe(true);
  });
});
