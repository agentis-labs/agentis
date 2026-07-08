/**
 * /v1/activity — V1-SPEC §3.3, §11.4 (recent activity stream).
 *
 * Read-only feed surface. Writes happen inside the engine + adapter glue
 * via ActivityFeedService.
 */

import { Hono } from 'hono';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ActivityFeedService } from '../services/activityFeed.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildActivityRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  activity: ActivityFeedService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json({ events: deps.activity.list(ws.workspaceId, limit) });
  });

  return app;
}
