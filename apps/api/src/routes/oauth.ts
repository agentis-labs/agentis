/**
 * /v1/oauth — inline "Sign in with X" credential minting (ORCHESTRATOR-CREATION §7).
 *
 *   GET  /v1/oauth/providers              (auth)  → configured providers
 *   POST /v1/oauth/:provider/authorize    (auth)  → { url } to open in a popup
 *   GET  /v1/oauth/:provider/callback     (public)→ exchanges code, mints an
 *                                                    encrypted credential, then
 *                                                    postMessages the opener + closes
 *
 * The callback is intentionally unauthenticated (the provider redirects the
 * browser here) — trust is established by the single-use, TTL'd `state`.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { OAuthService, OAuthProviderId } from '../services/oauthService.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const PROVIDERS = ['google', 'slack', 'github'] as const;
const authorizeSchema = z.object({
  integrationSlug: z.string().min(1).max(60),
  origin: z.string().url().optional(),
});

function asProvider(value: string): OAuthProviderId {
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    throw new AgentisError('VALIDATION_FAILED', `unknown oauth provider: ${value}`);
  }
  return value as OAuthProviderId;
}

export function buildOAuthRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
  oauth: OAuthService;
}) {
  const app = new Hono();
  const authed = [requireAuth(deps), requireWorkspace(deps)] as const;

  app.get('/providers', ...authed, (c) => c.json({ providers: deps.oauth.configuredProviders() }));

  app.post('/:provider/authorize', ...authed, async (c) => {
    const ws = getWorkspace(c);
    const provider = asProvider(c.req.param('provider'));
    if (!deps.oauth.isConfigured(provider)) {
      throw new AgentisError('VALIDATION_FAILED', `${provider} OAuth is not configured on this server`);
    }
    const body = authorizeSchema.parse(await c.req.json().catch(() => ({})));
    const url = deps.oauth.startAuthorization({
      provider,
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      integrationSlug: body.integrationSlug,
      origin: body.origin ?? '',
    });
    return c.json({ url });
  });

  // Public — the provider redirects the browser here after consent.
  app.get('/:provider/callback', async (c) => {
    const provider = asProvider(c.req.param('provider'));
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    if (error) return c.html(closePage({ ok: false, error: String(error) }), 200);
    if (!code || !state) return c.html(closePage({ ok: false, error: 'missing code or state' }), 200);

    const entry = deps.oauth.consumeState(state);
    if (!entry || entry.provider !== provider) {
      return c.html(closePage({ ok: false, error: 'invalid or expired state' }), 200);
    }
    try {
      const tokens = await deps.oauth.exchangeCode(provider, code);
      const id = randomUUID();
      const name = `${provider}${tokens.account ? ` (${tokens.account})` : ''} — ${entry.integrationSlug}`;
      deps.db.insert(schema.credentials).values({
        id,
        workspaceId: entry.workspaceId,
        ambientId: null,
        userId: entry.userId,
        name,
        // credentialType includes the slug so the wiring panel's slug filter matches it.
        credentialType: `oauth_${entry.integrationSlug}`,
        encryptedValue: deps.vault.encrypt(JSON.stringify(tokens)),
      }).run();
      return c.html(closePage({ ok: true, credentialId: id, integrationSlug: entry.integrationSlug, origin: entry.origin }), 201);
    } catch (err) {
      return c.html(closePage({ ok: false, error: (err as Error).message, origin: entry.origin }), 200);
    }
  });

  return app;
}

/** Minimal HTML that hands the result back to the opener (canvas) and closes. */
function closePage(result: { ok: boolean; credentialId?: string; integrationSlug?: string; error?: string; origin?: string }): string {
  const target = result.origin && /^https?:\/\//.test(result.origin) ? result.origin : '*';
  const payload = JSON.stringify({ type: 'agentis-oauth', ...result });
  const msg = result.ok ? 'Connected. You can close this window.' : `Connection failed: ${result.error ?? 'unknown error'}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Agentis OAuth</title></head>
<body style="font-family:system-ui;background:#0b0c0f;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>${escapeHtml(msg)}</p>
<script>
  try { (window.opener||window.parent).postMessage(${JSON.stringify(payload)}, ${JSON.stringify(target)}); } catch (e) {}
  setTimeout(function(){ window.close(); }, 300);
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] ?? ch));
}
