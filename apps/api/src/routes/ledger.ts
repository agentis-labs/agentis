/**
 * /v1/runs/:id/ledger — V1-SPEC §3.3 spec-named entry point.
 *
 * The ledger endpoint is mounted as a sub-route of `/v1/runs` (see
 * routes/runs.ts) so it shares auth + workspace middleware with the
 * surrounding run lifecycle endpoints. This module exposes the same
 * handler under a dedicated builder so callers that only need the
 * ledger surface can mount it independently.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { LedgerService } from '../services/ledger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildLedgerRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  ledger: LedgerService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/:id/ledger', async (c) => {
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
    const after = c.req.query('after_sequence')
      ? Number(c.req.query('after_sequence'))
      : undefined;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const events = await deps.ledger.listForRun({
      runId: id,
      afterSequence: after,
      limit,
    });
    return c.json({ events });
  });

  return app;
}
