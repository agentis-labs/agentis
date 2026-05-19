import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, isNull, and } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import type { CollectiveBrainService } from '../services/collectiveBrain.js';
import type { BrainPromotionQueueWorker } from '../services/brainPromotionQueueWorker.js';
import type { AgentAbilityService } from '../services/agentAbilityService.js';
import type { PeerRepresentationService } from '../services/peerRepresentationService.js';
import type { DreamingService } from '../services/dreamingService.js';
import { selectEmbeddingProvider, type EmbeddingProviderConfig, type ValidatableEmbeddingProvider } from '../services/embeddingProvider.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export interface WorkspaceIntelligenceRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus: EventBus;
  collectiveBrain: CollectiveBrainService;
  brainQueue: BrainPromotionQueueWorker;
  abilities?: AgentAbilityService;
  peerRepresentations?: PeerRepresentationService;
  dreaming?: DreamingService;
}

export function buildWorkspaceIntelligenceRoutes(deps: WorkspaceIntelligenceRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/intelligence', (c) => {
    const ws = getWorkspace(c);
    return c.json(readConfig(deps, ws.workspaceId));
  });

  app.patch('/intelligence', async (c) => {
    const ws = getWorkspace(c);
    const body = patchSchema.parse(await c.req.json().catch(() => ({})));
    const current = deps.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.workspaceId)).get();
    if (!current) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');

    const nextType = body.embeddingProviderType ?? current.embeddingProviderType;
    const currentConfig = configRecord(current.embeddingProviderConfig);
    const nextConfig = body.embeddingProviderConfig
      ? preserveStoredSecret(sanitizeProviderConfig(body.embeddingProviderConfig), currentConfig)
      : currentConfig;
    const providerChanged =
      nextType !== current.embeddingProviderType
      || JSON.stringify(withoutSecrets(nextConfig)) !== JSON.stringify(withoutSecrets(currentConfig));
    const activeAtomCount = countActiveAtoms(deps.db, ws.workspaceId);
    if (providerChanged && activeAtomCount > 0 && !body.confirmMigration) {
      return c.json({
        requiresConfirmation: true,
        activeAtomCount,
        estimateSeconds: estimateMigrationSeconds(activeAtomCount),
        message: `Changing embedding provider requires re-embedding ${activeAtomCount} atoms.`,
      });
    }

    const brainSettings = configRecord(current.brainSettings);
    const migrationRequestId = providerChanged && activeAtomCount > 0 ? randomUUID() : null;
    const nextBrainSettings = migrationRequestId
      ? {
          ...brainSettings,
          embeddingMigration: {
            status: 'queued',
            requestId: migrationRequestId,
            activeAtomCount,
            queuedAt: new Date().toISOString(),
            from: current.embeddingProviderType,
            to: nextType,
          },
        }
      : brainSettings;

    deps.db.update(schema.workspaces)
      .set({
        embeddingProviderType: nextType,
        embeddingProviderConfig: nextConfig,
        auxiliaryAdapterConfig: body.auxiliaryAdapterConfig !== undefined
          ? body.auxiliaryAdapterConfig
          : current.auxiliaryAdapterConfig,
        brainSettings: nextBrainSettings,
      })
      .where(eq(schema.workspaces.id, ws.workspaceId))
      .run();

    deps.collectiveBrain.invalidateEmbeddingProvider(ws.workspaceId);
    deps.abilities?.invalidateEmbeddingProvider(ws.workspaceId);
    deps.peerRepresentations?.invalidateEmbeddingProvider(ws.workspaceId);
    deps.dreaming?.invalidateEmbeddingProvider(ws.workspaceId);

    if (migrationRequestId) {
      deps.brainQueue.enqueue({
        workspaceId: ws.workspaceId,
        itemType: 'reembed_workspace',
        priority: 'normal',
        payload: { workspaceId: ws.workspaceId, requestId: migrationRequestId },
      });
      deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.BRAIN_EMBEDDING_MIGRATION_STARTED, {
        workspaceId: ws.workspaceId,
        requestId: migrationRequestId,
        activeAtomCount,
        providerType: nextType,
      });
    }

    return c.json({
      ...readConfig(deps, ws.workspaceId),
      migrationQueued: Boolean(migrationRequestId),
      migrationRequestId,
    });
  });

  app.post('/intelligence/embedding/verify', async (c) => {
    const body = verifySchema.parse(await c.req.json().catch(() => ({})));
    const started = Date.now();
    const type = body.embeddingProviderType;
    const provider = selectEmbeddingProvider(type, sanitizeProviderConfig(body.embeddingProviderConfig ?? {}));
    try {
      if ('validate' in provider && typeof (provider as ValidatableEmbeddingProvider).validate === 'function') {
        await (provider as ValidatableEmbeddingProvider).validate();
      } else {
        await provider.embed('connection test');
      }
      return c.json({
        ok: true,
        degraded: type === 'hashing',
        providerType: type,
        dimension: provider.dimension,
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      return c.json({
        ok: false,
        degraded: true,
        providerType: type,
        error: (err as Error).message,
        latencyMs: Date.now() - started,
      }, 400);
    }
  });

  return app;
}

const providerConfigSchema = z.object({
  endpoint: z.string().max(500).optional(),
  model: z.string().max(120).optional(),
  apiKey: z.string().max(500).optional(),
  dimension: z.number().int().min(1).max(10000).optional(),
}).passthrough();

const patchSchema = z.object({
  embeddingProviderType: z.enum(['hashing', 'ollama', 'openai']).optional(),
  embeddingProviderConfig: providerConfigSchema.optional(),
  auxiliaryAdapterConfig: z.record(z.unknown()).nullable().optional(),
  confirmMigration: z.boolean().optional(),
});

const verifySchema = z.object({
  embeddingProviderType: z.enum(['hashing', 'ollama', 'openai']),
  embeddingProviderConfig: providerConfigSchema.optional(),
});

function readConfig(deps: WorkspaceIntelligenceRoutesDeps, workspaceId: string) {
  const row = deps.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
  if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
  const embeddingProviderConfig = configRecord(row.embeddingProviderConfig);
  const brainSettings = configRecord(row.brainSettings);
  const activeAtomCount = countActiveAtoms(deps.db, workspaceId);
  return {
    embeddingProviderType: row.embeddingProviderType,
    embeddingProviderConfig: redactProviderConfig(embeddingProviderConfig),
    auxiliaryAdapterConfig: row.auxiliaryAdapterConfig ?? null,
    activeAtomCount,
    degraded: row.embeddingProviderType === 'hashing',
    migration: brainSettings.embeddingMigration ?? null,
    usedBy: ['Brain retrieval', 'Peer representation dreaming', 'Agent ability ranking'],
    auxiliaryUsedBy: ['Dreaming (Phase 4)', 'Auto-dispute resolution'],
  };
}

function countActiveAtoms(db: AgentisSqliteDb, workspaceId: string): number {
  return db.select().from(schema.memoryEpisodes)
    .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), isNull(schema.memoryEpisodes.archivedAt)))
    .all()
    .filter((row) => row.status !== 'archived').length;
}

function sanitizeProviderConfig(raw: Record<string, unknown>): EmbeddingProviderConfig & Record<string, unknown> {
  return {
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint.trim() : undefined,
    model: typeof raw.model === 'string' ? raw.model.trim() : undefined,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : undefined,
    dimension: typeof raw.dimension === 'number' ? raw.dimension : undefined,
  };
}

function preserveStoredSecret(next: EmbeddingProviderConfig & Record<string, unknown>, current: Record<string, unknown>) {
  if (!next.apiKey && typeof current.apiKey === 'string' && current.apiKey.trim()) {
    return { ...next, apiKey: current.apiKey };
  }
  return next;
}

function redactProviderConfig(config: Record<string, unknown>) {
  return {
    ...withoutSecrets(config),
    apiKeySet: typeof config.apiKey === 'string' && config.apiKey.length > 0,
  };
}

function withoutSecrets(config: Record<string, unknown> | EmbeddingProviderConfig) {
  const { apiKey: _apiKey, ...rest } = config as Record<string, unknown>;
  return rest;
}

function configRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function estimateMigrationSeconds(atomCount: number): number {
  return Math.max(20, Math.ceil(atomCount / 3));
}
