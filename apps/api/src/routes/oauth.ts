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
import type { OAuthAppCredentialStore } from '../services/oauthAppCredentialStore.js';
import { OAUTH_PROVIDER_IDS, providerForSlug, type OAuthService, type OAuthProviderId } from '../services/oauthService.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const authorizeSchema = z.object({
  integrationSlug: z.string().min(1).max(60),
  origin: z.string().url().optional(),
});

const appCredentialSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const proxyCallbackSchema = z.object({
  state: z.string().min(12),
  provider: z.string().min(1),
  accessToken: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
  refreshToken: z.string().optional(),
  refresh_token: z.string().optional(),
  expiresAt: z.string().optional(),
  expires_at: z.string().optional(),
  scope: z.string().optional(),
  tokenType: z.string().optional(),
  token_type: z.string().optional(),
  account: z.string().optional(),
});

function asProvider(value: string): OAuthProviderId {
  if (!(OAUTH_PROVIDER_IDS as readonly string[]).includes(value)) {
    throw new AgentisError('VALIDATION_FAILED', `unknown oauth provider: ${value}`);
  }
  return value as OAuthProviderId;
}

export function buildOAuthRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
  oauth: OAuthService;
  oauthAppCredentials: OAuthAppCredentialStore;
  allowedOrigins: readonly string[];
}) {
  const app = new Hono();
  const authed = [requireAuth(deps), requireWorkspace(deps)] as const;

  // Return EVERY known provider with a `configured` flag (not just configured
  // ones) so the canvas can render the right OAuth affordance for an OAuth-only
  // service even before the operator sets client credentials.
  app.get('/providers', ...authed, (c) => c.json({ providers: deps.oauth.allProviders() }));

  // BYOC — an operator pastes their own OAuth app's client id/secret here
  // instead of editing OAUTH_<PROVIDER>_CLIENT_ID/SECRET env vars and
  // restarting. Instance-wide (see OAuthAppCredentialStore), gated by the
  // same requireAuth/requireWorkspace as everything else — this codebase has
  // no separate admin role, every authenticated user is already treated as
  // the instance operator (Governance, API Keys, etc. work the same way).
  app.get('/app-credentials', ...authed, (c) => {
    const stored = deps.oauthAppCredentials.list();
    // Env always wins (see OAuthService#client) — reflect that precedence here too.
    const providers = OAUTH_PROVIDER_IDS.map((id) => ({
      id,
      source: deps.oauth.hasEnvClient(id) ? 'env' as const : stored[id] ? 'db' as const : 'none' as const,
    }));
    return c.json({ providers });
  });

  app.put('/app-credentials/:provider', ...authed, async (c) => {
    const provider = asProvider(c.req.param('provider'));
    const body = appCredentialSchema.parse(await c.req.json().catch(() => ({})));
    deps.oauthAppCredentials.set(provider, body);
    deps.oauth.setDbClient(provider, body);
    return c.json({ ok: true });
  });

  app.delete('/app-credentials/:provider', ...authed, (c) => {
    const provider = asProvider(c.req.param('provider'));
    deps.oauthAppCredentials.delete(provider);
    deps.oauth.clearDbClient(provider);
    return c.json({ ok: true });
  });

  app.post('/:provider/authorize', ...authed, async (c) => {
    const ws = getWorkspace(c);
    const provider = asProvider(c.req.param('provider'));
    if (!deps.oauth.isConfigured(provider)) {
      throw new AgentisError('VALIDATION_FAILED', `${provider} OAuth is not configured on this server`);
    }
    const body = authorizeSchema.parse(await c.req.json().catch(() => ({})));
    if (providerForSlug(body.integrationSlug) !== provider) {
      throw new AgentisError('VALIDATION_FAILED', `${provider} cannot authenticate integration '${body.integrationSlug}'`);
    }
    const origin = requireAllowedOrigin(body.origin, deps.allowedOrigins);
    const url = deps.oauth.startAuthorization({
      provider,
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      integrationSlug: body.integrationSlug,
      origin,
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
      const tokens = await deps.oauth.exchangeCode(provider, code, { codeVerifier: entry.codeVerifier });
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

  // Public endpoint for a hosted/self-hosted Connect proxy to relay normalized
  // tokens back to the originating Agentis instance. Trust is bounded by the
  // random, single-use state minted by /authorize.
  app.post('/proxy/callback', async (c) => {
    const body = proxyCallbackSchema.parse(await c.req.json().catch(() => ({})));
    const provider = asProvider(body.provider);
    const entry = deps.oauth.consumeState(body.state);
    if (!entry || entry.provider !== provider) {
      throw new AgentisError('VALIDATION_FAILED', 'invalid or expired state');
    }
    const accessToken = body.accessToken ?? body.access_token;
    if (!accessToken) throw new AgentisError('VALIDATION_FAILED', 'missing access token');
    const tokens = {
      provider,
      accessToken,
      refreshToken: body.refreshToken ?? body.refresh_token,
      expiresAt: body.expiresAt ?? body.expires_at,
      scope: body.scope,
      tokenType: body.tokenType ?? body.token_type,
      account: body.account,
    };
    const id = randomUUID();
    const name = `${provider}${tokens.account ? ` (${tokens.account})` : ''} - ${entry.integrationSlug}`;
    deps.db.insert(schema.credentials).values({
      id,
      workspaceId: entry.workspaceId,
      ambientId: null,
      userId: entry.userId,
      name,
      credentialType: `oauth_${entry.integrationSlug}`,
      encryptedValue: deps.vault.encrypt(JSON.stringify(tokens)),
    }).run();
    return c.json({ ok: true, credentialId: id, integrationSlug: entry.integrationSlug, origin: entry.origin }, 201);
  });

  return app;
}

/** Minimal HTML that hands the result back to the opener (canvas) and closes. */
function closePage(result: { ok: boolean; credentialId?: string; integrationSlug?: string; error?: string; origin?: string }): string {
  const target = result.origin && /^https?:\/\//.test(result.origin) ? result.origin : null;
  const payload = JSON.stringify({ type: 'agentis-oauth', ...result });
  const msg = result.ok ? 'Connected. You can close this window.' : `Connection failed: ${result.error ?? 'unknown error'}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Agentis OAuth</title></head>
<body style="font-family:system-ui;background:#0b0c0f;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>${escapeHtml(msg)}</p>
<script>
  try { ${target ? `(window.opener||window.parent).postMessage(${JSON.stringify(payload)}, ${JSON.stringify(target)});` : ''} } catch (e) {}
  setTimeout(function(){ window.close(); }, 300);
</script>
</body></html>`;
}

function requireAllowedOrigin(value: string | undefined, allowedOrigins: readonly string[]): string {
  const origin = value ? new URL(value).origin : allowedOrigins[0];
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new AgentisError('VALIDATION_FAILED', 'OAuth popup origin is not an allowed application origin');
  }
  return origin;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] ?? ch));
}
