/**
 * /v1/dashboard — V1-SPEC §11.1 fleet-overview aggregate.
 *
 * Single read endpoint that powers the dashboard landing page. Aggregates
 * counts from the live tables in one transaction — fine for V1's single-
 * tenant deployment scale; trade up to a denormalized projection if
 * latency becomes a problem.
 */

import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { WorkflowGraph, WorkflowRunState, WorkflowSelfHealIncident } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ApprovalInboxService, PresentedApproval } from '../services/approvalInbox.js';
import { requireAuth, getUser } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { firstFailedNodeId } from '../services/run/runStateFailures.js';

export function buildDashboardRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; approvals?: ApprovalInboxService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/fleet-overview', (c) => {
    const ws = getWorkspace(c);
    return c.json(readFleetOverview(deps.db, ws.workspaceId, getUser(c)));
  });

  app.get('/chrome', (c) => {
    const ws = getWorkspace(c);
    // readFleetOverview's gateways.{total,connected} already folds in
    // messaging channel connections (see readFleetOverview below) — do not
    // re-count schema.channelConnections here, or every channel gets counted
    // twice.
    const fleetOverview = readFleetOverview(deps.db, ws.workspaceId, getUser(c), { includeRecentRuns: false });

    const fleet = {
      runs: {
        active: fleetOverview.runs.active,
        total: fleetOverview.runs.total,
        totalTokens: fleetOverview.runs.totalTokens,
      },
      gateways: fleetOverview.gateways,
      approvals: fleetOverview.approvals,
    };
    const agents = readChromeAgents(deps.db, ws.workspaceId);
    const liveAgents = agents.filter((agent) => LIVE_AGENT_STATUSES.has(agent.status ?? '')).length;
    const activeRuns = countRows(deps.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.workflowRuns)
      .where(and(
        eq(schema.workflowRuns.workspaceId, ws.workspaceId),
        inArray(schema.workflowRuns.status, ACTIVE_RUN_STATUSES),
      ))
      .get());
    const approvals = deps.approvals?.list(ws.workspaceId, 'pending') ?? readBasicApprovals(deps.db, ws.workspaceId);
    const latestActivity = deps.db
      .select({
        id: schema.activityEvents.id,
        summary: schema.activityEvents.summary,
        createdAt: schema.activityEvents.createdAt,
      })
      .from(schema.activityEvents)
      .where(eq(schema.activityEvents.workspaceId, ws.workspaceId))
      .orderBy(desc(schema.activityEvents.createdAt))
      .limit(1)
      .get() ?? null;
    const failedRuns = readChromeRuns(deps.db, ws.workspaceId, FAILED_RUN_STATUSES, 5);

    return c.json({
      workspaceId: ws.workspaceId,
      fleet,
      approvals,
      latestActivity,
      notifications: deriveChromeNotifications(approvals, failedRuns, agents),
      counts: {
        liveAgents,
        activeRuns,
      },
    });
  });

  return app;
}

const LIVE_AGENT_STATUSES = new Set(['online', 'active', 'running']);
const ACTIVE_RUN_STATUSES = ['RUNNING', 'WAITING', 'PAUSED', 'CREATED'];
const FAILED_RUN_STATUSES = ['FAILED', 'COMPLETED_WITH_ERRORS'];

type DashboardUser = ReturnType<typeof getUser>;
type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;
type WorkflowRow = typeof schema.workflows.$inferSelect;
type ChromeAgent = {
  id: string;
  name: string;
  status: string | null;
  role: string | null;
};
type ChromeRun = {
  id: string;
  workflowId?: string;
  workflowName?: string;
  failedNodeId?: string;
  failedNode?: string;
  finishedAt?: string | null;
  failureReason?: string | null;
  selfHealIncident?: WorkflowSelfHealIncident | null;
};

