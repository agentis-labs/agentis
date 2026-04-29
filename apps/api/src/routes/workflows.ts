/**
 * /v1/workflows — list/get/create/update + run trigger.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, schemas, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { validateWorkflowGraph } from '../engine/validateGraph.js';
import { buildInitialRunState } from '../engine/initialRunState.js';

export function buildWorkflowRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  bus: EventBus;
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

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = schemas.createWorkflowSchema.parse({
      ...(await c.req.json()),
      workspaceId: ws.workspaceId,
    });
    const graph: WorkflowGraph = body.graph ?? {
      version: 1,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    if (graph.nodes.length > 0) validateWorkflowGraph(graph);

    const id = randomUUID();
    deps.db
      .insert(schema.workflows)
      .values({
        id,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId ?? body.ambientId ?? null,
        userId: ws.user.id,
        title: body.title,
        summary: body.summary ?? null,
        graph,
        settings: body.settings,
      })
      .run();
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
    if (body.graph) validateWorkflowGraph(body.graph);
    deps.db
      .update(schema.workflows)
      .set({
        title: body.title ?? wf.title,
        summary: body.summary === undefined ? wf.summary : body.summary,
        graph: body.graph ?? (wf.graph as WorkflowGraph),
        settings: body.settings ?? (wf.settings as Record<string, unknown>),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflows.id, id))
      .run();
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
    validateWorkflowGraph(graph);

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

  return app;
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
