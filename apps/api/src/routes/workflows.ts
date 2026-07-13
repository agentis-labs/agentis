/**
 * /v1/workflows — list/get/create/update + run trigger.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  schemas,
  summarizeGraphCapabilities,
  type IntegrationDeliveryReceipt,
  type WorkflowGraph,
  type WorkflowRunState,
} from '@agentis/core';
import { buildIntegrationDeliveryReceipt } from '@agentis/integrations';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import type { EventBus } from '../event-bus.js';
import type { PackagerService } from '../services/packager.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { validateWorkflowGraph } from '../engine/validateGraph.js';
import { validateGraphReferences } from '../engine/validateGraphReferences.js';
import { analyzeWorkflowReadiness } from '../services/workflow/workflowReadiness.js';
import { buildInitialRunState } from '../engine/initialRunState.js';
import { hashWorkflowGraph } from '../services/graphHash.js';
import { normalizeWorkflowGraph } from '../services/workflow/workflowGraphNormalization.js';
import { buildTemplateContext, resolveTemplateDeep } from '../engine/templateResolver.js';
import { WorkflowTriggerDeploymentService } from '../services/workflow/workflowTriggerDeployment.js';
import { preflightWorkflow } from '../services/workflow/workflowPreflight.js';
import { LOOP_STAGE_LABEL, compassForWorkflow, deriveLoopStage, detectProvenDivergence, graphContentHash, readBuildLoop } from '../services/workflow/workflowCompass.js';

export function buildWorkflowRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  bus: EventBus;
  triggerRuntime?: TriggerRuntime;
  /** Optional: when provided, every create/update mirrors the workflow into Packages. */
  packager?: PackagerService;
}) {
  const app = new Hono();

  // Legacy Studio public-surface route removed — public sharing now lives on the
  // Agentic App surface (AGENTIC-APPS-10X §4: GET /v1/apps/public/surfaces/:token).

  app.use('*', requireAuth(deps), requireWorkspace(deps));
  const deletedWorkflowsCache = new Map<string, any>();
  const triggerDeployments = deps.triggerRuntime
    ? new WorkflowTriggerDeploymentService(deps.db, deps.triggerRuntime)
    : null;

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .all();
    const latestRuns = loadLatestRunsByWorkflow(deps.db, ws.workspaceId, rows.map((row) => row.id));
    const triggerMap = resolveTriggerTypes(
      deps.db,
      [...latestRuns.values()].map((run) => run.triggerId),
    );
    return c.json({
      workflows: rows.map((row) => presentWorkflowListItem(row, latestRuns.get(row.id), triggerMap)),
    });
  });

  // ── Workflow collections (UI grouping) ────────────────────────────────
  // A "collection" is a free-form string operators assign in workflow
  // settings.collection. We expose distinct collection names + counts so the
  // Workflows page can render named groups ("Growth Funnel", "Onboarding").
  app.get('/collections', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select({
        id: schema.workflows.id,
        settings: schema.workflows.settings,
        title: schema.workflows.title,
      })
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .all();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const collection = (
        ((row.settings as Record<string, unknown> | null) ?? {}).collection as string | undefined
      )?.trim();
      if (!collection) continue;
      counts.set(collection, (counts.get(collection) ?? 0) + 1);
    }
    const collections = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ collections });
  });

  // Workspace-wide "always-on" workflows: every workflow whose entry trigger is
  // currently ARMED (schedule / webhook / listener), with next-run / last-fired /
  // last-run / listener health. Powers /home's Active section.
  app.get('/active', (c) => {
    const ws = getWorkspace(c);
    if (!triggerDeployments) return c.json({ workflows: [] });
    return c.json({ workflows: triggerDeployments.listActive(ws.workspaceId) });
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
    const normalizedGraph = normalizeWorkflowGraph(deps.db, ws.workspaceId, graph).graph;
    const id = randomUUID();
    if (body.spaceId) ensureWorkflowSpace(deps.db, ws.workspaceId, body.spaceId);
    if (normalizedGraph.nodes.length > 0)
      validateWorkflowGraph(normalizedGraph, { currentWorkflowId: id, strict: false });
    deps.db
      .insert(schema.workflows)
      .values({
        id,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId ?? body.ambientId ?? null,
        userId: ws.user.id,
        spaceId: body.spaceId ?? null,
        ownerAgentId: body.ownerAgentId ?? null,
        title: body.title,
        description: body.description?.trim() || null,
        graph: normalizedGraph,
        contentHash: hashWorkflowGraph(normalizedGraph),
        settings: body.settings,
        concurrencyOverflow: 'queue',
      })
      .run();
    // 10.14: auto-save into the Packages library
    try {
      deps.packager?.mirrorWorkflow(
        { workspaceId: ws.workspaceId, ambientId: ws.ambientId ?? null, userId: ws.user.id },
        id,
      );
    } catch {
      /* best-effort mirror */
    }
    return c.json({ workflow: { id, ...body, graph: normalizedGraph } }, 201);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    return c.json({ workflow: wf });
  });

  /**
   * GET /:id/capabilities — pre-run security/audit summary (NATIVE-ADVANCEMENT
   * Proposal 6b). Aggregates every node's capability manifest into "what does
   * this workflow actually touch" — external hosts, credentials, code execution
   * — so the canvas can surface it before a run. Also returns `contentHash` so
   * the client can detect divergence between its local graph and the saved one.
   */
  app.get('/:id/capabilities', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const graph = wf.graph as WorkflowGraph;
    return c.json({
      contentHash: (wf as { contentHash?: string | null }).contentHash ?? null,
      capabilities: summarizeGraphCapabilities(graph),
    });
  });

  /**
   * GET /:id/lint — static template-reference check (NATIVE-ADVANCEMENT
   * Proposal 2, reframed). Surfaces `{{nodes.X}}` references that are dangling
   * (X doesn't exist) or forward (X isn't upstream, so it won't have run yet) —
   * the bug class that otherwise resolves silently to empty input. Intended for
   * canvas annotations before a run; non-mutating.
   */
  app.get('/:id/lint', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const issues = validateGraphReferences(wf.graph as WorkflowGraph);
    return c.json({
      issues,
      errorCount: issues.filter((i) => i.severity === 'error').length,
      warningCount: issues.filter((i) => i.severity === 'warning').length,
    });
  });

  /**
   * GET /:id/readiness — plain-language setup the workflow still needs before it
   * can actually run (connect an account, supply credentials). Connector-agnostic
   * and advisory; lets the UI/chat ask intelligently instead of dead-ending a run.
   */
  app.get('/:id/readiness', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    return c.json(analyzeWorkflowReadiness(deps.db, ws.workspaceId, wf.graph as WorkflowGraph));
  });

  app.get('/:id/health', (c) => {
    const ws = getWorkspace(c);
    const wf = loadWorkflow(deps.db, ws.workspaceId, c.req.param('id'));
    return c.json(preflightWorkflow({
      db: deps.db,
      workspaceId: ws.workspaceId,
      workflowId: wf.id,
      graph: wf.graph as WorkflowGraph,
    }));
  });

  app.post('/:id/preflight', async (c) => {
    const ws = getWorkspace(c);
    const wf = loadWorkflow(deps.db, ws.workspaceId, c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as { inputs?: Record<string, unknown> };
    return c.json(preflightWorkflow({
      db: deps.db,
      workspaceId: ws.workspaceId,
      workflowId: wf.id,
      graph: wf.graph as WorkflowGraph,
      inputs: body.inputs,
    }));
  });

  // PAVED-ROAD P5 — where this workflow stands on the build loop (authored →
  // dry-run → debug-run → production), with staleness vs the CURRENT graph and
  // the exact next step. Same substrate the agent tools read.
  app.get('/:id/loop-status', (c) => {
    const ws = getWorkspace(c);
    const wf = loadWorkflow(deps.db, ws.workspaceId, c.req.param('id'));
    const graph = wf.graph as WorkflowGraph;
    const state = readBuildLoop(wf.settings);
    const hash = graphContentHash(graph);
    const stage = deriveLoopStage(state, hash);
    return c.json({
      workflowId: wf.id,
      stage,
      stageLabel: LOOP_STAGE_LABEL[stage],
      graphHash: hash,
      evidence: {
        validatedAt: state.validatedAt ?? null,
        dryRun: state.dryRun ? { ...state.dryRun, stale: state.dryRun.graphHash !== hash } : null,
        suite: state.suite ? { ...state.suite, stale: state.suite.graphHash !== hash } : null,
        debugRun: state.debugRun ? { ...state.debugRun, stale: state.debugRun.graphHash !== hash } : null,
        hardened: state.hardened ? { ...state.hardened, stale: state.hardened.graphHash !== hash } : null,
        productionRun: state.productionRun ? { ...state.productionRun, stale: state.productionRun.graphHash !== hash } : null,
      },
      // SWIFT-T: rolling production accomplishment (world-verified) — the health metric.
      outcomeHealth: state.outcomeHealth ?? null,
      // SWIFT proactive guard: non-null when the current graph was edited away from
      // a PROVEN blueprint/hardened version → UNVERIFIED, re-verify before running.
      divergence: detectProvenDivergence(state, hash, wf.id),
      compass: compassForWorkflow({ workflowId: wf.id, graph, settings: wf.settings }),
    });
  });

  app.get('/:id/deployment', (c) => {
    const ws = getWorkspace(c);
    if (!triggerDeployments) {
      throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Workflow trigger deployment is unavailable.');
    }
    return c.json({ deployment: triggerDeployments.get(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/activate', async (c) => {
    const ws = getWorkspace(c);
    if (!triggerDeployments) {
      throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Workflow trigger deployment is unavailable.');
    }
    // SWIFT arming gate: an explicit override (audited) may arm an unhardened workflow.
    const body = (await c.req.json().catch(() => ({}))) as { override?: { ack?: string } };
    const deployment = await triggerDeployments.activate({
      workspaceId: ws.workspaceId,
      workflowId: c.req.param('id'),
      ambientId: ws.ambientId ?? null,
      userId: ws.user.id,
      ...(body.override?.ack?.trim() ? { override: { ack: String(body.override.ack) } } : {}),
    });
    emitWorkflowDeploymentChanged(deps.bus, ws.workspaceId, c.req.param('id'));
    return c.json({ deployment });
  });

  app.patch('/:id/deployment', async (c) => {
    const ws = getWorkspace(c);
    if (!triggerDeployments) {
      throw new AgentisError('LISTENER_RUNTIME_UNAVAILABLE', 'Workflow trigger deployment is unavailable.');
    }
    const body = schemas.workflowDeploymentStatusSchema.parse(await c.req.json());
    const deployment = await triggerDeployments.setStatus(
      ws.workspaceId,
      c.req.param('id'),
      body.status,
    );
    emitWorkflowDeploymentChanged(deps.bus, ws.workspaceId, c.req.param('id'));
    return c.json({ deployment });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const body = schemas.updateWorkflowSchema.parse(await c.req.json());
    if (body.spaceId) ensureWorkflowSpace(deps.db, ws.workspaceId, body.spaceId);
    const normalizedGraph = body.graph
      ? normalizeWorkflowGraph(deps.db, ws.workspaceId, body.graph as WorkflowGraph).graph
      : undefined;
    if (normalizedGraph)
      validateWorkflowGraph(normalizedGraph, { currentWorkflowId: id, strict: false });
    const nextGraph = normalizedGraph ?? (wf.graph as WorkflowGraph);
    deps.db
      .update(schema.workflows)
      .set({
        title: body.title ?? wf.title,
        description:
          body.description === undefined
            ? wf.description
            : body.description?.trim() || null,
        spaceId: body.spaceId === undefined ? wf.spaceId : body.spaceId ?? null,
        ownerAgentId: body.ownerAgentId === undefined ? wf.ownerAgentId : body.ownerAgentId ?? null,
        graph: nextGraph,
        contentHash: hashWorkflowGraph(nextGraph),
        settings: body.settings ?? (wf.settings as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflows.id, id))
      .run();
    // 10.14: keep the mirrored package in sync
    try {
      deps.packager?.mirrorWorkflow(
        { workspaceId: ws.workspaceId, ambientId: ws.ambientId ?? null, userId: ws.user.id },
        id,
      );
    } catch {
      /* best-effort mirror */
    }
    // SWIFT "warn previously": if this save edited a PROVEN workflow away from its
    // blueprint/hardened graph, tell the editor NOW — it is UNVERIFIED until it is
    // re-proven, and a proven workflow only breaks when it changes. The save still
    // succeeds (non-blocking); the warning steers to re-verify (or restore) next.
    const divergence = detectProvenDivergence(
      readBuildLoop(body.settings ?? (wf.settings as Record<string, unknown>)),
      graphContentHash(nextGraph), // MUST match how buildLoop stamps hash (semantic, not the DB row hash)
      id,
    );
    return c.json({ ok: true, ...(divergence ? { divergence } : {}) });
  });

  app.post('/:id/run', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const body = schemas.runWorkflowSchema.parse(await c.req.json().catch(() => ({})));

    // `loadWorkflow` already normalized the graph and surfaced any repairs.
    const graph = wf.graph;
    if (graph.nodes.length === 0) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Cannot run an empty workflow');
    }
    validateWorkflowGraph(graph, { currentWorkflowId: wf.id });
    const health = preflightWorkflow({
      db: deps.db,
      workspaceId: ws.workspaceId,
      workflowId: wf.id,
      graph,
      inputs: body.inputs,
      // Gate the REAL run against the EXACT input the engine will use — a missing
      // required input is blocked here with the field name instead of dead-ending
      // mid-run with a raw expression error.
      mode: 'run-gate',
    });
    if (health.status === 'blocked') {
      const first = health.issues.find((issue) => issue.severity === 'error');
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Workflow preflight failed${first ? `: ${first.nodeTitle ? `${first.nodeTitle}: ${first.message}` : first.message}${first.remediation ? ` — ${first.remediation}` : ''}` : ''}`,
      );
    }
    // Heal the stored row when the normalization actually changed something, so
    // the persisted graph matches what the engine will run (and so the next read
    // is a no-op). Skipping this left the database permanently out of sync.
    if (wf.graphRepairs.length > 0) {
      deps.db
        .update(schema.workflows)
        .set({
          graph,
          contentHash: hashWorkflowGraph(graph),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.workflows.id, wf.id))
        .run();
      try {
        deps.packager?.mirrorWorkflow(
          { workspaceId: ws.workspaceId, ambientId: ws.ambientId ?? null, userId: ws.user.id },
          wf.id,
        );
      } catch {
        /* best-effort mirror */
      }
    }

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

    // SWIFT "warn previously": this HTTP run is always a production run (self-heal
    // ON). If the graph diverges from its PROVEN blueprint/hardened version, the run
    // is proceeding UNVERIFIED — surface that with the run id so the operator can
    // re-verify (deliver) or restore rather than trust an unproven change silently.
    const divergence = detectProvenDivergence(readBuildLoop(wf.settings), graphContentHash(graph), wf.id);
    return c.json({ runId, ...(divergence ? { divergence } : {}) }, 202);
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
    const inputs =
      body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)
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
    deps.bus.publish(
      REALTIME_ROOMS.workspace(ws.workspaceId),
      REALTIME_EVENTS.NODE_TEST_COMPLETED,
      {
        workflowId: id,
        nodeId,
        ok: result.ok,
        durationMs: result.durationMs,
      },
    );
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
      .where(
        and(
          eq(schema.workflowRuns.workflowId, id),
          eq(schema.workflowRuns.workspaceId, ws.workspaceId),
        ),
      )
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(limit)
      .all();
    const triggerMap = resolveTriggerTypes(
      deps.db,
      rows.map((r) => r.triggerId),
    );
    return c.json({ runs: rows.map((r) => mapRunSummary(r, triggerMap)) });
  });

  // One compact projection for canvas node labels. This intentionally avoids
  // the old N-per-node history fan-out.
  app.get('/:id/node-activity', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const rows = deps.db.select().from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workspaceId, ws.workspaceId), eq(schema.workflowRuns.workflowId, id)))
      .orderBy(desc(schema.workflowRuns.createdAt)).limit(40).all();
    const nodes: Record<string, { status: string; startedAt?: string; completedAt?: string; durationMs?: number }> = {};
    for (const run of rows) {
      const state = run.runState as WorkflowRunState | null;
      for (const node of Object.values(state?.nodeStates ?? {})) {
        if (!node || nodes[node.nodeId]) continue;
        const startedAt = node.startedAt;
        const completedAt = node.completedAt;
        const durationMs = startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : undefined;
        nodes[node.nodeId] = { status: node.status, ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
      }
    }
    return c.json({ nodes });
  });

  /** Output history, newest first, with immutable delivery artifacts per run. */
  app.get('/:id/output', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const wf = loadWorkflow(deps.db, ws.workspaceId, id);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20), 1), 50);
    const rows = deps.db
      .select()
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.workflowId, id),
          eq(schema.workflowRuns.workspaceId, ws.workspaceId),
          inArray(schema.workflowRuns.status, ['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'COMPLETED_WITH_ERRORS']),
        ),
      )
      .orderBy(desc(schema.workflowRuns.completedAt), desc(schema.workflowRuns.createdAt))
      .limit(limit + 1)
      .all();
    if (rows.length === 0) return c.json({ lastRun: null, outputs: [], runs: [], hasMore: false });

    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const triggerMap = resolveTriggerTypes(deps.db, visibleRows.map((run) => run.triggerId));
    const runs = visibleRows.map((run) => {
      const graph = (run.graphSnapshot as WorkflowGraph | null) ??
        (wf.graph as WorkflowGraph) ?? {
          version: 1,
          nodes: [],
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        };
      const state = run.runState as WorkflowRunState;
      return {
        run: mapRunSummary(run, triggerMap),
        outputs: buildFinalNodeOutputs(graph, state, {
          runId: run.id,
          startedAt: run.startedAt ?? run.createdAt,
          triggeredBy: triggerMap.get(run.triggerId ?? '') ?? 'manual',
        }),
      };
    });
    return c.json({
      lastRun: runs[0]!.run,
      outputs: runs[0]!.outputs,
      runs,
      hasMore,
    });
  });

  app.delete('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    try {
      const wf = loadWorkflow(deps.db, ws.workspaceId, id);
      deletedWorkflowsCache.set(id, wf);
      deps.db
        .delete(schema.workflows)
        .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, ws.workspaceId)))
        .run();

      try {
        deps.packager?.mirrorWorkflow(
          {
            workspaceId: ws.workspaceId,
            ambientId: ws.ambientId ?? null,
            userId: ws.user.id,
          },
          id,
        );
      } catch {
        /* best-effort */
      }

      deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.WORKFLOW_DELETED, {
        workflowId: id,
        workspaceId: ws.workspaceId,
      });

      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 404);
    }
  });

  app.post('/:id/restore', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const cached = deletedWorkflowsCache.get(id);
    if (!cached) {
      return c.json({ error: 'Workflow not found in restore cache' }, 404);
    }
    deps.db
      .insert(schema.workflows)
      .values({
        id: cached.id,
        workspaceId: cached.workspaceId,
        ambientId: cached.ambientId,
        userId: cached.userId,
        registryEntryId: cached.registryEntryId,
        registryVersion: cached.registryVersion,
        title: cached.title,
        description: cached.description,
        graph: cached.graph,
        settings: cached.settings,
        isFromRegistry: cached.isFromRegistry,
        maxConcurrentRuns: cached.maxConcurrentRuns,
        budgetCents: cached.budgetCents,
        concurrencyOverflow: cached.concurrencyOverflow,
        tags: cached.tags,
        createdAt: cached.createdAt,
        updatedAt: new Date().toISOString(),
      })
      .run();

    try {
      deps.packager?.mirrorWorkflow(
        {
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId ?? null,
          userId: ws.user.id,
        },
        id,
      );
    } catch {
      /* best-effort */
    }

    deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.WORKFLOW_CREATED, {
      workflowId: id,
      workspaceId: ws.workspaceId,
    });

    deletedWorkflowsCache.delete(id);
    return c.json({ ok: true });
  });

  return app;
}

type WorkflowRow = typeof schema.workflows.$inferSelect;
type WorkflowRunRow = typeof schema.workflowRuns.$inferSelect;

function loadLatestRunsByWorkflow(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflowIds: string[],
): Map<string, WorkflowRunRow> {
  if (workflowIds.length === 0) return new Map();
  // Runs carry very large `runState`/`graphSnapshot` JSON blobs (multi-MB each).
  // Selecting full rows for EVERY run of every workflow — just to keep the latest
  // per workflow — reads hundreds of MB per request (seconds of latency on a big
  // workspace). Instead: a slim scan (id/workflowId/createdAt only) picks the
  // latest run id per workflow, then we hydrate full rows for just those (~one
  // per workflow), so blob reads scale with #workflows, not #runs.
  const slim = db
    .select({
      id: schema.workflowRuns.id,
      workflowId: schema.workflowRuns.workflowId,
    })
    .from(schema.workflowRuns)
    .where(
      and(
        eq(schema.workflowRuns.workspaceId, workspaceId),
        inArray(schema.workflowRuns.workflowId, workflowIds),
      ),
    )
    .orderBy(desc(schema.workflowRuns.createdAt))
    .all();
  const latestIdByWorkflow = new Map<string, string>();
  for (const row of slim) {
    if (!row.workflowId || latestIdByWorkflow.has(row.workflowId)) continue;
    latestIdByWorkflow.set(row.workflowId, row.id);
  }
  const latestIds = [...latestIdByWorkflow.values()];
  if (latestIds.length === 0) return new Map();
  const fullRows = db
    .select()
    .from(schema.workflowRuns)
    .where(inArray(schema.workflowRuns.id, latestIds))
    .all();
  const latest = new Map<string, WorkflowRunRow>();
  for (const row of fullRows) {
    if (!row.workflowId) continue;
    latest.set(row.workflowId, row);
  }
  return latest;
}

function presentWorkflowListItem(
  workflow: WorkflowRow,
  latestRun: WorkflowRunRow | undefined,
  triggerMap: Map<string, string>,
) {
  const latest = latestRun ? mapRunSummary(latestRun, triggerMap) : null;
  const status = latestRun ? workflowStatusFromRun(latestRun, latest?.status) : 'idle';
  return {
    ...workflow,
    triggerType: inferWorkflowTriggerType(workflow.graph as WorkflowGraph),
    status,
    lastRun: latest,
    activeRunStep: latestRun && isActiveRunStatus(latestRun.status)
      ? activeRunStep(workflow, latestRun)
      : undefined,
  };
}

function workflowStatusFromRun(
  run: WorkflowRunRow,
  mappedStatus: ReturnType<typeof mapRunSummary>['status'] | undefined,
): 'running' | 'paused' | 'waiting' | 'failed' | 'idle' | 'pending' {
  if (mappedStatus === 'paused') return 'paused';
  if (mappedStatus === 'waiting') return 'waiting';
  if (run.status === 'RUNNING') return 'running';
  if (run.status === 'CREATED' || run.status === 'PLANNING') return 'pending';
  if (mappedStatus === 'failed') return 'failed';
  return 'idle';
}

function isActiveRunStatus(status: string): boolean {
  return status === 'RUNNING' || status === 'WAITING' || status === 'CREATED' || status === 'PLANNING';
}

function activeRunStep(workflow: WorkflowRow, run: WorkflowRunRow): { current: number; total: number; durationMs?: number } | undefined {
  const graph = ((run.graphSnapshot as WorkflowGraph | null) ?? (workflow.graph as WorkflowGraph)) ?? null;
  const nodes = graph?.nodes ?? [];
  if (nodes.length === 0) return undefined;
  const state = run.runState as WorkflowRunState;
  const currentNodeId = currentRunNodeId(state);
  const failedCount = state.failedNodeIds?.length ?? 0;
  const current = Math.min(nodes.length, (state.completedNodeIds?.length ?? 0) + failedCount + (currentNodeId ? 1 : 0));
  const durationMs = run.startedAt
    ? Math.max(0, Date.now() - new Date(run.startedAt).getTime())
    : undefined;
  return {
    current: Math.max(1, current),
    total: nodes.length,
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
  };
}

function currentRunNodeId(state: WorkflowRunState): string | null {
  const active = Object.keys(state.activeExecutions ?? {})[0];
  if (active) return active;
  const queued = state.readyQueue?.[0]?.nodeId;
  if (queued) return queued;
  const running = Object.values(state.nodeStates ?? {}).find((node) => node.status === 'RUNNING');
  if (running) return running.nodeId;
  const waiting = Object.values(state.nodeStates ?? {}).find((node) => node.status === 'WAITING');
  return waiting?.nodeId ?? null;
}

function inferWorkflowTriggerType(graph: WorkflowGraph): 'manual' | 'cron' | 'webhook' | 'event' {
  const trigger = graph.nodes.find((node) => node.config.kind === 'trigger');
  const raw = trigger?.config.kind === 'trigger' ? String(trigger.config.triggerType ?? '') : '';
  if (raw === 'cron') return 'cron';
  if (raw === 'webhook') return 'webhook';
  if (raw === 'persistent_listener' || raw === 'event') return 'event';
  return 'manual';
}

/** CREATED/PLANNING collapse to "pending"; WAITING stays distinct for paused/waiting UX. */
function mapRunStatus(
  status: string,
): 'running' | 'completed' | 'completed_with_violation' | 'failed' | 'pending' | 'cancelled' | 'waiting' {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'COMPLETED_WITH_CONTRACT_VIOLATION':
      return 'completed_with_violation';
    case 'COMPLETED_WITH_ERRORS':
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
    case 'RUNNING':
      return 'running';
    case 'WAITING':
      return 'waiting';
    default:
      return 'pending';
  }
}

/** Build a triggerId → triggerType lookup for a batch of runs. */
function resolveTriggerTypes(
  db: AgentisSqliteDb,
  triggerIds: Array<string | null>,
): Map<string, string> {
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
  const runState = run.runState as ({ contractViolations?: string[] } & Partial<WorkflowRunState>) | null;
  const paused = Object.values(runState?.nodeStates ?? {}).some((node) => node?.status === 'WAITING' && node?.blockedReason);
  return {
    id: run.id,
    status: paused ? 'paused' : mapRunStatus(run.status),
    startedAt,
    finishedAt,
    durationMs,
    triggeredBy,
    isReplay: run.isReplay,
    contractViolations: Array.isArray(runState?.contractViolations)
      ? runState!.contractViolations
      : undefined,
  };
}

interface FinalNodeOutput {
  nodeId: string;
  nodeTitle: string;
  kind: string;
  value: unknown;
  /** Viewer hint for the Output Surface (Layer 6). Set by `return_output` nodes. */
  renderAs?: 'html' | 'markdown' | 'table' | 'json' | 'text';
  role?: 'delivery' | 'declared';
  delivery?: IntegrationDeliveryReceipt;
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
function buildFinalNodeOutputs(
  graph: WorkflowGraph,
  state: WorkflowRunState,
  run?: { runId: string; startedAt?: string | null; triggeredBy?: string },
): FinalNodeOutput[] {
  const completedIds = state.completedNodeIds ?? [];
  if (completedIds.length === 0) return [];
  const hasOutgoing = new Set((graph.edges ?? []).map((e) => e.source));
  const nodeById = new Map((graph.nodes ?? []).map((n) => [n.id, n] as const));

  const completed = completedIds
    .map((nid) => ({ nid, st: state.nodeStates?.[nid] }))
    .filter((x): x is CompletedNodeOutput => Boolean(x.st));
  if (completed.length === 0) return [];

  const completedById = new Map(completed.map((item) => [item.nid, item] as const));
  const deliveryOutputs = buildDeliveryOutputs(graph, state, completedById, run);
  const deliveryNodeIds = new Set(deliveryOutputs.map((output) => output.nodeId));
  const declaredOutputNodes = (graph.nodes ?? []).filter((node) => {
    const cfg = node.config as { isOutput?: unknown; kind?: string };
    // `return_output` nodes are always part of the output surface; the legacy
    // `isOutput: true` flag on any node remains supported.
    return cfg?.isOutput === true || cfg?.kind === 'return_output';
  });
  if (declaredOutputNodes.length > 0) {
    const declared = declaredOutputNodes
      .filter((node) => !deliveryNodeIds.has(node.id))
      .map((node) => completedById.get(node.id))
      .filter((item): item is CompletedNodeOutput => Boolean(item))
      .map((item) => ({ ...formatFinalNodeOutput(item.nid, item.st, nodeById), role: 'declared' as const }));
    return [...deliveryOutputs, ...declared];
  }

  const sinks = completed
    .filter((item) => !hasOutgoing.has(item.nid))
    .sort((a, b) => {
      const ta = a.st.completedAt ? new Date(a.st.completedAt).getTime() : 0;
      const tb = b.st.completedAt ? new Date(b.st.completedAt).getTime() : 0;
      return tb - ta;
    });

  return [
    ...deliveryOutputs,
    ...sinks
      .filter((item) => !deliveryNodeIds.has(item.nid))
      .map((item) => formatFinalNodeOutput(item.nid, item.st, nodeById)),
  ];
}

function buildDeliveryOutputs(
  graph: WorkflowGraph,
  state: WorkflowRunState,
  completedById: Map<string, CompletedNodeOutput>,
  run?: { runId: string; startedAt?: string | null; triggeredBy?: string },
): FinalNodeOutput[] {
  const nodeOutputs = Object.fromEntries(
    Object.entries(state.nodeStates ?? {})
      .filter(([, nodeState]) => nodeState?.outputData)
      .map(([nodeId, nodeState]) => [nodeId, nodeState!.outputData!]),
  );
  const incoming = new Set((graph.edges ?? []).map((edge) => edge.target));
  const root = (graph.nodes ?? []).find((node) => !incoming.has(node.id));
  const triggerInputs = root ? state.nodeStates?.[root.id]?.inputData ?? {} : {};
  const tctx = buildTemplateContext({
    triggerInputs,
    nodeOutputs,
    scratchpad: {},
    store: {},
    run: run ? {
      id: run.runId,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.triggeredBy ? { triggeredBy: run.triggeredBy } : {}),
    } : undefined,
  });

  return (graph.nodes ?? []).flatMap((node) => {
    const completed = completedById.get(node.id);
    if (!completed) return [];
    const cfg = node.config as {
      kind?: string;
      integrationId?: string;
      operationId?: string;
      inputs?: Record<string, unknown>;
    };
    if (cfg.kind !== 'integration' || !cfg.integrationId || !cfg.operationId) return [];
    const persisted = completed.st.deliveryReceipt;
    const reconstructed = persisted ?? buildIntegrationDeliveryReceipt(
      cfg.integrationId,
      cfg.operationId,
      resolveTemplateDeep(cfg.inputs ?? {}, tctx),
    );
    if (!reconstructed) return [];
    return [{
      nodeId: node.id,
      nodeTitle: reconstructed.subject ?? node.title,
      kind: 'delivery',
      value: reconstructed.content,
      renderAs: reconstructed.contentType,
      role: 'delivery',
      delivery: reconstructed,
    }];
  });
}

function formatFinalNodeOutput(
  nodeId: string,
  nodeState: CompletedNodeOutput['st'],
  nodeById: Map<string, WorkflowGraph['nodes'][number]>,
): FinalNodeOutput {
  const node = nodeById.get(nodeId);
  const cfg =
    (node?.config as { kind?: string; renderAs?: FinalNodeOutput['renderAs'] } | undefined) ??
    undefined;
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
  // Normalize on read so every consumer sees an engine-valid graph. Surface the
  // repairs alongside the graph (instead of discarding them) so a caller that
  // wants to heal the *stored* row — e.g. the run path — can persist the fix.
  // Without this, the stored graph drifts permanently from what actually runs:
  // each read re-normalizes in memory but the database keeps the stale draft.
  const { graph, repairs } = normalizeWorkflowGraph(db, workspaceId, wf.graph as WorkflowGraph);
  return { ...wf, graph, graphRepairs: repairs };
}

function ensureWorkflowSpace(db: AgentisSqliteDb, workspaceId: string, spaceId: string) {
  const space = db
    .select({ id: schema.spaces.id })
    .from(schema.spaces)
    .where(and(eq(schema.spaces.id, spaceId), eq(schema.spaces.workspaceId, workspaceId)))
    .get();
  if (!space) throw new AgentisError('RESOURCE_NOT_FOUND', `space ${spaceId} not found`);
}

/**
 * Fan out a workflow arming change to the workspace room so /home's Active
 * section and any live indicator refresh — arming is not a run, so it rides the
 * WORKFLOW_UPDATED event rather than the RUN_* stream.
 */
function emitWorkflowDeploymentChanged(bus: EventBus, workspaceId: string, workflowId: string) {
  bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.WORKFLOW_UPDATED, {
    workflowId,
    reason: 'deployment',
  });
}
