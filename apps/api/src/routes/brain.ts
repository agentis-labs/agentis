/**
 * /v1/brain — Global Brain (workspace-scoped intelligence surface).
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §12, §16.
 *
 * Routes:
 *   GET  /v1/brain                      → workspace-level Brain
 *
 * App-scoped Brain lives at `/v1/apps/:slug/brain` (see routes/apps.ts) so
 * it shares middleware with the rest of the app surface.
 */

import { Hono } from 'hono';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { BrainComposer } from '../services/brainComposer.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export interface BrainRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  brain: BrainComposer;
}

export function buildBrainRoutes(deps: BrainRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const response = deps.brain.composeForWorkspace(ws.workspaceId);
    return c.json(response);
  });

  return app;
}
