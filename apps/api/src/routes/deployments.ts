/**
 * /v1/deployments — Workflow and app deployment registry.
 *
 * AGENT-FIRST-ARCHITECTURE.md Plane 7. Provides a stable URL surface for
 * deploying workflows and apps: each deployment is addressed by a slug
 * unique within a workspace and produces a durable run endpoint.
 *
 * Routes:
 *   GET    /                → list all deployments for workspace
 *   POST   /                → register a new deployment
 *   GET    /:slug           → inspect a single deployment + workflow graph
 *   DELETE /:slug           → unregister
 *   POST   /:slug/run       → trigger a run through this deployment
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { AgentisError, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { eq, and } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowDeployments } from '../services/workflowDeployments.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { DeploymentSpec } from '../services/workflowDeployments.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { buildInitialRunState } from '../engine/initialRunState.js';

export function buildDeploymentRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  deployments: WorkflowDeployments;
  engine: WorkflowEngine;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  /**
   * GET /v1/deployments
   * List all deployments registered in this workspace.
   */
  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const specs = deps.deployments.list(ws.workspaceId);
    return c.json({ count: specs.length, deployments: specs });
  });

  /**
   * POST /v1/deployments
   * Register a new deployment (in-memory; V1 does not persist to DB).
   *
   * Body: DeploymentSpec (kind, slug, workflowId | workflowIds, ...)
   */
  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json()) as DeploymentSpec;

    if (!body.slug) throw new AgentisError('VALIDATION_FAILED', 'slug is required');
    if (body.kind === 'workflow' && !body.workflowId) {
      throw new AgentisError('VALIDATION_FAILED', 'workflowId is required for workflow deployments');
    }
    if (body.kind === 'app' && (!body.workflowIds || body.workflowIds.length === 0)) {
      throw new AgentisError('VALIDATION_FAILED', 'workflowIds is required for app deployments');
    }

    deps.deployments.register(ws.workspaceId, body);
    const lookup = deps.deployments.lookup(ws.workspaceId, body.slug);
    return c.json({ deployment: lookup }, 201);
  });

  /**
   * GET /v1/deployments/:slug
   * Inspect a deployment including the resolved workflow graph.
   */
  app.get('/:slug', (c) => {
    const ws = getWorkspace(c);
    const slug = c.req.param('slug');
    const lookup = deps.deployments.lookup(ws.workspaceId, slug);
    if (!lookup) throw new AgentisError('RESOURCE_NOT_FOUND', `deployment '${slug}' not found`);
    return c.json({ deployment: lookup });
  });

  /**
   * DELETE /v1/deployments/:slug
   * Unregister a deployment (in-memory only; V1).
   */
  app.delete('/:slug', (c) => {
    const ws = getWorkspace(c);
    const slug = c.req.param('slug');
    // Confirm it exists first.
    const existing = deps.deployments.lookup(ws.workspaceId, slug);
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `deployment '${slug}' not found`);
    deps.deployments.unregister(ws.workspaceId, slug);
    return c.json({ slug, unregistered: true });
  });

  /**
   * POST /v1/deployments/:slug/run
   *
   * Trigger a workflow run through the deployment. The deployment's contract
   * (if any) is applied to the run. The entrypoint workflow is resolved from
   * the deployment spec.
   *
   * Body: { inputs?: Record<string, unknown> }
   */
  app.post('/:slug/run', async (c) => {
    const ws = getWorkspace(c);
    const slug = c.req.param('slug');

    // Resolve the deployment.
    const lookup = deps.deployments.lookup(ws.workspaceId, slug);
    if (!lookup) throw new AgentisError('RESOURCE_NOT_FOUND', `deployment '${slug}' not found`);

    const workflowId = deps.deployments.resolveWorkflowId(ws.workspaceId, slug);

    // Load the workflow graph from DB.
    const wf = deps.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, ws.workspaceId)))
      .get();
    if (!wf) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `workflow '${workflowId}' not found`);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      inputs?: Record<string, unknown>;
    };
    const inputs = body.inputs ?? {};

    // Create the run row.
    const runId = randomUUID();
    const now = new Date().toISOString();
    const graph = wf.graph as WorkflowGraph;
    const initialState = buildInitialRunState({
      runId,
      workflowId,
      graph,
      inputs,
    });

    deps.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId ?? null,
      workflowId,
      userId: ws.user.id,
      triggerId: null,
      status: 'CREATED',
      replanCount: 0,
      runState: initialState as unknown as object,
      createdAt: now,
      updatedAt: now,
    }).run();

    // Start the engine run.
    const handle = await deps.engine.startRun({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId ?? null,
      workflowId,
      userId: ws.user.id,
      triggerId: null,
      inputs,
      initialState,
      graph,
    });

    return c.json({ runId: handle.runId, workflowId: handle.workflowId, slug }, 202);
  });

  return app;
}
