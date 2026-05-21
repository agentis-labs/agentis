/**
 * /v1/runs — list, get, cancel, ledger, snapshot.
 */

import { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  AgentisError,
  schemas,
  type WorkflowGraph,
  type WorkflowGraphPatch,
  type WorkflowRunState,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { LedgerService } from '../services/ledger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildRunRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  ledger: LedgerService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
    const status = normalizeRunStatus(c.req.query('status'));
    const predicate = status.length > 0
      ? and(eq(schema.workflowRuns.workspaceId, ws.workspaceId), inArray(schema.workflowRuns.status, status))
      : eq(schema.workflowRuns.workspaceId, ws.workspaceId);
    const rows = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(predicate)
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(limit)
      .all();
    const workflowsById = loadWorkflowMap(deps.db, ws.workspaceId, rows.map((row) => row.workflowId));
    const agentsById = loadAgentMap(deps.db, ws.workspaceId, collectRunAgentIds(rows));
    return c.json({
      runs: rows.map((row) => presentRunSummary(row, workflowsById.get(row.workflowId ?? ''), agentsById)),
    });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const run = loadRunRow(deps.db, ws.workspaceId, id);
    const workflow = run.workflowId
      ? deps.db
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, run.workflowId), eq(schema.workflows.workspaceId, ws.workspaceId)))
        .get()
      : null;
    const agentsById = loadAgentMap(deps.db, ws.workspaceId, collectRunAgentIds([run]));
    return c.json({ run: presentRunDetail(run, workflow ?? null, agentsById) });
  });

  app.post('/:id/cancel', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    await deps.engine.cancelRun(id);
    return c.json({ ok: true });
  });

  app.get('/:id/ledger', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    const after = c.req.query('after_sequence')
      ? Number(c.req.query('after_sequence'))
      : undefined;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const events = await deps.ledger.listForRun({ runId: id, afterSequence: after, limit });
    return c.json({ events });
  });

  // V1-SPEC §6.6 — apply a graph patch to a (possibly live) run.
  app.post('/:id/graph-patches', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadRunRow(deps.db, ws.workspaceId, id);
    const patch = schemas.workflowGraphPatchSchema.parse(await c.req.json()) as WorkflowGraphPatch;
    const result = await deps.engine.applyGraphPatch({ runId: id, patch });
    return c.json({ runId: id, patchId: patch.patchId, ...result });
  });

  return app;
}

function normalizeRunStatus(status: string | undefined): string[] {
  const value = status?.trim().toUpperCase();
  if (!value) return [];
  if (value === 'ACTIVE') return ['RUNNING'];
  if (value === 'PENDING') return ['CREATED', 'PLANNING', 'WAITING'];
  const allowed = new Set(['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED']);
  return allowed.has(value) ? [value] : [];
}

type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;
type WorkflowRow = typeof schema.workflows.$inferSelect;

function loadRunRow(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.id, id), eq(schema.workflowRuns.workspaceId, workspaceId)))
    .get();
  if (!run) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', 'Run not found');
  return run;
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

function loadAgentMap(
  db: AgentisSqliteDb,
  workspaceId: string,
  agentIds: string[],
): Map<string, { id: string; name: string }> {
  const ids = [...new Set(agentIds)];
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

function collectRunAgentIds(rows: WorkflowRunRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const state = row.runState as WorkflowRunState;
    for (const execution of Object.values(state.activeExecutions ?? {})) {
      if (execution.executorType === 'agent' && execution.executorRef) ids.add(execution.executorRef);
    }
  }
  return [...ids];
}

function presentRunSummary(
  run: WorkflowRunRow,
  workflow: WorkflowRow | undefined,
  agentsById: Map<string, { id: string; name: string }>,
) {
  const state = run.runState as WorkflowRunState;
  const graph = resolveRunGraph(run, workflow);
  const currentNodeId = currentRunNodeId(state);
  const currentNode = currentNodeId ? graph.nodes.find((node) => node.id === currentNodeId) : null;
  const failedNodeId = state.failedNodeIds?.[0] ?? null;
  const failedNode = failedNodeId ? graph.nodes.find((node) => node.id === failedNodeId) : null;
  const totalSteps = graph.nodes.length > 0 ? graph.nodes.length : undefined;
  const stepIndex = totalSteps
    ? Math.min(totalSteps, (state.completedNodeIds?.length ?? 0) + (state.failedNodeIds?.length ?? 0) + (currentNode ? 1 : 0))
    : undefined;
  return {
    id: run.id,
    workflowId: run.workflowId ?? '',
    workflowName: workflow?.title ?? run.ephemeralTitle ?? undefined,
    status: mapRunStatus(run.status),
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? run.createdAt,
    completedAt: run.completedAt ?? null,
    finishedAt: run.completedAt ?? null,
    durationMs: computeDurationMs(run.startedAt ?? run.createdAt, run.completedAt),
    currentStep: currentNode?.title,
    totalSteps,
    stepIndex,
    failedNode: failedNode?.title ?? failedNodeId ?? undefined,
    failureReason: failedNodeId ? state.nodeStates?.[failedNodeId]?.error ?? null : null,
    agents: collectRunAgents(state, agentsById),
  };
}

