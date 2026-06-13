/**
 * /v1/command — Cmd+K palette: search + execute.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CommandIndex } from '../services/commandIndex.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const executeBodySchema = z.object({
  type: z.enum(['workflow', 'agent', 'gateway', 'run', 'approval', 'extension', 'conversation']),
  id: z.string().min(1),
});

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

  // V1-SPEC §11 — resolve a palette selection to a navigation target. The
  // dashboard POSTs here so the API is the single source of truth for hrefs
  // and entity-existence checks (no client-side guessing).
  app.post('/execute', async (c) => {
    const ws = getWorkspace(c);
    const body = executeBodySchema.parse(await c.req.json());
    const result = deps.commandIndex.execute(ws.workspaceId, body);
    return c.json(result);
  });

  return app;
}
