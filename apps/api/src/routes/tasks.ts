/**
 * /v1/tasks — V1-SPEC §3.3 spec-named entry point.
 *
 * Read-only task surface. Tasks are agent-execution units derived from the
 * adapter dispatch pipeline (see adapters/AdapterManager.ts). The engine
 * writes task rows; this surface lets the dashboard query open tasks per
 * workspace + agent.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildTaskRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.query('agentId');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500);
    // Tasks bind to executors via (executorType, executorRef). Filtering by
    // an agent id therefore narrows to executorType='agent' AND executorRef.
    const where = agentId
      ? and(
          eq(schema.tasks.workspaceId, ws.workspaceId),
          eq(schema.tasks.executorType, 'agent'),
          eq(schema.tasks.executorRef, agentId),
        )
      : eq(schema.tasks.workspaceId, ws.workspaceId);
    const rows = deps.db
      .select()
      .from(schema.tasks)
      .where(where)
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
    return c.json({ tasks: rows });
  });

  return app;
}
