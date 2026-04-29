/**
 * /v1/dashboard — V1-SPEC §11.1 fleet-overview aggregate.
 *
 * Single read endpoint that powers the dashboard landing page. Aggregates
 * counts from the live tables in one transaction — fine for V1's single-
 * tenant deployment scale; trade up to a denormalized projection if
 * latency becomes a problem.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth, getUser } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildDashboardRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/fleet-overview', (c) => {
    const ws = getWorkspace(c);
    const agents = deps.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ws.workspaceId))
      .all();
    const gateways = deps.db
      .select()
      .from(schema.openclawGateways)
      .where(eq(schema.openclawGateways.workspaceId, ws.workspaceId))
      .all();
    const runs = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.workspaceId, ws.workspaceId))
      .all();
    const workflows = deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .all();
    const approvals = deps.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, ws.workspaceId),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      )
      .all();

    const activeRuns = runs.filter((r) => r.status === 'RUNNING' || r.status === 'WAITING');
    const recentRuns = runs
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 10);

    return c.json({
      agents: { total: agents.length, online: agents.filter((a) => a.status === 'online').length },
      gateways: {
        total: gateways.length,
        connected: gateways.filter((g) => g.status === 'connected').length,
      },
      workflows: { total: workflows.length },
      runs: { active: activeRuns.length, total: runs.length, recent: recentRuns },
      approvals: { pending: approvals.length },
      operator: getUser(c),
    });
  });

  return app;
}
