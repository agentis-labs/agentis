import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/services/memoryStore.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { buildMemoryRoutes } from '../../src/routes/memory.js';
import { buildWorkspaceIntelligenceRoutes } from '../../src/routes/workspaceIntelligence.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let memory: MemoryStore;
let episodes: EpisodicMemoryStore;
let intelligence: SharedIntelligenceService;

beforeEach(async () => {
  ctx = await createTestContext();
  memory = new MemoryStore(ctx.db, ctx.logger);
  episodes = new EpisodicMemoryStore(ctx.db, ctx.logger);
  intelligence = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
});

afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([
    { path: '/v1/memory', app: buildMemoryRoutes({ db: ctx.db, auth: ctx.auth, memory, episodes }) },
    { path: '/v1/workspace/intelligence', app: buildWorkspaceIntelligenceRoutes({ db: ctx.db, auth: ctx.auth, intelligence }) },
  ]);
}

describe('Brain redesigned surface support routes', () => {
  it('writes and lists shared memory, and lists episodes', async () => {
    const create = await app().request('/v1/memory', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ kind: 'fact', title: 'Launch day', content: 'Ship on Monday.', confidence: 1, importance: 7 }),
    });
    expect(create.status).toBe(201);

    const listing = await app().request('/v1/memory?limit=100', { headers: ctx.authHeaders });
    const memoryBody = await listing.json() as { memory: Array<{ title: string }> };
    expect(memoryBody.memory.map((entry) => entry.title)).toContain('Launch day');

    const episodeListing = await app().request('/v1/memory/episodes?limit=80', { headers: ctx.authHeaders });
    expect(episodeListing.status).toBe(200);
    expect(await episodeListing.json()).toEqual({ episodes: [] });
  });

  it('reports embedding state and verifies the built-in provider', async () => {
    const status = await app().request('/v1/workspace/intelligence', { headers: ctx.authHeaders });
    const statusBody = await status.json() as { embeddingProviderType: string; degraded: boolean };
    expect(statusBody.embeddingProviderType).toBe('local');
    expect(statusBody.degraded).toBe(false);

    const verify = await app().request('/v1/workspace/intelligence/embedding/verify', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ embeddingProviderType: 'local', embeddingProviderConfig: {} }),
    });
    const verifyBody = await verify.json() as { ok: boolean; dimension: number };
    expect(verifyBody.ok).toBe(true);
    expect(verifyBody.dimension).toBeGreaterThan(0);
  });

  it('stores model-driven Brain configuration without returning its API key', async () => {
    const save = await app().request('/v1/workspace/intelligence', {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        embeddingProviderType: 'local',
        embeddingProviderConfig: {},
        enrichmentConfig: {
          enabled: true,
          baseUrl: 'https://models.example.test/v1',
          model: 'reasoning-small',
          apiKey: 'never-return-this-secret',
          visualDescriptions: true,
          visionModel: 'vision-mini',
          audioTranscription: true,
          transcriptionModel: 'transcribe-mini',
        },
      }),
    });

    expect(save.status).toBe(200);
    const body = await save.json() as {
      enrichmentConfig: Record<string, unknown>;
    };
    expect(body.enrichmentConfig).toMatchObject({
      enabled: true,
      model: 'reasoning-small',
      visualDescriptions: true,
      audioTranscription: true,
      apiKeySet: true,
    });
    expect(body.enrichmentConfig.apiKey).toBeUndefined();
  });
});
