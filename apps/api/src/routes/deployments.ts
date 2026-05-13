import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthService } from '../services/auth.js';
import type { WorkflowDeploymentService } from '../services/workflowDeployments.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const createDeploymentSchema = z.object({
  workflowId: z.string().uuid(),
  name: z.string().trim().min(1).max(255).optional(),
  mode: z.enum(['sync', 'async']).default('sync').optional(),
  publicAccess: z.boolean().default(false).optional(),
  chatEnabled: z.boolean().default(false).optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
});

export function buildDeploymentRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; deployments: WorkflowDeploymentService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ deployments: deps.deployments.list(ws.workspaceId) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createDeploymentSchema.parse(await c.req.json());
    const result = deps.deployments.create({
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      workflowId: body.workflowId,
      name: body.name,
      mode: body.mode,
      publicAccess: body.publicAccess,
      chatEnabled: body.chatEnabled,
      inputSchema: body.inputSchema,
      outputSchema: body.outputSchema,
    });
    return c.json(result, 201);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    return c.json({ deployment: deps.deployments.get(ws.workspaceId, c.req.param('id')) });
  });

  return app;
}

function bearerOrHeader(c: { req: { header(name: string): string | undefined } }) {
  const explicit = c.req.header('x-agentis-api-key');
  if (explicit) return explicit;
  const auth = c.req.header('authorization');
  return auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7) : undefined;
}

export function buildPublicDeploymentRoutes(deps: { deployments: WorkflowDeploymentService }) {
  const app = new Hono();

  app.get('/:id', (c) => c.json(deps.deployments.publicConfig(c.req.param('id'))));

  app.post('/:id', async (c) => {
    const body = z
      .object({
        inputs: z.record(z.string(), z.unknown()).default({}).optional(),
        message: z.string().optional(),
        conversationId: z.string().optional(),
        syncTimeoutMs: z.number().int().min(0).max(10_000).optional(),
        source: z.enum(['api', 'chat']).default('api').optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const inputs = {
      ...(body.inputs ?? {}),
      ...(body.message !== undefined ? { message: body.message, conversationId: body.conversationId } : {}),
    };
    const result = await deps.deployments.execute({
      deploymentId: c.req.param('id'),
      inputs,
      token: bearerOrHeader(c),
      syncTimeoutMs: body.syncTimeoutMs,
      source: body.source,
    });
    return c.json(result, result.completed ? 200 : 202);
  });

  return app;
}
