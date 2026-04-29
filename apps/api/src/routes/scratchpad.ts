/**
 * /v1/runs/:id/scratchpad — V1-SPEC §3.3 spec-named entry point.
 *
 * Read-only view of the per-run scratchpad. The scratchpad itself is owned
 * by `ScratchpadService` (services/scratchpad.ts) which the engine writes
 * to via `set()` / `append()` / `delete()`.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ScratchpadService } from '../services/scratchpad.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildScratchpadRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  scratchpad: ScratchpadService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/:id/scratchpad', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const run = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.id, id),
          eq(schema.workflowRuns.workspaceId, ws.workspaceId),
        ),
      )
      .get();
    if (!run) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', 'Run not found');
    return c.json({ scratchpad: deps.scratchpad.snapshotOf(id) });
  });

  return app;
}
