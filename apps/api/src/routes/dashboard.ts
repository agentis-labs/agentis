/**
 * /v1/dashboard — V1-SPEC §11.1 fleet-overview aggregate.
 *
 * Single read endpoint that powers the dashboard landing page. Aggregates
 * counts from the live tables in one transaction — fine for V1's single-
 * tenant deployment scale; trade up to a denormalized projection if
 * latency becomes a problem.
 */

import { Hono } from 'hono';
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
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
    const agentsTotal = countRows(deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ws.workspaceId))
      .get());
    const agentsOnline = countRows(deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.agents)
      .where(and(
        eq(schema.agents.workspaceId, ws.workspaceId),
        eq(schema.agents.status, 'online'),
      ))
      .get());
    const gatewaysTotal = countRows(deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.openclawGateways)
      .where(eq(schema.openclawGateways.workspaceId, ws.workspaceId))
      .get());
    const gatewaysConnected = countRows(deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.openclawGateways)
      .where(and(eq(schema.openclawGateways.workspaceId, ws.workspaceId), eq(schema.openclawGateways.status, 'connected')))
      .get());
    const runsTotal = countRows(deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.workspaceId, ws.workspaceId))
      .get());
    const activeRuns = countRows(deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.workflowRuns)
      .where(and(
        eq(schema.workflowRuns.workspaceId, ws.workspaceId),
        eq(schema.workflowRuns.status, 'RUNNING'),
      ))
      .get());
    const workflowsTotal = countRows(deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .get());
    const approvalsPending = countRows(deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, ws.workspaceId),
          eq(schema.approvalRequests.status, 'pending'),
        ),
      )
      .get());
    const recentRuns = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.workspaceId, ws.workspaceId))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(10)
      .all();

    const tokenRows = deps.db
      .select({
        tokensIn: sql<number>`coalesce(sum(${schema.agentSessions.totalTokensIn}), 0)`.mapWith(Number),
        tokensOut: sql<number>`coalesce(sum(${schema.agentSessions.totalTokensOut}), 0)`.mapWith(Number),
      })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.workspaceId, ws.workspaceId))
      .get();
    const totalTokens = (tokenRows?.tokensIn ?? 0) + (tokenRows?.tokensOut ?? 0);

    return c.json({
      agents: { total: agentsTotal, online: agentsOnline },
      gateways: { total: gatewaysTotal, connected: gatewaysConnected },
      workflows: { total: workflowsTotal },
      runs: { active: activeRuns, total: runsTotal, recent: recentRuns, totalTokens },
      approvals: { pending: approvalsPending },
      operator: getUser(c),
    });
  });

  return app;
}

function countRows(row: { count: number | string | bigint } | undefined): number {
  return Number(row?.count ?? 0);
}
