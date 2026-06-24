import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { SharedIntelligenceService } from '../services/sharedIntelligence.js';
import type { EmbeddingBackfillService } from '../services/embeddingBackfill.js';
import { embedText, selectEmbeddingProvider } from '../services/embeddingProvider.js';
import { EvaluatorRuntime } from '../services/evaluatorRuntime.js';
import { createLogger, type Logger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const providerSchema = z.enum(['local', 'openai']);
const providerConfigSchema = z.object({
  endpoint: z.string().url().optional(),
  model: z.string().trim().min(1).max(200).optional(),
  apiKey: z.string().trim().min(1).max(1000).optional(),
  dimension: z.number().int().positive().max(100_000).optional(),
}).passthrough();
const updateSchema = z.object({
  embeddingProviderType: providerSchema,
  embeddingProviderConfig: providerConfigSchema.default({}),
  auxiliaryAdapterConfig: z.record(z.unknown()).nullable().optional(),
  enrichmentConfig: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    apiKey: z.string().trim().min(1).max(1000).optional(),
    visualDescriptions: z.boolean().default(false),
    visionModel: z.string().trim().max(200).optional(),
    audioTranscription: z.boolean().default(false),
    transcriptionModel: z.string().trim().max(200).optional(),
  }).optional(),
  confirmMigration: z.boolean().optional(),
});
const verifySchema = z.object({
  embeddingProviderType: providerSchema,
  embeddingProviderConfig: providerConfigSchema.default({}),
});
const enrichmentVerifySchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(1000).optional(),
});

export function buildWorkspaceIntelligenceRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  intelligence: SharedIntelligenceService;
  backfill?: EmbeddingBackfillService;
  logger?: Logger;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json(readConfig(deps, ws.workspaceId));
  });

  app.post('/embedding/verify', async (c) => {
    const body = verifySchema.parse(await c.req.json());
    const startedAt = Date.now();
    try {
      const vector = await embedText(selectEmbeddingProvider(body.embeddingProviderType, body.embeddingProviderConfig), 'Agentis embedding connection test');
      return c.json({
        ok: true,
        degraded: false,
        providerType: body.embeddingProviderType,
        dimension: vector.length,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      return c.json({
        ok: false,
        degraded: true,
        providerType: body.embeddingProviderType,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'Embedding validation failed',
      });
    }
  });

  app.post('/enrichment/verify', async (c) => {
    const body = enrichmentVerifySchema.parse(await c.req.json());
    const startedAt = Date.now();
    const runtime = new EvaluatorRuntime({
      baseUrl: body.baseUrl,
      model: body.model,
      apiKey: body.apiKey,
      logger: deps.logger ?? fallbackLogger,
      timeoutMs: 15_000,
    });
    const result = await runtime.completeStructured<Record<string, unknown>>({
      system: 'Return one JSON object only.',
      user: 'Return {"ok":true} to verify Brain enrichment configuration.',
      maxTokens: 30,
      maxAttempts: 1,
    });
    return c.json({ ok: Boolean(result), latencyMs: Date.now() - startedAt, error: result ? undefined : 'Model did not return JSON.' });
  });

  app.patch('/', async (c) => {
    const ws = getWorkspace(c);
    const body = updateSchema.parse(await c.req.json());
    const current = configRow(deps.db, ws.workspaceId);
    const activeAtomCount = countAtoms(deps.db, ws.workspaceId);
    const changedProvider = current.embeddingProviderType !== body.embeddingProviderType;
    if (changedProvider && activeAtomCount > 0 && !body.confirmMigration) {
      return c.json({
        requiresConfirmation: true,
        activeAtomCount,
        estimateSeconds: Math.max(15, Math.ceil(activeAtomCount / 3)),
        message: 'Changing embedding provider requires re-embedding existing atoms.',
      });
    }

    const currentProviderConfig = asRecord(current.embeddingProviderConfig);
    const providerConfig = {
      ...body.embeddingProviderConfig,
      ...(body.embeddingProviderType === 'openai' && !body.embeddingProviderConfig.apiKey && currentProviderConfig.apiKey
        ? { apiKey: currentProviderConfig.apiKey }
        : {}),
    };
    const settings = asRecord(current.brainSettings);
    const priorEnrichment = asRecord(settings.enrichmentConfig);
    const requestedEnrichment = body.enrichmentConfig;
    const enrichmentConfig = requestedEnrichment ? {
      ...requestedEnrichment,
      ...(requestedEnrichment.enabled && !requestedEnrichment.apiKey && priorEnrichment.apiKey
        ? { apiKey: priorEnrichment.apiKey }
        : {}),
    } : priorEnrichment;
    deps.db.update(schema.workspaces)
      .set({
        embeddingProviderType: body.embeddingProviderType,
        embeddingProviderConfig: providerConfig,
        brainSettings: {
          ...settings,
          auxiliaryAdapterConfig: body.auxiliaryAdapterConfig ?? settings.auxiliaryAdapterConfig ?? null,
          enrichmentConfig,
        },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workspaces.id, ws.workspaceId))
      .run();
    deps.intelligence.invalidateEmbeddingProvider(ws.workspaceId);

    const migrationQueued = changedProvider && activeAtomCount > 0;
    if (migrationQueued) {
      void Promise.all([
        deps.intelligence.reembedWorkspaceAtoms(ws.workspaceId),
        deps.backfill?.run(ws.workspaceId) ?? Promise.resolve({ embedded: 0, failed: 0 }),
      ]).catch(() => {});
    }
    return c.json({ ...readConfig(deps, ws.workspaceId), migrationQueued });
  });

  return app;
}

function readConfig(deps: { db: AgentisSqliteDb; intelligence: SharedIntelligenceService }, workspaceId: string) {
  const row = configRow(deps.db, workspaceId);
  const providerConfig = asRecord(row.embeddingProviderConfig);
  const settings = asRecord(row.brainSettings);
  const status = deps.intelligence.embeddingStatus(workspaceId);
  const { apiKey: _apiKey, ...publicProviderConfig } = providerConfig;
  const enrichment = asRecord(settings.enrichmentConfig);
  const { apiKey: _enrichmentApiKey, ...publicEnrichment } = enrichment;
  return {
    embeddingProviderType: row.embeddingProviderType,
    embeddingProviderConfig: { ...publicProviderConfig, apiKeySet: Boolean(_apiKey) },
    auxiliaryAdapterConfig: settings.auxiliaryAdapterConfig ?? null,
    auxiliaryUsedBy: ['Context summaries', 'Exploratory expansion', 'Relation classification'],
    enrichmentConfig: { ...publicEnrichment, apiKeySet: Boolean(_enrichmentApiKey) },
    activeAtomCount: countAtoms(deps.db, workspaceId),
    degraded: status.degraded,
    migration: status.migration,
  };
}

const fallbackLogger = createLogger({ level: 'error' });

function configRow(db: AgentisSqliteDb, workspaceId: string) {
  return db.select({
    embeddingProviderType: schema.workspaces.embeddingProviderType,
    embeddingProviderConfig: schema.workspaces.embeddingProviderConfig,
    brainSettings: schema.workspaces.brainSettings,
  }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()!;
}

function countAtoms(db: AgentisSqliteDb, workspaceId: string): number {
  const episodes = db.select({ count: sql<number>`count(*)` })
    .from(schema.memoryEpisodes)
    .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), isNull(schema.memoryEpisodes.archivedAt)))
    .get();
  const chunks = db.select({ count: sql<number>`count(*)` })
    .from(schema.kbChunks)
    .where(eq(schema.kbChunks.workspaceId, workspaceId))
    .get();
  return Number(episodes?.count ?? 0) + Number(chunks?.count ?? 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