function readFleetOverview(
  db: AgentisSqliteDb,
  workspaceId: string,
  operator: DashboardUser,
  options: { includeRecentRuns?: boolean } = { includeRecentRuns: true },
) {
  const agentsTotal = countRows(db
    .select({ count: sql<number>`count(*)` })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .get());
  const agentsOnline = countRows(db
    .select({ count: sql<number>`count(*)` })
    .from(schema.agents)
    .where(and(
      eq(schema.agents.workspaceId, workspaceId),
      eq(schema.agents.status, 'online'),
    ))
    .get());
  const gatewaysTotal = countRows(db
    .select({ count: sql<number>`count(*)` })
    .from(schema.openclawGateways)
    .where(eq(schema.openclawGateways.workspaceId, workspaceId))
    .get());
  const gatewaysConnected = countRows(db
    .select({ count: sql<number>`count(*)` })
    .from(schema.openclawGateways)
    .where(and(eq(schema.openclawGateways.workspaceId, workspaceId), eq(schema.openclawGateways.status, 'connected')))
    .get());
  const channelConnectionsTotal = countRows(db
    .select({ count: sql<number>`count(*)` })
    .from(schema.channelConnections)
    .where(eq(schema.channelConnections.workspaceId, workspaceId))
    .get());
  const channelConnectionsActive = countRows(db
    .select({ count: sql<number>`count(*)` })
    .from(schema.channelConnections)
    .where(and(eq(schema.channelConnections.workspaceId, workspaceId), eq(schema.channelConnections.status, 'active')))
    .get());
  const runsTotal = countRows(db
    .select({ count: sql<number>`count(*)` })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workspaceId, workspaceId))
    .get());
  const activeRuns = countRows(db
    .select({ count: sql<number>`count(*)` })
    .from(schema.workflowRuns)
    .where(and(
      eq(schema.workflowRuns.workspaceId, workspaceId),
      eq(schema.workflowRuns.status, 'RUNNING'),
    ))
    .get());
  const workflowsTotal = countRows(db
    .select({ count: sql<number>`count(*)` })
    .from(schema.workflows)
    .where(eq(schema.workflows.workspaceId, workspaceId))
    .get());
  const approvalsPending = countRows(db
    .select({ count: sql<number>`count(*)` })
    .from(schema.approvalRequests)
    .where(
      and(
        eq(schema.approvalRequests.workspaceId, workspaceId),
        eq(schema.approvalRequests.status, 'pending'),
      ),
    )
    .get());
  const recentRuns = options.includeRecentRuns === false
    ? []
    : db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.workspaceId, workspaceId))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(10)
      .all();

  const tokenRows = db
    .select({
      tokensIn: sql<number>`coalesce(sum(${schema.agentSessions.totalTokensIn}), 0)`.mapWith(Number),
      tokensOut: sql<number>`coalesce(sum(${schema.agentSessions.totalTokensOut}), 0)`.mapWith(Number),
    })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.workspaceId, workspaceId))
    .get();
  const totalTokens = (tokenRows?.tokensIn ?? 0) + (tokenRows?.tokensOut ?? 0);

  return {
    agents: { total: agentsTotal, online: agentsOnline },
    gateways: { total: gatewaysTotal + channelConnectionsTotal, connected: gatewaysConnected + channelConnectionsActive },
    workflows: { total: workflowsTotal },
    runs: { active: activeRuns, total: runsTotal, recent: recentRuns, totalTokens },
    approvals: { pending: approvalsPending },
    operator,
  };
}

function readChromeAgents(db: AgentisSqliteDb, workspaceId: string): ChromeAgent[] {
  return db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      status: schema.agents.status,
      role: schema.agents.role,
    })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
}

function readBasicApprovals(db: AgentisSqliteDb, workspaceId: string): PresentedApproval[] {
  return db
    .select()
    .from(schema.approvalRequests)
    .where(and(
      eq(schema.approvalRequests.workspaceId, workspaceId),
      eq(schema.approvalRequests.status, 'pending'),
    ))
    .all()
    .map((row) => ({
      ...row,
      payload: asRecord(row.payload),
      workflowId: null,
      workflowName: null,
      agentName: null,
      nodeTitle: null,
      nodeType: null,
    }));
}

function readChromeRuns(
  db: AgentisSqliteDb,
  workspaceId: string,
  statuses: string[],
  limit: number,
): ChromeRun[] {
  const rows = db
    .select()
    .from(schema.workflowRuns)
    .where(and(
      eq(schema.workflowRuns.workspaceId, workspaceId),
      inArray(schema.workflowRuns.status, statuses),
    ))
    .orderBy(desc(schema.workflowRuns.completedAt), desc(schema.workflowRuns.createdAt))
    .limit(limit)
    .all();
  const workflowsById = loadWorkflowMap(db, workspaceId, rows.map((row) => row.workflowId));
  return rows.map((row) => presentChromeRun(row, workflowsById.get(row.workflowId ?? '')));
}

function loadWorkflowMap(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflowIds: Array<string | null>,
): Map<string, WorkflowRow> {
  const ids = [...new Set(workflowIds.filter((workflowId): workflowId is string => Boolean(workflowId)))];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), inArray(schema.workflows.id, ids)))
      .all()
      .map((workflow) => [workflow.id, workflow]),
  );
}

