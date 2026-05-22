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
        concurrencyOverflow: 'queue',
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

  /**
   * POST /:id/nodes/:nodeId/test
   *
   * Dry-run a single node in isolation with the supplied inputs. Used by the
   * canvas Test tab so users can iterate on a node config without running
   * the entire workflow. Side-effecting nodes (integration, http_request,
   * agent_task, etc.) still hit real systems — this is a real dispatch
   * scoped to one node, not a mock.
   */
  app.post('/:id/nodes/:nodeId/test', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const nodeId = c.req.param('nodeId');
    loadWorkflow(deps.db, ws.workspaceId, id);
    const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> };
    const inputs = body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)
      ? body.inputs
      : {};
    const result = await deps.engine.testNode({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      workflowId: id,
      nodeId,
      inputs,
    });
    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.NODE_TEST_COMPLETED, {
      workflowId: id,
      nodeId,
      ok: result.ok,
      durationMs: result.durationMs,
    });
    return c.json(result, result.ok ? 200 : 422);
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


  return app;
}

type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;

/** CREATED/PLANNING/WAITING collapse to "pending"; RUNNING stays distinct. */
function mapRunStatus(status: string): 'running' | 'completed' | 'completed_with_violation' | 'failed' | 'pending' | 'cancelled' {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'COMPLETED_WITH_CONTRACT_VIOLATION':
      return 'completed_with_violation';
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
  const runState = run.runState as { contractViolations?: string[] } | null;
  return {
    id: run.id,
    status: mapRunStatus(run.status),
    startedAt,
    finishedAt,
    durationMs,
    triggeredBy,
    isReplay: run.isReplay,
    contractViolations: Array.isArray(runState?.contractViolations) ? runState!.contractViolations : undefined,
  };
}

interface FinalNodeOutput {
  nodeId: string;
  nodeTitle: string;
  kind: string;
  value: unknown;
  /** Viewer hint for the Output Surface (Layer 6). Set by `return_output` nodes. */
  renderAs?: 'html' | 'markdown' | 'table' | 'json' | 'text';
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
    .filter((node) => {
      const cfg = node.config as { isOutput?: unknown; kind?: string };
      // `return_output` nodes are always part of the output surface; the legacy
      // `isOutput: true` flag on any node remains supported.
      return cfg?.isOutput === true || cfg?.kind === 'return_output';
    });
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
  const cfg = (node?.config as { kind?: string; renderAs?: FinalNodeOutput['renderAs'] } | undefined) ?? undefined;
  const kind = cfg?.kind ?? node?.type ?? 'unknown';
  const out = nodeState.outputData ?? null;
  // `return_output` unwraps to its rendered value + carries the renderAs hint.
  if (kind === 'return_output' && out && typeof out === 'object') {
    const o = out as { renderAs?: FinalNodeOutput['renderAs']; value?: unknown };
    return {
      nodeId,
      nodeTitle: node?.title ?? nodeId,
      kind,
      value: 'value' in o ? o.value : out,
      renderAs: o.renderAs ?? cfg?.renderAs ?? 'json',
    };
  }
  return {
    nodeId,
    nodeTitle: node?.title ?? nodeId,
    kind,
    value: out,
    ...(cfg?.renderAs ? { renderAs: cfg.renderAs } : {}),
  };
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
