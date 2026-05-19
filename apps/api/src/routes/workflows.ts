/**
 * /v1/workflows — list/get/create/update + run trigger.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  schemas,
  type WorkflowGraph,
  type WorkflowRunState,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { EventBus } from '../event-bus.js';
import type { PackagerService } from '../services/packager.js';
import type { AppDataService } from '../services/appDataService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { validateWorkflowGraph } from '../engine/validateGraph.js';
import { buildInitialRunState } from '../engine/initialRunState.js';

export function buildWorkflowRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  bus: EventBus;
  /** Optional: when provided, every create/update mirrors the workflow into Packages. */
  packager?: PackagerService;
  /** Optional: backs the workflow Output tab's accumulated-records browser. */
  appData?: AppDataService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .all();
    return c.json({ workflows: rows });
  });

  // ── Workflow collections (UI grouping) ────────────────────────────────
  // A "collection" is a free-form string operators assign in workflow
  // settings.collection. We expose distinct collection names + counts so the
  // Workflows page can render named groups ("Growth Funnel", "Onboarding").
  app.get('/collections', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select({ id: schema.workflows.id, settings: schema.workflows.settings, title: schema.workflows.title })
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .all();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const collection = (((row.settings as Record<string, unknown> | null) ?? {}).collection as string | undefined)?.trim();
      if (!collection) continue;
      counts.set(collection, (counts.get(collection) ?? 0) + 1);
    }
    const collections = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ collections });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = schemas.createWorkflowSchema.parse({
      ...(await c.req.json()),
      workspaceId: ws.workspaceId,
    });
    const graph = (body.graph ?? {
      version: 1,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }) as WorkflowGraph;
    const id = randomUUID();
    if (graph.nodes.length > 0) validateWorkflowGraph(graph, { currentWorkflowId: id });
    deps.db
      .insert(schema.workflows)
      .values({
        id,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId ?? body.ambientId ?? null,
        userId: ws.user.id,
        title: body.title,
        summary: body.summary ?? null,
        intendedBehavior: body.intendedBehavior?.trim() || null,
        graph,
        settings: body.settings,
      })
      .run();
    // 10.14: auto-save into the Packages library
    try { deps.packager?.mirrorWorkflow({ workspaceId: ws.workspaceId, ambientId: ws.ambientId ?? null, userId: ws.user.id }, id); }
    catch { /* best-effort mirror */ }
    return c.json({ workflow: { id, ...body, graph } }, 201);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    return c.json({ workflow: wf });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const body = schemas.updateWorkflowSchema.parse(await c.req.json());
    if (body.graph) validateWorkflowGraph(body.graph as WorkflowGraph, { currentWorkflowId: id });
    deps.db
      .update(schema.workflows)
      .set({
        title: body.title ?? wf.title,
        summary: body.summary === undefined ? wf.summary : body.summary,
        intendedBehavior: body.intendedBehavior === undefined ? wf.intendedBehavior : (body.intendedBehavior?.trim() || null),
        graph: (body.graph as WorkflowGraph | undefined) ?? (wf.graph as WorkflowGraph),
        settings: body.settings ?? (wf.settings as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflows.id, id))
      .run();
    // 10.14: keep the mirrored package in sync
    try { deps.packager?.mirrorWorkflow({ workspaceId: ws.workspaceId, ambientId: ws.ambientId ?? null, userId: ws.user.id }, id); }
    catch { /* best-effort mirror */ }
    return c.json({ ok: true });
  });

  app.post('/:id/run', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const body = schemas.runWorkflowSchema.parse(await c.req.json().catch(() => ({})));

    const graph = wf.graph as WorkflowGraph;
    if (graph.nodes.length === 0) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Cannot run an empty workflow');
    }
    validateWorkflowGraph(graph, { currentWorkflowId: wf.id });

    const runId = randomUUID();
    const state = buildInitialRunState({
      runId,
      workflowId: wf.id,
      graph,
      inputs: body.inputs,
    });

    deps.db
      .insert(schema.workflowRuns)
      .values({
        id: runId,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        workflowId: wf.id,
        userId: ws.user.id,
        status: 'CREATED',
        runState: state,
        triggerId: body.triggerId ?? null,
      })
      .run();

    // V1-SPEC §12: announce the run to the workspace before the engine
    // emits its first node event, so the dashboard's run history can flip
    // to CREATED state immediately.
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.RUN_CREATED, {
      runId,
      workflowId: wf.id,
      ambientId: ws.ambientId,
    });

    await deps.engine.startRun({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      workflowId: wf.id,
      userId: ws.user.id,
      triggerId: body.triggerId ?? null,
      inputs: body.inputs,
      initialState: state,
      graph,
    });

    return c.json({ runId }, 202);
  });

  // ── Workflow Page Redesign — Runs / Output tabs ────────────────────────
  // WORKFLOW-PAGE-REDESIGN.md: the workflow page answers two questions —
  // "what has this run?" (Runs tab) and "what did it produce?" (Output tab).

  /**
   * Scoped run history for one workflow. Drives the Runs tab.
   * Returns runs newest-first with operator-facing fields (lowercased status,
   * resolved trigger type, computed duration).
   */
  app.get('/:id/runs', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    loadWorkflow(deps.db, ws.workspaceId, id);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 30), 1), 100);
    const rows = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workflowId, id), eq(schema.workflowRuns.workspaceId, ws.workspaceId)))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(limit)
      .all();
    const triggerMap = resolveTriggerTypes(deps.db, rows.map((r) => r.triggerId));
    return c.json({ runs: rows.map((r) => mapRunSummary(r, triggerMap)) });
  });

  /**
   * Outputs of the most recent completed run.
   * Explicit `config.isOutput` nodes define the surface; otherwise every
   * completed sink node is surfaced for zero-config workflows.
   */
  app.get('/:id/output', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const run = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.workflowId, id),
          eq(schema.workflowRuns.workspaceId, ws.workspaceId),
          eq(schema.workflowRuns.status, 'COMPLETED'),
        ),
      )
      .orderBy(desc(schema.workflowRuns.completedAt), desc(schema.workflowRuns.createdAt))
      .limit(1)
      .get();
    if (!run) return c.json({ lastRun: null, outputs: [] });

    const triggerMap = resolveTriggerTypes(deps.db, [run.triggerId]);
    const graph = ((run.graphSnapshot as WorkflowGraph | null) ?? (wf.graph as WorkflowGraph)) ?? {
      version: 1,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const state = run.runState as WorkflowRunState;
    const outputs = buildFinalNodeOutputs(graph, state);
    return c.json({ lastRun: mapRunSummary(run, triggerMap), outputs });
  });

  /**
   * Accumulated records written by this workflow's `data_write` nodes.
   * Drives the Output tab's conditional "Accumulated Records" section.
   * One entry per distinct target table.
   */
  app.get('/:id/records', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const targets = dataWriteTargets(wf.graph as WorkflowGraph);
    if (targets.length === 0 || !deps.appData) return c.json({ tables: [] });
    const fallbackAppId = resolveWorkflowAppId(deps.db, id);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 5), 1), 100);

    const seen = new Set<string>();
    const tables: Array<Record<string, unknown>> = [];
    for (const t of targets) {
      const appId = t.appId ?? fallbackAppId;
      if (!appId) continue;
      const key = `${appId}:${t.table}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const result = deps.appData.query(appId, t.table, {
          limit,
          orderBy: 'created_at',
          orderDir: 'desc',
        });
        tables.push({
          table: t.table,
          appId,
          total: result.total,
          records: result.records,
          schema: deps.appData.schema(appId, t.table),
        });
      } catch {
        // Table not provisioned yet (workflow never run) — surface it empty.
        tables.push({ table: t.table, appId, total: 0, records: [], schema: null });
      }
    }
    return c.json({ tables });
  });

  /** Export one accumulated-records table as CSV text (operator download). */
  app.get('/:id/records/export', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const table = c.req.query('table');
    if (!table) throw new AgentisError('VALIDATION_FAILED', 'table query param required');
    if (!deps.appData) throw new AgentisError('INTERNAL_ERROR', 'Data layer unavailable');
    const appId = resolveRecordAppId(deps.db, wf.graph as WorkflowGraph, id, table);
    if (!appId) throw new AgentisError('RESOURCE_NOT_FOUND', 'No data table for this workflow');
    const result = deps.appData.query(appId, table, { limit: 500, orderBy: 'created_at', orderDir: 'desc' });
    return c.json({ filename: `${table}.csv`, csv: recordsToCsv(result.records) });
  });

  /** Paginated browse of one accumulated-records table (drives "Load more"). */
  app.get('/:id/records/:table', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const table = c.req.param('table');
    if (!deps.appData) return c.json({ table, total: 0, records: [], schema: null });
    const appId = resolveRecordAppId(deps.db, wf.graph as WorkflowGraph, id, table);
    if (!appId) return c.json({ table, total: 0, records: [], schema: null });
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20), 1), 200);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    try {
      const result = deps.appData.query(appId, table, {
        limit,
        offset,
        orderBy: 'created_at',
        orderDir: 'desc',
      });
      return c.json({
        table,
        appId,
        total: result.total,
        records: result.records,
        schema: deps.appData.schema(appId, table),
      });
    } catch {
      return c.json({ table, appId, total: 0, records: [], schema: null });
    }
  });

  /** Clear every record this workflow accumulated in one table. */
  app.delete('/:id/records', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const table = c.req.query('table');
    if (!table) throw new AgentisError('VALIDATION_FAILED', 'table query param required');
    if (!deps.appData) throw new AgentisError('INTERNAL_ERROR', 'Data layer unavailable');
    const appId = resolveRecordAppId(deps.db, wf.graph as WorkflowGraph, id, table);
    if (!appId) throw new AgentisError('RESOURCE_NOT_FOUND', 'No data table for this workflow');
    const removed = deps.appData.clearTable(ws.workspaceId, appId, table);
    return c.json({ ok: true, removed });
  });

  return app;
}

type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;

/** CREATED/PLANNING/WAITING collapse to "pending"; RUNNING stays distinct. */
function mapRunStatus(status: string): 'running' | 'completed' | 'failed' | 'pending' | 'cancelled' {
  switch (status) {
    case 'COMPLETED':
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

/** Build a triggerId → triggerType lookup for a batch of runs. */
function resolveTriggerTypes(db: AgentisSqliteDb, triggerIds: Array<string | null>): Map<string, string> {
  const ids = [...new Set(triggerIds.filter((t): t is string => Boolean(t)))];
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  for (const row of db
    .select({ id: schema.triggers.id, triggerType: schema.triggers.triggerType })
    .from(schema.triggers)
    .where(inArray(schema.triggers.id, ids))
    .all()) {
    map.set(row.id, row.triggerType);
  }
  return map;
}

function mapRunSummary(run: WorkflowRunRow, triggerMap: Map<string, string>) {
  const startedAt = run.startedAt ?? run.createdAt;
  const finishedAt = run.completedAt ?? null;
  let durationMs: number | null = null;
  if (startedAt && finishedAt) {
    const d = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
    durationMs = Number.isFinite(d) && d >= 0 ? d : null;
  }
  const rawType = run.triggerId ? triggerMap.get(run.triggerId) : null;
  const triggeredBy =
    rawType === 'cron'
      ? 'cron'
      : rawType === 'webhook'
        ? 'webhook'
        : rawType === 'persistent_listener'
          ? 'event'
          : 'manual';
  return {
    id: run.id,
    status: mapRunStatus(run.status),
    startedAt,
    finishedAt,
    durationMs,
    triggeredBy,
    isReplay: run.isReplay,
  };
}

interface FinalNodeOutput {
  nodeId: string;
  nodeTitle: string;
  kind: string;
  value: unknown;
}

type CompletedNodeOutput = {
  nid: string;
  st: NonNullable<WorkflowRunState['nodeStates'][string]>;
};

/**
 * Identify the output nodes of a completed run.
 * Explicit declarations are returned in graph order; zero-config leaf outputs
 * are returned newest-first by node completion time.
 */
function buildFinalNodeOutputs(graph: WorkflowGraph, state: WorkflowRunState): FinalNodeOutput[] {
  const completedIds = state.completedNodeIds ?? [];
  if (completedIds.length === 0) return [];
  const hasOutgoing = new Set((graph.edges ?? []).map((e) => e.source));
  const nodeById = new Map((graph.nodes ?? []).map((n) => [n.id, n] as const));

  const completed = completedIds
    .map((nid) => ({ nid, st: state.nodeStates?.[nid] }))
    .filter((x): x is CompletedNodeOutput => Boolean(x.st));
  if (completed.length === 0) return [];

  const completedById = new Map(completed.map((item) => [item.nid, item] as const));
  const declaredOutputNodes = (graph.nodes ?? [])
    .filter((node) => (node.config as { isOutput?: unknown })?.isOutput === true);
  if (declaredOutputNodes.length > 0) {
    return declaredOutputNodes
      .map((node) => completedById.get(node.id))
      .filter((item): item is CompletedNodeOutput => Boolean(item))
      .map((item) => formatFinalNodeOutput(item.nid, item.st, nodeById));
  }

  const sinks = completed
    .filter((item) => !hasOutgoing.has(item.nid))
    .sort((a, b) => {
      const ta = a.st.completedAt ? new Date(a.st.completedAt).getTime() : 0;
      const tb = b.st.completedAt ? new Date(b.st.completedAt).getTime() : 0;
      return tb - ta;
    });

  return sinks.map((item) => formatFinalNodeOutput(item.nid, item.st, nodeById));
}

function formatFinalNodeOutput(
  nodeId: string,
  nodeState: CompletedNodeOutput['st'],
  nodeById: Map<string, WorkflowGraph['nodes'][number]>,
): FinalNodeOutput {
  const node = nodeById.get(nodeId);
  const kind =
    (node?.config as { kind?: string } | undefined)?.kind ?? node?.type ?? 'unknown';
  return {
    nodeId,
    nodeTitle: node?.title ?? nodeId,
    kind,
    value: nodeState.outputData ?? null,
  };
}

/** Extract distinct { table, appId? } targets from a graph's data_write nodes. */
function dataWriteTargets(graph: WorkflowGraph): Array<{ table: string; appId?: string }> {
  const out: Array<{ table: string; appId?: string }> = [];
  for (const node of graph.nodes ?? []) {
    const config = node.config as { kind?: string; table?: string; appId?: string };
    if (config?.kind === 'data_write' && typeof config.table === 'string' && config.table) {
      out.push({ table: config.table, appId: config.appId });
    }
  }
  return out;
}

/** Resolve the app that owns a workflow (direct appId, or app entry workflow). */
function resolveWorkflowAppId(db: AgentisSqliteDb, workflowId: string): string | null {
  const wf = db
    .select({ appId: schema.workflows.appId })
    .from(schema.workflows)
    .where(eq(schema.workflows.id, workflowId))
    .get();
  if (wf?.appId) return wf.appId;
  const app = db
    .select({ id: schema.appInstances.id })
    .from(schema.appInstances)
    .where(eq(schema.appInstances.entryWorkflowId, workflowId))
    .get();
  return app?.id ?? null;
}

/** Resolve the app id backing a specific data_write table for a workflow. */
function resolveRecordAppId(
  db: AgentisSqliteDb,
  graph: WorkflowGraph,
  workflowId: string,
  table: string,
): string | null {
  const explicit = dataWriteTargets(graph).find((t) => t.table === table)?.appId;
  return explicit ?? resolveWorkflowAppId(db, workflowId);
}

/** Serialize records to CSV. Columns are the union of all record keys. */
function recordsToCsv(records: Array<Record<string, unknown>>): string {
  if (records.length === 0) return '';
  const columns: string[] = [];
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [columns.join(',')];
  for (const rec of records) {
    lines.push(columns.map((col) => escape(rec[col])).join(','));
  }
  return lines.join('\r\n');
}

function loadWorkflow(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const wf = db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, workspaceId)))
    .get();
  if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow not found');
  return wf;
}
