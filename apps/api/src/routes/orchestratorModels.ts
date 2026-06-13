/**
 * /v1/orchestrator/models — per-workspace orchestrator model-role config
 * (OMNICHANNEL-ORCHESTRATOR-10X §4.4).
 *
 *   GET    /            → each role with its env default + any workspace override
 *   PUT    /:role       → set a workspace override { model, baseUrl?, apiKey? }
 *   DELETE /:role       → clear the override (revert to env default)
 *
 * API keys are write-only: never returned, only `hasApiKey`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkspaceModelConfigService } from '../services/workspaceModelConfigService.js';
import type { OrchestratorModelRouter } from '../services/orchestratorModelRouter.js';
import { ORCHESTRATOR_MODEL_ROLES, type OrchestratorModelRole } from '../services/orchestratorModelRouter.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const roleSchema = z.enum(ORCHESTRATOR_MODEL_ROLES as unknown as [string, ...string[]]);
const setSchema = z.object({
  model: z.string().min(1).max(200),
  baseUrl: z.string().url().max(2048).nullish(),
  /** Omit to keep the existing key; null/'' to clear; string to set. */
  apiKey: z.string().max(4096).nullish(),
});

export function buildOrchestratorModelRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  config: WorkspaceModelConfigService;
  router: OrchestratorModelRouter;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const overrides = new Map(deps.config.list(ws.workspaceId).map((o) => [o.role, o]));
    const roles = ORCHESTRATOR_MODEL_ROLES.map((role) => {
      // The env default model for this role (no workspace = env path).
      const envModel = deps.router.profile(role)?.model ?? null;
      const override = overrides.get(role) ?? null;
      // The model actually in effect for this workspace right now.
      const effectiveModel = deps.router.profile(role, ws.workspaceId)?.model ?? null;
      return { role, envModel, effectiveModel, override };
    });
    // Autonomy signal: agent sessions / the tool loop need a resolvable
    // function-calling model. Mirrors WorkflowEngine `canRun` exactly
    // (evaluation → conversation, incl. the first-connected-agent fallback) so
    // the UI can prompt the operator to pick one when nothing is configured —
    // never by editing `.env`.
    const autonomyProfile = deps.router.profile('evaluation', ws.workspaceId)
      ?? deps.router.profile('conversation', ws.workspaceId);
    const autonomy = { enabled: Boolean(autonomyProfile), model: autonomyProfile?.model ?? null };
    return c.json({ roles, autonomy });
  });

  app.put('/:role', async (c) => {
    const ws = getWorkspace(c);
    const role = roleSchema.parse(c.req.param('role')) as OrchestratorModelRole;
    const body = setSchema.parse(await c.req.json());
    const saved = deps.config.set({
      workspaceId: ws.workspaceId,
      role,
      model: body.model,
      baseUrl: body.baseUrl ?? null,
      ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
    });
    return c.json({ role: saved });
  });

  app.delete('/:role', (c) => {
    const ws = getWorkspace(c);
    const role = roleSchema.parse(c.req.param('role')) as OrchestratorModelRole;
    deps.config.clear(ws.workspaceId, role);
    return c.json({ ok: true });
  });

  // Surface a clear error for an unknown role rather than a generic 500.
  app.onError((err, c) => {
    if (err instanceof AgentisError) throw err;
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'invalid model role or body' } }, 422);
    }
    throw err;
  });

  return app;
}
