/**
 * External MCP servers — Agentis as an MCP consumer (Pillar 5, consume half).
 *
 *   GET    /v1/mcp-servers                 → list configured servers
 *   POST   /v1/mcp-servers                 → register { name, url, headers? }
 *   DELETE /v1/mcp-servers/:id             → remove
 *   GET    /v1/mcp-servers/:id/tools       → live tools/list from the server
 *   POST   /v1/mcp-servers/:id/call        → { tool, arguments } → tools/call
 *
 * Server configs are persisted per workspace in `workspace_kv` under a single
 * `mcp:servers` key — no new table. The live calls go through `McpClient`,
 * which SSRF-guards every outbound URL.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { AgentisError, AGENT_AFFORDANCES, type AgentAffordance } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { McpClient } from '../services/mcpClient.js';
import { loadMcpServers, saveMcpServers, type McpServerConfig } from '../services/mcpServerStore.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export interface McpServersRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  /** Mirror the engine's network policy for outbound MCP calls. */
  allowPrivateNetwork?: boolean;
}

export function buildMcpServerRoutes(deps: McpServersRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ servers: loadMcpServers(deps.db, ws.workspaceId).map(redact) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; url?: unknown; headers?: unknown; affordance?: unknown; allowPrivateNetwork?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!name) throw new AgentisError('VALIDATION_FAILED', 'name is required');
    if (!url) throw new AgentisError('VALIDATION_FAILED', 'url is required');
    const headers = sanitizeHeaders(body.headers);
    const servers = loadMcpServers(deps.db, ws.workspaceId);
    if (servers.some((s) => s.name === name)) {
      throw new AgentisError('RESOURCE_CONFLICT', `an MCP server named '${name}' already exists`);
    }
    const server: McpServerConfig = { id: randomUUID(), name, url, createdAt: new Date().toISOString() };
    if (headers) server.headers = headers;
    if (isAffordance(body.affordance)) server.affordance = body.affordance;
    if (body.allowPrivateNetwork === true) server.allowPrivateNetwork = true;
    saveMcpServers(deps.db, ws.workspaceId, [...servers, server]);
    return c.json({ server: redact(server) }, 201);
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const servers = loadMcpServers(deps.db, ws.workspaceId);
    if (!servers.some((s) => s.id === id)) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'mcp server not found' } }, 404);
    }
    saveMcpServers(deps.db, ws.workspaceId, servers.filter((s) => s.id !== id));
    return c.json({ ok: true });
  });

  app.get('/:id/tools', async (c) => {
    const ws = getWorkspace(c);
    const server = loadMcpServers(deps.db, ws.workspaceId).find((s) => s.id === c.req.param('id'));
    if (!server) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'mcp server not found' } }, 404);
    const client = new McpClient(server.url, server.headers ?? {}, { allowPrivateNetwork: server.allowPrivateNetwork ?? deps.allowPrivateNetwork });
    const tools = await client.listTools();
    return c.json({ serverId: server.id, tools });
  });

  app.post('/:id/call', async (c) => {
    const ws = getWorkspace(c);
    const server = loadMcpServers(deps.db, ws.workspaceId).find((s) => s.id === c.req.param('id'));
    if (!server) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'mcp server not found' } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { tool?: unknown; arguments?: unknown };
    const tool = typeof body.tool === 'string' ? body.tool : '';
    if (!tool) throw new AgentisError('VALIDATION_FAILED', 'tool is required');
    const args = body.arguments && typeof body.arguments === 'object' ? body.arguments as Record<string, unknown> : {};
    const client = new McpClient(server.url, server.headers ?? {}, { allowPrivateNetwork: server.allowPrivateNetwork ?? deps.allowPrivateNetwork });
    const result = await client.callTool(tool, args);
    return c.json(result);
  });

  return app;
}

/** Never return raw header values (they may carry secrets). */
function redact(server: McpServerConfig): Omit<McpServerConfig, 'headers'> & { headerKeys: string[] } {
  const { headers, ...rest } = server;
  return { ...rest, headerKeys: headers ? Object.keys(headers) : [] };
}

function isAffordance(value: unknown): value is AgentAffordance {
  return typeof value === 'string' && (AGENT_AFFORDANCES as readonly string[]).includes(value);
}

function sanitizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}
