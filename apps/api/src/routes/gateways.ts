/**
 * /v1/gateways — V1-SPEC §3.3 spec-named entry point.
 *
 * Composes the GET-list endpoint with the pair / patch / sync / delete
 * surface from `gatewayMutations.ts`.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { buildGatewayMutationRoutes } from './gatewayMutations.js';

export function buildGatewayRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({
      gateways: deps.db
        .select()
        .from(schema.openclawGateways)
        .where(eq(schema.openclawGateways.workspaceId, ws.workspaceId))
        .all(),
    });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const gw = deps.db
      .select()
      .from(schema.openclawGateways)
      .where(
        and(
          eq(schema.openclawGateways.id, id),
          eq(schema.openclawGateways.workspaceId, ws.workspaceId),
        ),
      )
      .get();
    if (!gw) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'gateway not found' } }, 404);
    }
    return c.json({ gateway: gw });
  });

  app.get('/:id/models', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const gw = deps.db
      .select({ id: schema.openclawGateways.id })
      .from(schema.openclawGateways)
      .where(and(eq(schema.openclawGateways.id, id), eq(schema.openclawGateways.workspaceId, ws.workspaceId)))
      .get();
    if (!gw) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'gateway not found' } }, 404);
    }
    return c.json({ models: [] });
  });

  app.route('/', buildGatewayMutationRoutes(deps));

  return app;
}
