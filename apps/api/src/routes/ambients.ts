/**
 * /v1/ambients — V1-SPEC §3.3 spec-named entry point.
 *
 * Ambients are scoped under workspaces; the canonical CRUD surface lives at
 * `/v1/workspaces/:workspaceId/ambients/*` (see routes/workspaces.ts). This
 * file exposes a flat read endpoint for the dashboard's ambient picker that
 * lists every ambient the operator's workspace can see.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildAmbientRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({
      ambients: deps.db
        .select()
        .from(schema.ambients)
        .where(eq(schema.ambients.workspaceId, ws.workspaceId))
        .all(),
    });
  });

  return app;
}
