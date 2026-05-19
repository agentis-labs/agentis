import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildWorkspaceIntelligenceRoutes } from '../../src/routes/workspaceIntelligence.js';
import { AgentAbilityService } from '../../src/services/agentAbilityService.js';
import { BrainPromotionQueueWorker } from '../../src/services/brainPromotionQueueWorker.js';
import { CollectiveBrainService } from '../../src/services/collectiveBrain.js';
import { DreamingService } from '../../src/services/dreamingService.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { HashingEmbeddingProvider } from '../../src/services/embeddingProvider.js';
import { PeerRepresentationService } from '../../src/services/peerRepresentationService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: CollectiveBrainService;
let queue: BrainPromotionQueueWorker;
let app: ReturnType<TestContext['buildApp']>;

beforeEach(async () => {
  ctx = await createTestContext();
  brain = new CollectiveBrainService(
    ctx.db,
    ctx.bus,
    new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()),
    ctx.logger,
  );
  queue = new BrainPromotionQueueWorker(ctx.db, brain, ctx.logger);
  const abilities = new AgentAbilityService(ctx.db, ctx.bus, ctx.logger);
  const peers = new PeerRepresentationService(ctx.db, ctx.bus, ctx.logger);
  const dreaming = new DreamingService(ctx.db, ctx.bus, ctx.logger, peers, brain);
  app = ctx.buildApp([{
    path: '/v1/workspace',
    app: buildWorkspaceIntelligenceRoutes({
      db: ctx.db,
      auth: ctx.auth,
      bus: ctx.bus,
      collectiveBrain: brain,
      brainQueue: queue,
      abilities,
      peerRepresentations: peers,
      dreaming,
    }),
  }]);
});

afterEach(() => {
  ctx.close();
});

describe('/v1/workspace/intelligence', () => {
  it('reports degraded hashing defaults and verifies the hashing provider', async () => {
    const get = await app.request('/v1/workspace/intelligence', { headers: ctx.authHeaders });
    expect(get.status).toBe(200);
    const config = await get.json() as {
      embeddingProviderType: string;
      degraded: boolean;
      usedBy: string[];
      auxiliaryUsedBy: string[];
    };
    expect(config.embeddingProviderType).toBe('hashing');
    expect(config.degraded).toBe(true);
    expect(config.usedBy).toContain('Brain retrieval');
    expect(config.auxiliaryUsedBy).toContain('Dreaming (Phase 4)');

    const verify = await app.request('/v1/workspace/intelligence/embedding/verify', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ embeddingProviderType: 'hashing', embeddingProviderConfig: {} }),
    });
    expect(verify.status).toBe(200);
    const result = await verify.json() as { ok: boolean; degraded: boolean; dimension: number };
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.dimension).toBeGreaterThan(0);
  });

  it('requires confirmation before switching providers when active atoms need re-embedding', async () => {
    await brain.addAtom({
      workspaceId: ctx.workspace.id,
      title: 'Dispatch context fact',
      content: 'Agents should include the degraded brain signal when embeddings are hashing.',
      confidence: 0.8,
      source: 'operator_write',
    });
    const capture = ctx.captureBus();
    try {
      const first = await app.request('/v1/workspace/intelligence', {
        method: 'PATCH',
        headers: ctx.authHeaders,
        body: JSON.stringify({
          embeddingProviderType: 'ollama',
          embeddingProviderConfig: { endpoint: 'http://localhost:11434', model: 'nomic-embed-text' },
        }),
      });
      expect(first.status).toBe(200);
      const needsConfirmation = await first.json() as { requiresConfirmation: boolean; activeAtomCount: number };
      expect(needsConfirmation.requiresConfirmation).toBe(true);
      expect(needsConfirmation.activeAtomCount).toBe(1);
      expect(ctx.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspace.id)).get()?.embeddingProviderType).toBe('hashing');

      const confirmed = await app.request('/v1/workspace/intelligence', {
        method: 'PATCH',
        headers: ctx.authHeaders,
        body: JSON.stringify({
          embeddingProviderType: 'ollama',
          embeddingProviderConfig: { endpoint: 'http://localhost:11434', model: 'nomic-embed-text' },
          confirmMigration: true,
        }),
      });
      expect(confirmed.status).toBe(200);
      const saved = await confirmed.json() as { embeddingProviderType: string; migrationQueued: boolean; migrationRequestId: string };
      expect(saved.embeddingProviderType).toBe('ollama');
      expect(saved.migrationQueued).toBe(true);
      expect(saved.migrationRequestId).toBeTruthy();

      const queued = ctx.db.select().from(schema.brainPromotionQueue)
        .where(eq(schema.brainPromotionQueue.itemType, 'reembed_workspace'))
        .all();
      expect(queued).toHaveLength(1);
      expect(capture.events.some((event) => event.envelope.event === REALTIME_EVENTS.BRAIN_EMBEDDING_MIGRATION_STARTED)).toBe(true);
    } finally {
      capture.stop();
    }
  });

  it('preserves a stored API key when patching non-secret provider fields', async () => {
    ctx.db.update(schema.workspaces)
      .set({
        embeddingProviderType: 'openai',
        embeddingProviderConfig: {
          endpoint: 'https://api.openai.com/v1',
          model: 'text-embedding-3-small',
          apiKey: 'sk-existing',
        },
      })
      .where(eq(schema.workspaces.id, ctx.workspace.id))
      .run();

    const res = await app.request('/v1/workspace/intelligence', {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        embeddingProviderType: 'openai',
        embeddingProviderConfig: {
          endpoint: 'https://api.openai.com/v1',
          model: 'text-embedding-3-large',
        },
      }),
    });
    expect(res.status).toBe(200);
    const row = ctx.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspace.id)).get();
    expect((row?.embeddingProviderConfig as { apiKey?: string; model?: string })?.apiKey).toBe('sk-existing');
    expect((row?.embeddingProviderConfig as { apiKey?: string; model?: string })?.model).toBe('text-embedding-3-large');
  });
});
