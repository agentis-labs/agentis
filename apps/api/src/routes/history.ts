/**
 * /v1/history — unified workspace timeline for runs, activity, and audit.
 */

import { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

type HistoryType = 'all' | 'runs' | 'activity' | 'audit';
type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;
type ActivityEventRow = typeof schema.activityEvents.$inferSelect;
type WorkflowRow = typeof schema.workflows.$inferSelect;

interface HistoryEvent {
  id: string;
  type: string;
  title: string;
  subtitle?: string;
  timestamp: string;
  status?: string;
  runId?: string;
  agentId?: string;
  agentName?: string;
  workflowName?: string;
  failedNode?: string;
  context?: Record<string, unknown>;
}

export function buildHistoryRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const type = parseType(c.req.query('type'));
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500);
    const events: HistoryEvent[] = [];

    if (type === 'all' || type === 'runs') {
      events.push(...loadRunEvents(deps.db, ws.workspaceId, limit));
    }

    if (type === 'all' || type === 'activity' || type === 'audit') {
      const activity = loadActivityEvents(deps.db, ws.workspaceId, limit * 2);
      const filtered = activity.filter((event) => {
        const audit = isAuditEvent(event);
        if (type === 'audit') return audit;
        if (type === 'activity') return !audit;
        return true;
      });
      const agentsById = loadAgentNames(deps.db, ws.workspaceId, filtered);
      events.push(...filtered.map((event) => presentActivityEvent(event, agentsById.get(event.actorId ?? ''))));
    }

    events.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    return c.json({ events: events.slice(0, limit) });
  });

  return app;
}

function parseType(value: string | undefined): HistoryType {
  return value === 'runs' || value === 'activity' || value === 'audit' ? value : 'all';
}

function loadRunEvents(db: AgentisSqliteDb, workspaceId: string, limit: number): HistoryEvent[] {
  const runs = db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workspaceId, workspaceId))
    .orderBy(desc(schema.workflowRuns.createdAt))
    .limit(limit)
    .all();
  const workflows = loadWorkflows(db, workspaceId, runs.map((run) => run.workflowId));
  return runs.map((run) => presentRunEvent(run, workflows.get(run.workflowId ?? '')));
}

function loadActivityEvents(db: AgentisSqliteDb, workspaceId: string, limit: number): ActivityEventRow[] {
  return db
    .select()
    .from(schema.activityEvents)
    .where(eq(schema.activityEvents.workspaceId, workspaceId))
    .orderBy(desc(schema.activityEvents.createdAt))
    .limit(limit)
    .all();
}

function loadWorkflows(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflowIds: Array<string | null>,
): Map<string, WorkflowRow> {
  const ids = [...new Set(workflowIds.filter((id): id is string => Boolean(id)))];
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

function loadAgentNames(
  db: AgentisSqliteDb,
  workspaceId: string,
  events: ActivityEventRow[],
): Map<string, { id: string; name: string }> {
  const ids = [...new Set(events
    .filter((event) => event.actorType === 'agent' && event.actorId)
    .map((event) => event.actorId as string))];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, ids)))
      .all()
      .map((agent) => [agent.id, agent]),
  );
}

function presentRunEvent(run: WorkflowRunRow, workflow?: WorkflowRow): HistoryEvent {
  const status = mapRunStatus(run.status);
  const workflowName = workflow?.title ?? run.ephemeralTitle ?? 'Workflow';
  const state = run.runState as WorkflowRunState;
  const failedNode = state.failedNodeIds?.[0] ?? undefined;
  return {
    id: `run-${run.id}`,
    type: status === 'failed'
      ? REALTIME_EVENTS.RUN_FAILED
      : status === 'completed'
        ? REALTIME_EVENTS.RUN_COMPLETED
        : `run.${status}`,
    title: status === 'failed' ? `${workflowName} failed` : `${workflowName} ${status}`,
    timestamp: run.completedAt ?? run.startedAt ?? run.createdAt,
    status,
    runId: run.id,
    workflowName,
    failedNode,
    context: {
      workflowId: run.workflowId,
      isEphemeral: run.isEphemeral,
      replanCount: run.replanCount,
    },
  };
}

function presentActivityEvent(event: ActivityEventRow, agent?: { id: string; name: string }): HistoryEvent {
  const audit = isAuditEvent(event);
  return {
    id: `activity-${event.id}`,
    type: audit ? 'audit' : event.eventType,
    title: event.summary,
    subtitle: `${event.actorType} ${event.eventType}`,
    timestamp: event.createdAt,
    status: statusFromActivity(event),
    agentId: agent && agent.id && event.actorType === 'agent' ? agent.id : undefined,
    agentName: agent && agent.id && event.actorType === 'agent'
      ? agent.name
      : undefined,
    context: {
      actorType: event.actorType,
      actorId: event.actorId,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: event.metadata,
    },
  };
}

function isAuditEvent(event: ActivityEventRow): boolean {
  const metadata = event.metadata as Record<string, unknown>;
  return event.actorType === 'user' && typeof metadata.method === 'string';
}

function mapRunStatus(status: string): 'running' | 'completed' | 'failed' | 'pending' | 'cancelled' {
  switch (status) {
    case 'COMPLETED':
    case 'COMPLETED_WITH_CONTRACT_VIOLATION':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'RUNNING':
      return 'running';
    default:
      return 'pending';
  }
}

function statusFromActivity(event: ActivityEventRow): string {
  const text = `${event.eventType} ${event.summary}`.toLowerCase();
  if (text.includes('fail') || text.includes('error')) return 'failed';
  if (text.includes('pending') || text.includes('requested')) return 'pending';
  if (text.includes('completed') || text.includes('created') || text.includes('installed')) return 'completed';
  return 'info';
}
