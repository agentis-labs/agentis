/**
 * Workspace analytics (§7.1) — `GET /v1/workflows/:id/analytics`.
 *
 * Thin route over {@link aggregateRunAnalytics}: resolves the workflow (and its
 * graph for node-title mapping) and returns the shared metric shape — run
 * counts, success rate, average duration, real token consumption, cost, and the
 * per-node failure breakdown. Mounted at `/v1/workflows`.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import { aggregateRunAnalytics } from '../services/run/runAnalytics.js';

export function buildAnalyticsRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/:id/analytics', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = deps.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, ws.workspaceId))).get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `Workflow ${id} not found`);

    const analytics = aggregateRunAnalytics(deps.db, ws.workspaceId, [
      { id: wf.id, title: wf.title, graph: wf.graph as WorkflowGraph },
    ]);
    return c.json({ workflowId: id, ...analytics });
  });

  return app;
}