function presentChromeRun(run: WorkflowRunRow, workflow: WorkflowRow | undefined): ChromeRun {
  const state = run.runState as WorkflowRunState;
  const graph = resolveRunGraph(run, workflow);
  const failedNodeId = firstFailedNodeId(state);
  const failedNode = failedNodeId ? graph.nodes.find((node) => node.id === failedNodeId) : null;
  return {
    id: run.id,
    workflowId: run.workflowId ?? undefined,
    workflowName: workflow?.title ?? run.ephemeralTitle ?? undefined,
    finishedAt: run.completedAt ?? null,
    failedNodeId: failedNodeId ?? undefined,
    failedNode: failedNode?.title ?? failedNodeId ?? undefined,
    failureReason: failedNodeId ? state.nodeStates?.[failedNodeId]?.error ?? null : null,
    selfHealIncident: presentSelfHealIncident(state, failedNodeId ?? undefined),
  };
}

function resolveRunGraph(run: WorkflowRunRow, workflow: WorkflowRow | undefined): WorkflowGraph {
  const fromSnapshot = run.graphSnapshot as WorkflowGraph | null;
  const fromWorkflow = workflow?.graph as WorkflowGraph | undefined;
  return fromSnapshot ?? fromWorkflow ?? {
    version: 1,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function presentSelfHealIncident(state: WorkflowRunState, failedNodeId?: string): WorkflowSelfHealIncident | null {
  const incidents = Object.values(state.selfHealIncidents ?? {});
  if (incidents.length === 0) return null;
  const latest = (items: WorkflowSelfHealIncident[]) =>
    items.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
  if (failedNodeId) {
    const exact = incidents.find((incident) => incident.nodeId === failedNodeId);
    if (exact) return exact;
    return latest(incidents.filter((incident) => incident.status !== 'APPLIED'));
  }
  return latest(incidents);
}

function deriveChromeNotifications(
  approvals: PresentedApproval[],
  failedRuns: ChromeRun[],
  agents: ChromeAgent[],
) {
  const setup = [];
  const rest = [];

  const hasOrchestrator = agents.some((agent) => (agent.role ?? '').toLowerCase().includes('orchestrator'));
  if (!hasOrchestrator) {
    setup.push({
      id: 'setup-orchestrator',
      type: 'setup',
      title: 'Commission your orchestrator',
      context: 'The orchestrator routes goals, approvals, and command across the workspace.',
      timestamp: new Date().toISOString(),
      actionLabel: 'Commission orchestrator',
      actionEvent: 'agentis:commission-orchestrator',
    });
  }

  for (const approval of approvals) {
    const selfHeal = approval.source === 'self_heal';
    rest.push({
      id: `approval-${approval.id}`,
      type: 'approval',
      title: selfHeal ? 'Self-healing needs approval' : 'Approval needed',
      context: approval.summary || `${approval.workflowName ?? 'workflow'} - ${approval.agentName ?? 'agent'}`,
      timestamp: approval.createdAt,
      runId: approval.runId ?? undefined,
      workflowId: approval.workflowId ?? undefined,
      workflowName: approval.workflowName ?? undefined,
      agentName: approval.agentName ?? undefined,
      approvalId: approval.id,
    });
  }

  const selfHealApprovalRunIds = new Set(
    approvals
      .filter((approval) => approval.source === 'self_heal' && approval.runId)
      .map((approval) => approval.runId),
  );

  for (const run of failedRuns) {
    if (run.id && selfHealApprovalRunIds.has(run.id)) continue;
    const incident = run.selfHealIncident;
    if (incident) {
      const blocked = incident.status === 'EXHAUSTED' ? 'Self-healing exhausted' : 'Self-healing blocked';
      rest.push({
        id: `self-heal-${run.id}-${incident.nodeId}`,
        type: 'failure',
        title: blocked,
        context: selfHealIncidentSummary(incident, run),
        timestamp: incident.updatedAt ?? run.finishedAt ?? new Date().toISOString(),
        runId: run.id,
        workflowId: run.workflowId,
        failedNodeId: incident.nodeId,
        workflowName: run.workflowName,
      });
      continue;
    }
    rest.push({
      id: `failed-${run.id}`,
      type: 'failure',
      title: 'Workflow failed',
      context: `${run.workflowName ?? 'Workflow'}${run.failedNode ? ` - failed at ${run.failedNode}` : ''}`,
      timestamp: run.finishedAt ?? new Date().toISOString(),
      runId: run.id,
      workflowId: run.workflowId,
      failedNodeId: run.failedNodeId,
      workflowName: run.workflowName,
    });
  }

  const sorted = rest.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return [...setup, ...sorted].slice(0, 8);
}

function selfHealIncidentSummary(incident: WorkflowSelfHealIncident, run: ChromeRun): string {
  const node = incident.nodeTitle ?? run.failedNode ?? incident.nodeId;
  const reason = incident.reason ?? incident.diagnosis ?? run.failureReason ?? 'Agentis could not certify a safe repair.';
  return `${run.workflowName ?? 'Workflow'} - ${node}: ${reason}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function countRows(row: { count: number | string | bigint } | undefined): number {
  return Number(row?.count ?? 0);
}
