import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthService } from '../services/auth.js';
import type { McpInteropService } from '../services/mcpInterop.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const createServerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  direction: z.enum(['consume', 'expose']),
  url: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
});

const addToolSchema = z.object({
  deploymentId: z.string().uuid(),
  toolName: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  description: z.string().trim().max(1000).optional(),
  inputSchema: z.unknown().optional(),
});

export function buildMcpRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; mcp: McpInteropService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/servers', (c) => {
    const ws = getWorkspace(c);
    return c.json({ servers: deps.mcp.listServers(ws.workspaceId) });
  });

  app.post('/servers', async (c) => {
    const ws = getWorkspace(c);
    const body = createServerSchema.parse(await c.req.json());
    const result = await deps.mcp.createServer({
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      name: body.name,
      direction: body.direction,
      url: body.url,
      apiKey: body.apiKey,
    });
    return c.json(result, 201);
  });

  app.post('/servers/:id/tools', async (c) => {
    const ws = getWorkspace(c);
    const body = addToolSchema.parse(await c.req.json());
    const tool = deps.mcp.addExposedTool({
      workspaceId: ws.workspaceId,
      serverId: c.req.param('id'),
      deploymentId: body.deploymentId,
      toolName: body.toolName,
      description: body.description,
      inputSchema: body.inputSchema,
    });
    return c.json({ tool }, 201);
  });

  app.get('/servers/:id/tools', (c) => {
    return c.json({ tools: deps.mcp.listExposedTools(c.req.param('id')) });
  });

  app.get('/servers/:id/catalog', async (c) => {
    const ws = getWorkspace(c);
    const [catalog] = await deps.mcp.listRemoteTools(ws.workspaceId, [c.req.param('id')]);
    return c.json({ catalog: catalog ?? null });
  });

  return app;
}

function bearerOrHeader(c: { req: { header(name: string): string | undefined } }) {
  const explicit = c.req.header('x-mcp-api-key');
  if (explicit) return explicit;
  const auth = c.req.header('authorization');
  return auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7) : undefined;
}

export function buildMcpProtocolRoutes(deps: { mcp: McpInteropService }) {
  const app = new Hono();

  app.get('/:serverId', (c) => {
    const response = deps.mcp.handleManifest(c.req.param('serverId'), bearerOrHeader(c) ?? null);
    return c.json(response);
  });

  app.post('/:serverId', async (c) => {
    const request = z
      .object({
        jsonrpc: z.string().optional(),
        id: z.union([z.string(), z.number(), z.null()]).optional(),
        method: z.string().min(1),
        params: z.unknown().optional(),
      })
      .parse(await c.req.json());
    const response = await deps.mcp.handleProtocol(c.req.param('serverId'), bearerOrHeader(c) ?? null, request);
    return c.json(response);
  });

  return app;
}
