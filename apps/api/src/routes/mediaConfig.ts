/**
 * /v1/media/models — per-workspace media-generation model config
 * (INTEGRATION-CEILING-10X §1). Mirrors /v1/orchestrator/models exactly, for
 * the media-generation seam instead of chat cognition roles.
 *
 *   GET    /             → each modality with its env default + any workspace override
 *   PUT    /:modality    → set a workspace override { model, baseUrl?, apiKey? }
 *   DELETE /:modality    → clear the override (revert to env default)
 *
 * API keys are write-only: never returned, only `hasApiKey`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkspaceMediaConfigService } from '../services/workspace/workspaceMediaConfigService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const MEDIA_MODALITIES = ['image', 'audio', 'speech', 'video'] as const;
const modalitySchema = z.enum(MEDIA_MODALITIES);
const setSchema = z.object({
  model: z.string().min(1).max(200),
  baseUrl: z.string().url().max(2048).nullish(),
  /** Omit to keep the existing key; null/'' to clear; string to set. */
  apiKey: z.string().max(4096).nullish(),
});

export function buildMediaConfigRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  config: WorkspaceMediaConfigService;
  /** Instance-wide env default per modality, if any (only 'image' is wired today). */
  envDefaults: Partial<Record<(typeof MEDIA_MODALITIES)[number], { baseUrl: string; model: string; hasApiKey: boolean }>>;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const overrides = new Map(deps.config.list(ws.workspaceId).map((o) => [o.modality, o]));
    const modalities = MEDIA_MODALITIES.map((modality) => {
      const envDefault = deps.envDefaults[modality] ?? null;
      const override = overrides.get(modality) ?? null;
      // The model actually in effect for this workspace right now.
      const effectiveModel = override?.model ?? envDefault?.model ?? null;
      const effectiveHasApiKey = override ? override.hasApiKey || Boolean(envDefault?.hasApiKey) : Boolean(envDefault?.hasApiKey);
      return { modality, envDefault, override, effectiveModel, available: Boolean(effectiveModel && effectiveHasApiKey) };
    });
    return c.json({ modalities });
  });

  app.put('/:modality', async (c) => {
    const ws = getWorkspace(c);
    const modality = modalitySchema.parse(c.req.param('modality'));
    const body = setSchema.parse(await c.req.json());
    const saved = deps.config.set({
      workspaceId: ws.workspaceId,
      modality,
      model: body.model,
      baseUrl: body.baseUrl ?? null,
      ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
    });
    return c.json({ modality: saved });
  });

  app.delete('/:modality', (c) => {
    const ws = getWorkspace(c);
    const modality = modalitySchema.parse(c.req.param('modality'));
    deps.config.clear(ws.workspaceId, modality);
    return c.json({ ok: true });
  });

  // Surface a clear error for an unknown modality rather than a generic 500.
  app.onError((err, c) => {
    if (err instanceof AgentisError) throw err;
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'invalid media modality or body' } }, 422);
    }
    throw err;
  });

  return app;
}
