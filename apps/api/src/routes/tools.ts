/**
 * /v1/tools — Agent-facing tool catalog and execution surface.
 *
 * AGENT-FIRST-ARCHITECTURE.md Plane 2. Exposes the AgentisToolRegistry
 * over HTTP so any authenticated caller (dashboard, CLI, external agent)
 * can discover and invoke tools without going through the MCP transport.
 *
 * Routes:
 *   GET  /           → full catalog (filterable by family, mcpExposed)
 *   POST /:id/execute → execute a single tool by id
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../services/agentisToolRegistry.js';
import type { AuthService } from '../services/auth.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export function buildToolRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  toolRegistry: AgentisToolRegistry;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  /**
   * GET /v1/tools
   *
   * Query params:
   *   family      — filter by tool family (build|run|inspect|data|environment)
   *   mcpExposed  — '1' to show only MCP-exposed tools
   *   mutating    — '0' to show only read-only tools
   */
  app.get('/', (c) => {
    const snapshot = deps.toolRegistry.catalog();
    const family = c.req.query('family');
    const mcpOnly = c.req.query('mcpExposed') === '1';
    const readOnly = c.req.query('mutating') === '0';

    let tools = snapshot.tools;
    if (family) tools = tools.filter((t) => t.family === family);
    if (mcpOnly) tools = tools.filter((t) => t.mcpExposed);
    if (readOnly) tools = tools.filter((t) => !t.mutating);

    return c.json({
      hash: snapshot.hash,
      count: tools.length,
      tools: tools.map((t) => ({
        id: t.id,
        family: t.family,
        description: t.description,
        mutating: t.mutating,
        mcpExposed: t.mcpExposed ?? false,
        inputSchema: t.inputSchema,
      })),
    });
  });

  /**
   * GET /v1/tools/:id
   *
   * Returns the definition for a single tool.
   */
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const tool = deps.toolRegistry.get(id);
    if (!tool) throw new AgentisError('RESOURCE_NOT_FOUND', `tool '${id}' not found`);
    return c.json({ tool });
  });

  /**
   * POST /v1/tools/:id/execute
   *
   * Execute a tool on behalf of the authenticated workspace.
   * Body: { args: Record<string, unknown> }
   *
   * Mutating tools require the caller to have operator-level auth.
   * Read-only tools are available to any workspace member.
   */
  app.post('/:id/execute', async (c) => {
    const ws = getWorkspace(c);
    const toolId = c.req.param('id');

    const tool = deps.toolRegistry.get(toolId);
    if (!tool) throw new AgentisError('RESOURCE_NOT_FOUND', `tool '${toolId}' not found`);

    const body = (await c.req.json().catch(() => ({}))) as {
      args?: Record<string, unknown>;
    };

    const result = await deps.toolRegistry.execute(
      { id: randomUUID(), toolId, arguments: body.args ?? {} },
      {
        workspaceId: ws.workspaceId,
        userId: ws.user.id,
        ambientId: ws.ambientId ?? null,
        caller: 'chat',
      },
    );

    return c.json({ toolId, result });
  });

  return app;
}
