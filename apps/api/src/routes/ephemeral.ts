import { Hono } from 'hono';
import { z } from 'zod';
import { schemas, type WorkflowGraph } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { promoteEphemeralWorkflow, startEphemeralWorkflow } from '../services/ephemeralWorkflowService.js';

const runSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  graph: schemas.workflowGraphSchema,
  inputs: z.record(z.string(), z.unknown()).default({}),
  maxDurationMs: z.number().int().positive().max(300_000).optional(),
});

const promoteSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(8000).nullable().optional(),
});

export function buildEphemeralRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  engine: WorkflowEngine;
  bus: EventBus;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.post('/run', async (c) => {
    const ws = getWorkspace(c);
    const body = runSchema.parse(await c.req.json());
    const result = await startEphemeralWorkflow(deps, {
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      title: body.title,
      graph: body.graph as WorkflowGraph,
      inputs: body.inputs,
      maxDurationMs: body.maxDurationMs,
    });
    return c.json(result, 202);
  });

  app.post('/:runId/promote', async (c) => {
    const ws = getWorkspace(c);
    const body = promoteSchema.parse(await c.req.json().catch(() => ({})));
    const { workflow } = promoteEphemeralWorkflow(deps, {
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      runId: c.req.param('runId'),
      title: body.title,
      description: body.description,
    });
    return c.json({ workflow }, 201);
  });

  return app;
}
