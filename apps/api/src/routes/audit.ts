/**
 * Audit routes — `GET /v1/runs/:runId/audit` returns the full per-node
 * attribution log for a run (§5.4). Mounted at `/v1/runs`.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { AuditTrailService } from '../services/auditTrail.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export function buildAuditRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; audit: AuditTrailService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/:runId/audit', (c) => {
    const ws = getWorkspace(c);
    const runId = c.req.param('runId');
    const run = deps.db
      .select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.workspaceId, ws.workspaceId)))
      .get();
    if (!run) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', `Run ${runId} not found`);
    return c.json({ runId, entries: deps.audit.list(ws.workspaceId, runId) });
  });

  return app;
}
