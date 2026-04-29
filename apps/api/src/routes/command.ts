/**
 * /v1/command/search — Cmd+K palette backend.
 */

import { Hono } from 'hono';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CommandIndex } from '../services/commandIndex.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildCommandRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  commandIndex: CommandIndex;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));
  app.get('/search', (c) => {
    const ws = getWorkspace(c);
    const q = c.req.query('q') ?? '';
    return c.json({ hits: deps.commandIndex.search(ws.workspaceId, q) });
  });
  return app;
}
