import { Hono } from 'hono';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { detectHarnesses } from '../services/harnessProbe.js';

export interface HarnessRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
}

export function buildHarnessRoutes(deps: HarnessRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/detect', async (c) => {
    const harnesses = await detectHarnesses();
    return c.json({ harnesses });
  });

  return app;
}
