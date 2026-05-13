/**
 * /v1/integrations - built-in + workspace-authored connector manifests.
 *
 * Custom integrations are stored as Library packages (`kind = integration`) so
 * they remain exportable, packageable, and workspace-scoped without a parallel
 * registry table.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { defaultConnectorRegistry } from '@agentis/integrations';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import {
  createCustomIntegrationManifest,
  deleteCustomIntegrationManifest,
  getCustomIntegrationManifest,
  integrationManifestInputSchema,
  listIntegrationManifests,
  normalizeIntegrationManifest,
  testIntegrationManifest,
  updateCustomIntegrationManifest,
} from '../services/integrationRegistry.js';

const integrationTestSchema = z.object({
  operation: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  credential: z.record(z.unknown()).nullable().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

export function buildIntegrationRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ integrations: listIntegrationManifests(deps.db, ws.workspaceId) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const input = integrationManifestInputSchema.parse(await c.req.json());
    const manifest = normalizeIntegrationManifest(input);
    const integration = createCustomIntegrationManifest(deps.db, {
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
    }, manifest);
    return c.json({ integration }, 201);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const integration = listIntegrationManifests(deps.db, ws.workspaceId).find(
      (candidate) => candidate.id === id || candidate.packageId === id || candidate.service === id,
    );
    if (!integration) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Integration not found' } }, 404);
    return c.json({ integration });
  });

  app.put('/:id', async (c) => {
    const ws = getWorkspace(c);
    const input = integrationManifestInputSchema.parse(await c.req.json());
    const manifest = normalizeIntegrationManifest(input);
    const integration = updateCustomIntegrationManifest(deps.db, ws.workspaceId, c.req.param('id'), manifest);
    return c.json({ integration });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    deleteCustomIntegrationManifest(deps.db, ws.workspaceId, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/:id/test', async (c) => {
    const ws = getWorkspace(c);
    const body = integrationTestSchema.parse(await c.req.json());
    const id = c.req.param('id');
    const custom = (() => {
      try {
        return getCustomIntegrationManifest(deps.db, ws.workspaceId, id);
      } catch {
        return null;
      }
    })();
    if (custom) {
      const output = await testIntegrationManifest({
        manifest: custom,
        operation: body.operation,
        params: body.params,
        credential: body.credential,
        timeoutMs: body.timeoutMs,
      });
      return c.json({ ok: true, output });
    }
    const integration = listIntegrationManifests(deps.db, ws.workspaceId).find(
      (candidate) => candidate.service === id || candidate.id === id,
    );
    if (!integration) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Integration not found' } }, 404);
    const output = await defaultConnectorRegistry.execute(integration.service, {
      operation: body.operation,
      params: body.params,
      credential: body.credential ?? null,
      timeoutMs: body.timeoutMs,
    });
    return c.json({ ok: true, output });
  });

  return app;
}