function presentRunDetail(
  run: WorkflowRunRow,
  workflow: WorkflowRow | null,
  agentsById: Map<string, { id: string; name: string }>,
) {
  const state = run.runState as WorkflowRunState;
  const graph = resolveRunGraph(run, workflow ?? undefined);
  const nodes = buildRunNodes(graph, state);
  const completedCount = nodes.filter((node) => node.status === 'completed').length;
  const failedCount = nodes.filter((node) => node.status === 'failed').length;
  const activeAgents = collectRunAgents(state, agentsById);
  return {
    id: run.id,
    workflowId: run.workflowId ?? '',
    workflowName: workflow?.title ?? run.ephemeralTitle ?? 'Run',
    appSlug: undefined,
    appName: undefined,
    status: mapRunStatus(run.status),
    startedAt: run.startedAt ?? run.createdAt,
    finishedAt: run.completedAt ?? undefined,
    durationMs: computeDurationMs(run.startedAt ?? run.createdAt, run.completedAt),
    triggeredBy: 'manual',
    keyMetrics: [
      { label: 'Completed nodes', value: completedCount },
      { label: 'Failed nodes', value: failedCount },
      { label: 'Active agents', value: activeAgents.length },
    ],
    nodes,
  };
}

function buildRunNodes(graph: WorkflowGraph, state: WorkflowRunState) {
  const ids = new Set<string>();
  for (const node of graph.nodes) ids.add(node.id);
  for (const nodeId of Object.keys(state.nodeStates ?? {})) ids.add(nodeId);

  return [...ids].map((nodeId) => {
    const graphNode = graph.nodes.find((node) => node.id === nodeId);
    const nodeState = state.nodeStates?.[nodeId];
    return {
      id: nodeId,
      nodeId,
      title: graphNode?.title ?? nodeId,
      type: graphNode?.type ?? 'unknown',
      kind: graphNode?.config.kind ?? graphNode?.type ?? 'unknown',
      status: mapNodeStatus(nodeId, state),
      startedAt: nodeState?.startedAt,
      finishedAt: nodeState?.completedAt,
      durationMs: computeDurationMs(nodeState?.startedAt, nodeState?.completedAt),
      output: nodeState?.outputData,
      outputSummary: summarizeValue(nodeState?.outputData),
      inputs: nodeState?.inputData,
      error: nodeState?.error,
    };
  });
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

function currentRunNodeId(state: WorkflowRunState): string | null {
  return Object.keys(state.activeExecutions ?? {})[0] ?? state.readyQueue?.[0]?.nodeId ?? null;
}

function collectRunAgents(
  state: WorkflowRunState,
  agentsById: Map<string, { id: string; name: string }>,
): Array<{ id: string; name: string }> {
  const ids = new Set<string>();
  for (const execution of Object.values(state.activeExecutions ?? {})) {
    if (execution.executorType === 'agent' && execution.executorRef) ids.add(execution.executorRef);
  }
  return [...ids].map((id) => ({ id, name: agentsById.get(id)?.name ?? id }));
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

function mapNodeStatus(nodeId: string, state: WorkflowRunState): 'completed' | 'failed' | 'running' | 'skipped' | 'pending' {
  if (state.failedNodeIds?.includes(nodeId) || state.nodeStates?.[nodeId]?.status === 'FAILED') return 'failed';
  if (state.completedNodeIds?.includes(nodeId) || state.nodeStates?.[nodeId]?.status === 'COMPLETED') return 'completed';
  if (state.skippedNodeIds?.includes(nodeId) || state.nodeStates?.[nodeId]?.status === 'SKIPPED') return 'skipped';
  if (state.activeExecutions?.[nodeId] || state.nodeStates?.[nodeId]?.status === 'RUNNING') return 'running';
  return 'pending';
}

function computeDurationMs(startedAt?: string | null, finishedAt?: string | null): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const duration = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function summarizeValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.length > 72 ? `${value.slice(0, 69)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length > 0 ? `${value.length} items` : '0 items';
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return keys.slice(0, 3).join(', ');
  }
  return undefined;
}
