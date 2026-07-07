/**
 * /v1/mcp-oauth — spec-compliant "Connect with X" for external MCP servers.
 *
 *   POST /v1/mcp-oauth/:serverId/authorize  (auth)  → { url } for a popup
 *   GET  /v1/mcp-oauth/callback             (public)→ exchange code, mint a
 *                                                     vault credential, link it
 *                                                     to the mount, close popup
 *
 * The callback is unauthenticated (the provider redirects the browser here);
 * trust is the single-use, TTL'd `state`. On success the mount's
 * `credentialId` is set so every later call resolves a Bearer token from the
 * vault (wave-2 OAuth-bundle → Bearer). See MCP-OAUTH-REDESIGN.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { McpOAuthService } from '../services/mcpOAuthService.js';
import { loadMcpServers, saveMcpServers } from '../services/mcpServerStore.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export interface McpOAuthRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
  oauth: McpOAuthService;
  /** Public base URL of this API — the OAuth redirect target. */
  publicUrl: string;
  allowedOrigins: readonly string[];
  allowPrivateNetwork?: boolean;
}

export function buildMcpOAuthRoutes(deps: McpOAuthRoutesDeps) {
  const app = new Hono();
  const redirectUri = `${deps.publicUrl.replace(/\/+$/, '')}/v1/mcp-oauth/callback`;
  // Auth is applied PER ROUTE (not as a wildcard sub-app) so the public
  // `/callback` — which the OAuth provider redirects the BROWSER to, with no
  // bearer token — is never caught by requireAuth. (A `use('*')` sub-app
  // mounted at '/' would 401 the callback with "Missing bearer token".)
  const authed = [requireAuth(deps), requireWorkspace(deps)] as const;

  // Begin: discover + register + PKCE, return the authorize URL (needs auth).
  app.post('/:serverId/authorize', ...authed, async (c) => {
    const ws = getWorkspace(c);
    const server = loadMcpServers(deps.db, ws.workspaceId).find((s) => s.id === c.req.param('serverId'));
    if (!server) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'mcp server not found' } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { origin?: string };
    const origin = requireAllowedOrigin(body.origin, deps.allowedOrigins);
    const url = await deps.oauth.beginAuthorization({
      serverId: server.id,
      serverUrl: server.url,
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      origin,
      redirectUri,
      allowPrivateNetwork: server.allowPrivateNetwork ?? deps.allowPrivateNetwork,
    });
    return c.json({ url });
  });

  // Callback: exchange the code, store the token, link it to the mount. PUBLIC.
  app.get('/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    if (error) return c.html(closePage({ ok: false, error: String(c.req.query('error_description') ?? error) }), 200);
    if (!code || !state) return c.html(closePage({ ok: false, error: 'missing code or state' }), 200);

    const entry = deps.oauth.consumeState(state);
    if (!entry) return c.html(closePage({ ok: false, error: 'invalid or expired state' }), 200);
    try {
      const tokens = await deps.oauth.exchangeCode(entry, code);
      const server = loadMcpServers(deps.db, entry.workspaceId).find((s) => s.id === entry.serverId);
      const id = randomUUID();
      deps.db.insert(schema.credentials).values({
        id,
        workspaceId: entry.workspaceId,
        ambientId: null,
        userId: entry.userId,
        name: `MCP OAuth — ${server?.name ?? entry.serverId}`,
        // Distinct type: MCP OAuth tokens are NOT shared with the connector catalog.
        credentialType: `mcp_oauth_${entry.serverId}`,
        encryptedValue: deps.vault.encrypt(JSON.stringify(tokens)),
      }).run();
      // Link the credential to the mount so every call resolves a Bearer token.
      if (server) {
        const servers = loadMcpServers(deps.db, entry.workspaceId);
        saveMcpServers(deps.db, entry.workspaceId, servers.map((s) => (s.id === server.id ? { ...s, credentialId: id } : s)));
      }
      return c.html(closePage({ ok: true, serverId: entry.serverId, origin: entry.origin }), 201);
    } catch (err) {
      return c.html(closePage({ ok: false, error: (err as Error).message, origin: entry.origin }), 200);
    }
  });

  return app;
}

function requireAllowedOrigin(value: string | undefined, allowedOrigins: readonly string[]): string {
  const origin = value ? new URL(value).origin : allowedOrigins[0];
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new AgentisError('VALIDATION_FAILED', 'OAuth popup origin is not an allowed application origin');
  }
  return origin;
}

function closePage(result: { ok: boolean; serverId?: string; error?: string; origin?: string }): string {
  const target = result.origin && /^https?:\/\//.test(result.origin) ? result.origin : null;
  const payload = JSON.stringify({ type: 'agentis-mcp-oauth', ...result });
  const msg = result.ok ? 'Connected. You can close this window.' : `Connection failed: ${result.error ?? 'unknown error'}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Agentis MCP OAuth</title></head>
<body style="font-family:system-ui;background:#0b0c0f;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>${escapeHtml(msg)}</p>
<script>
  try { ${target ? `(window.opener||window.parent).postMessage(${JSON.stringify(payload)}, ${JSON.stringify(target)});` : ''} } catch (e) {}
  setTimeout(function(){ window.close(); }, 300);
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] ?? ch));
}
