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
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { McpClient } from '../services/mcpClient.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const KV_KEY = 'mcp:servers';

interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
  createdAt: string;
}

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
    return c.json({ servers: loadServers(deps.db, ws.workspaceId).map(redact) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; url?: unknown; headers?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!name) throw new AgentisError('VALIDATION_FAILED', 'name is required');
    if (!url) throw new AgentisError('VALIDATION_FAILED', 'url is required');
    const headers = sanitizeHeaders(body.headers);
    const servers = loadServers(deps.db, ws.workspaceId);
    if (servers.some((s) => s.name === name)) {
      throw new AgentisError('RESOURCE_CONFLICT', `an MCP server named '${name}' already exists`);
    }
    const server: McpServerConfig = { id: randomUUID(), name, url, headers, createdAt: new Date().toISOString() };
    saveServers(deps.db, ws.workspaceId, [...servers, server]);
    return c.json({ server: redact(server) }, 201);
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const servers = loadServers(deps.db, ws.workspaceId);
    if (!servers.some((s) => s.id === id)) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'mcp server not found' } }, 404);
    }
    saveServers(deps.db, ws.workspaceId, servers.filter((s) => s.id !== id));
    return c.json({ ok: true });
  });

  app.get('/:id/tools', async (c) => {
    const ws = getWorkspace(c);
    const server = loadServers(deps.db, ws.workspaceId).find((s) => s.id === c.req.param('id'));
    if (!server) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'mcp server not found' } }, 404);
    const client = new McpClient(server.url, server.headers ?? {}, { allowPrivateNetwork: deps.allowPrivateNetwork });
    const tools = await client.listTools();
    return c.json({ serverId: server.id, tools });
  });

  app.post('/:id/call', async (c) => {
    const ws = getWorkspace(c);
    const server = loadServers(deps.db, ws.workspaceId).find((s) => s.id === c.req.param('id'));
    if (!server) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'mcp server not found' } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { tool?: unknown; arguments?: unknown };
    const tool = typeof body.tool === 'string' ? body.tool : '';
    if (!tool) throw new AgentisError('VALIDATION_FAILED', 'tool is required');
    const args = body.arguments && typeof body.arguments === 'object' ? body.arguments as Record<string, unknown> : {};
    const client = new McpClient(server.url, server.headers ?? {}, { allowPrivateNetwork: deps.allowPrivateNetwork });
    const result = await client.callTool(tool, args);
    return c.json(result);
  });

  return app;
}

// ─── persistence helpers (workspace_kv) ─────────────────────────────────────

function loadServers(db: AgentisSqliteDb, workspaceId: string): McpServerConfig[] {
  const row = db.select().from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, KV_KEY)))
    .get();
  const value = row?.value;
  return Array.isArray(value) ? (value as McpServerConfig[]) : [];
}

function saveServers(db: AgentisSqliteDb, workspaceId: string, servers: McpServerConfig[]): void {
  const now = new Date().toISOString();
  const existing = db.select({ id: schema.workspaceKv.id }).from(schema.workspaceKv)
    .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, KV_KEY)))
    .get();
  if (existing) {
    db.update(schema.workspaceKv).set({ value: servers, updatedAt: now }).where(eq(schema.workspaceKv.id, existing.id)).run();
  } else {
    db.insert(schema.workspaceKv).values({ id: randomUUID(), workspaceId, key: KV_KEY, value: servers, createdAt: now, updatedAt: now }).run();
  }
}

/** Never return raw header values (they may carry secrets). */
function redact(server: McpServerConfig): Omit<McpServerConfig, 'headers'> & { headerKeys: string[] } {
  const { headers, ...rest } = server;
  return { ...rest, headerKeys: headers ? Object.keys(headers) : [] };
}

function sanitizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}
