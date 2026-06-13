/**
 * Governance & fleet summary — surface what already exists (UNIVERSAL-HARNESS §8).
 *
 *   GET /v1/governance/summary
 *
 * The enterprise gate most agent platforms fail is traceability + cost control.
 * Agentis already records all of it (audit_entries, budget_events,
 * approval_requests, agent statuses, adapter health). This endpoint composes a
 * single read-only snapshot the dashboard/UI can render — it invents nothing.
 */

import { Hono } from 'hono';
import { and, desc, eq, gte } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export interface GovernanceRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  adapters: AdapterManager;
}

export function buildGovernanceRoutes(deps: GovernanceRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/summary', (c) => {
    const ws = getWorkspace(c);
    const since = startOfTodayIso();

    // ── Fleet: agents grouped by adapterType, with live-connection + status. ──
    const agents = deps.db.select({
      id: schema.agents.id,
      adapterType: schema.agents.adapterType,
      status: schema.agents.status,
      spend: schema.agents.currentMonthSpendCents,
      budget: schema.agents.monthlyBudgetCents,
    }).from(schema.agents).where(eq(schema.agents.workspaceId, ws.workspaceId)).all();

    const connected = new Set(deps.adapters.list().map((r) => r.agentId));
    const byAdapter = new Map<string, { total: number; connected: number; online: number; spendCents: number }>();
    let monthlySpendCents = 0;
    for (const a of agents) {
      const bucket = byAdapter.get(a.adapterType) ?? { total: 0, connected: 0, online: 0, spendCents: 0 };
      bucket.total += 1;
      if (connected.has(a.id)) bucket.connected += 1;
      if (a.status === 'online' || a.status === 'busy') bucket.online += 1;
      bucket.spendCents += a.spend ?? 0;
      monthlySpendCents += a.spend ?? 0;
      byAdapter.set(a.adapterType, bucket);
    }

    // ── Cost: today's spend + limit-hit events from the budget ledger. ──
    const budgetToday = deps.db.select().from(schema.budgetEvents)
      .where(and(eq(schema.budgetEvents.workspaceId, ws.workspaceId), gte(schema.budgetEvents.createdAt, since)))
      .all();
    const spendTodayCents = budgetToday.filter((e) => e.eventType === 'spend').reduce((s, e) => s + e.amountCents, 0);
    const limitHitsToday = budgetToday.filter((e) => e.eventType === 'limit_hit').length;

    // ── Approvals: pending human gates. ──
    const pendingApprovals = deps.db.select({ id: schema.approvalRequests.id })
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.workspaceId, ws.workspaceId), eq(schema.approvalRequests.status, 'pending')))
      .all().length;

    // ── Audit: recent trail depth (traceability proof). ──
    const recentAudit = deps.db.select({ id: schema.auditEntries.id, at: schema.auditEntries.at })
      .from(schema.auditEntries)
      .where(eq(schema.auditEntries.workspaceId, ws.workspaceId))
      .orderBy(desc(schema.auditEntries.at))
      .limit(50)
      .all();

    return c.json({
      fleet: {
        totalAgents: agents.length,
        connected: connected.size,
        byAdapter: Object.fromEntries(byAdapter),
      },
      cost: {
        spendTodayCents,
        monthlySpendCents,
        limitHitsToday,
      },
      approvals: { pending: pendingApprovals },
      audit: {
        recentCount: recentAudit.length,
        latestAt: recentAudit[0]?.at ?? null,
      },
    });
  });

  return app;
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
