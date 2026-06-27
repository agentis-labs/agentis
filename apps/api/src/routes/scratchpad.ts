/**
 * /v1/runs/:id/scratchpad — V1-SPEC §3.3 spec-named entry point.
 *
 * Read-only view of the per-run scratchpad. The scratchpad itself is owned
 * by `ScratchpadService` (services/scratchpad.ts) which the engine writes
 * to via `set()` / `append()` / `delete()`.
 */

import { Hono, type Context } from 'hono';
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

  const assertRunOwned = (c: Context): string => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    if (!id) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', 'Run not found');
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
    return id;
  };

  app.get('/:id/scratchpad', (c) => {
    const id = assertRunOwned(c);
    return c.json({ scratchpad: deps.scratchpad.snapshotOf(id) });
  });

  // Durable, identity-tagged blackboard log — the operator Blackboard panel
  // hydrates from here, then streams live via BLACKBOARD_ENTRY events.
  // Optional ?namespace= filters to a convergence loop's state. (§Pillar 2/3.)
  app.get('/:id/blackboard', (c) => {
    const id = assertRunOwned(c);
    const namespace = c.req.query('namespace') || undefined;
    const entries = deps.scratchpad.listEntries(id, { namespace });
    return c.json({ entries });
  });

  return app;
}
