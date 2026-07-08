/**
 * External MCP servers — Agentis as an MCP consumer (Pillar 5, consume half).
 *
 *   GET    /v1/mcp-servers                 → list configured servers
 *   POST   /v1/mcp-servers                 → register { name, url, headers?, credentialId? }
 *   DELETE /v1/mcp-servers/:id             → remove
 *   GET    /v1/mcp-servers/:id/tools       → live tools/list from the server
 *   POST   /v1/mcp-servers/:id/call        → { tool, arguments } → tools/call
 *   GET    /v1/mcp-servers/bridge/tools    → the bridge's NAMESPACED tool list
 *                                            (mcp__<slug>__<tool>) — the exact
 *                                            ids `mcp` workflow nodes and
 *                                            agentis.mcp.call consume.
 *
 * Server configs are persisted per workspace in `workspace_kv` under a single
 * `mcp:servers` key — no new table. Secrets take the VAULT road: register with
 * `credentialId` and the credential is decrypted into headers at call time
 * (MCP-CAPABILITY-PLANE §S1); inline headers remain supported. The live calls
 * go through `McpClient`, which SSRF-guards every outbound URL.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { AgentisError, AGENT_AFFORDANCES, type AgentAffordance } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { McpToolBridge } from '../services/mcp/mcpToolBridge.js';
import { McpClient } from '../services/mcp/mcpClient.js';
import { loadMcpServers, resolveMcpServerHeaders, saveMcpServers, type McpServerConfig } from '../services/mcp/mcpServerStore.js';
import { MCP_SERVER_CATALOG } from '../services/mcp/mcpServerCatalog.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export interface McpServersRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  /** Secrets plane: resolves `credentialId` registrations into headers. */
  vault?: CredentialVault;
  /** Namespaced tool discovery for authoring surfaces (the `mcp` node picker). */
  mcpBridge?: McpToolBridge;
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

  // The pre-defined mount catalog — "pick a provider", not "paste a URL".
  // (Static + workspace-agnostic; auth is still per-workspace at mount time.)
  app.get('/catalog', (c) => c.json({ catalog: MCP_SERVER_CATALOG }));

  // The bridge's namespaced tool list — id (mcp__<slug>__<tool>), server,
  // description, inputSchema — so authoring surfaces can offer a real picker
  // instead of asking humans/agents to hand-assemble tool ids.
  // (Registered BEFORE '/:id/*' so 'bridge' is never captured as a server id.)
  app.get('/bridge/tools', async (c) => {
    const ws = getWorkspace(c);
    if (!deps.mcpBridge) return c.json({ count: 0, tools: [] });
    const tools = await deps.mcpBridge.listTools(ws.workspaceId);
    return c.json({
      count: tools.length,
      tools: tools.map((t) => ({
        id: t.id,
        serverId: t.serverId,
        serverName: t.serverName,
        toolName: t.toolName,
        description: t.description,
        provides: t.provides ?? null,
        inputSchema: t.inputSchema ?? null,
      })),
    });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; url?: unknown; headers?: unknown; credentialId?: unknown; allowedTools?: unknown; affordance?: unknown; allowPrivateNetwork?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!name) throw new AgentisError('VALIDATION_FAILED', 'name is required');
    if (!url) throw new AgentisError('VALIDATION_FAILED', 'url is required');
    const headers = sanitizeHeaders(body.headers);
    const credentialId = typeof body.credentialId === 'string' && body.credentialId.trim() ? body.credentialId.trim() : undefined;
    const allowedTools = sanitizeToolList(body.allowedTools);
    const servers = loadMcpServers(deps.db, ws.workspaceId);
    if (servers.some((s) => s.name === name)) {
      throw new AgentisError('RESOURCE_CONFLICT', `an MCP server named '${name}' already exists`);
    }
    const server: McpServerConfig = { id: randomUUID(), name, url, createdAt: new Date().toISOString() };
    if (headers) server.headers = headers;
    if (credentialId) server.credentialId = credentialId;
    if (allowedTools) server.allowedTools = allowedTools;
    if (isAffordance(body.affordance)) server.affordance = body.affordance;
    if (body.allowPrivateNetwork === true) server.allowPrivateNetwork = true;
    saveMcpServers(deps.db, ws.workspaceId, [...servers, server]);
    return c.json({ server: redact(server) }, 201);
  });

  // Update a mount's governance surface: the tool allowlist (least privilege),
  // the vault credential, or the private-network flag. Name/url stay immutable
  // (remount for a different server).
  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const servers = loadMcpServers(deps.db, ws.workspaceId);
    const idx = servers.findIndex((s) => s.id === id);
    if (idx === -1) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'mcp server not found' } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { allowedTools?: unknown; credentialId?: unknown; allowPrivateNetwork?: unknown };
    const next: McpServerConfig = { ...servers[idx]! };
    if (body.allowedTools !== undefined) {
      const allowed = sanitizeToolList(body.allowedTools);
      if (allowed) next.allowedTools = allowed;
      else delete next.allowedTools; // [] / null clears the allowlist (= all tools)
    }
    if (body.credentialId !== undefined) {
      const cred = typeof body.credentialId === 'string' && body.credentialId.trim() ? body.credentialId.trim() : undefined;
      if (cred) next.credentialId = cred;
      else delete next.credentialId;
    }
    if (body.allowPrivateNetwork !== undefined) {
      if (body.allowPrivateNetwork === true) next.allowPrivateNetwork = true;
      else delete next.allowPrivateNetwork;
    }
    const updated = [...servers];
    updated[idx] = next;
    saveMcpServers(deps.db, ws.workspaceId, updated);
    return c.json({ server: redact(next) });
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
    const client = clientFor(deps, ws.workspaceId, server);
    const tools = await client.listTools();
    return c.json({ serverId: server.id, tools });
  });

  // VERIFY, don't assume. Actually handshake the server (vault-resolved auth,
  // SSRF-guarded) and report the truth — so nothing ever shows "connected"
  // without a real tools/list. Returns 200 with { ok:false, error } on a
  // reachable-but-failing server (a UI state, not an HTTP error).
  app.post('/:id/verify', async (c) => {
    const ws = getWorkspace(c);
    const server = loadMcpServers(deps.db, ws.workspaceId).find((s) => s.id === c.req.param('id'));
    if (!server) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'mcp server not found' } }, 404);
    try {
      const client = clientFor(deps, ws.workspaceId, server);
      const tools = await client.listTools();
      const names = tools.map((t) => t.name);
      const allowed = Array.isArray(server.allowedTools) && server.allowedTools.length > 0
        ? names.filter((n) => server.allowedTools!.includes(n))
        : names;
      return c.json({ ok: true, serverId: server.id, toolCount: allowed.length, tools: allowed });
    } catch (err) {
      return c.json({ ok: false, serverId: server.id, error: (err as Error).message });
    }
  });

  app.post('/:id/call', async (c) => {
    const ws = getWorkspace(c);
    const server = loadMcpServers(deps.db, ws.workspaceId).find((s) => s.id === c.req.param('id'));
    if (!server) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'mcp server not found' } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { tool?: unknown; arguments?: unknown };
    const tool = typeof body.tool === 'string' ? body.tool : '';
    if (!tool) throw new AgentisError('VALIDATION_FAILED', 'tool is required');
    // Least privilege: the allowlist governs REST exactly like the bridge.
    if (Array.isArray(server.allowedTools) && server.allowedTools.length > 0 && !server.allowedTools.includes(tool)) {
      throw new AgentisError('VALIDATION_FAILED', `tool '${tool}' is not on the allowlist for MCP server '${server.name}'`);
    }
    const args = body.arguments && typeof body.arguments === 'object' ? body.arguments as Record<string, unknown> : {};
    const client = clientFor(deps, ws.workspaceId, server);
    const result = await client.callTool(tool, args);
    return c.json(result);
  });

  return app;
}

/** Construct a client with vault-resolved headers (secrets plane). */
function clientFor(deps: McpServersRoutesDeps, workspaceId: string, server: McpServerConfig): McpClient {
  const resolved = resolveMcpServerHeaders(deps.db, deps.vault, workspaceId, server);
  if (resolved.credentialError) {
    throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', `MCP server '${server.name}': ${resolved.credentialError}`);
  }
  return new McpClient(server.url, resolved.headers, { allowPrivateNetwork: server.allowPrivateNetwork ?? deps.allowPrivateNetwork });
}

/** Never return raw header values (they may carry secrets). */
function redact(server: McpServerConfig): Omit<McpServerConfig, 'headers'> & { headerKeys: string[] } {
  const { headers, ...rest } = server;
  return { ...rest, headerKeys: headers ? Object.keys(headers) : [] };
}

function isAffordance(value: unknown): value is AgentAffordance {
  return typeof value === 'string' && (AGENT_AFFORDANCES as readonly string[]).includes(value);
}

function sanitizeToolList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim());
  return out.length > 0 ? [...new Set(out)] : undefined;
}

function sanitizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}
