/**
 * /v1/oauth/custom — "bring your own OAuth app" for ANY service
 * (INTEGRATION-CEILING-10X §2).
 *
 *   GET    /                    (auth)   → list this workspace's custom providers (redacted)
 *   PUT    /:providerId         (auth)   → create/update a custom provider def
 *   DELETE /:providerId         (auth)   → remove it
 *   POST   /:providerId/authorize (auth) → { url } to open in a popup
 *   GET    /:providerId/callback (public)→ exchanges code, mints an encrypted
 *                                          credential, postMessages the opener + closes
 *
 * Reuses the exact same generic OAuth2 mechanics (oauthFlow.ts) and popup-close
 * contract (closePage/requireAllowedOrigin from oauth.ts) as the built-in
 * provider list — this is the SAME flow, just driven by a user-configured
 * def instead of a hardcoded enum entry, so connecting Instagram (or anything
 * else) is a workspace configuration action, never an Agentis-core code change.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { CustomOAuthProviderService } from '../services/customOAuthProviderService.js';
import type { CustomOAuthStateStore } from '../services/customOAuthState.js';
import { buildAuthorizeUrl, exchangeCodeGeneric } from '../services/oauthFlow.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { closePage, requireAllowedOrigin } from './oauth.js';

const setSchema = z.object({
  label: z.string().min(1).max(120),
  authUrl: z.string().url(),
  tokenUrl: z.string().url(),
  scopes: z.array(z.string()).max(50).optional(),
  scopeSeparator: z.enum([' ', ',']).optional(),
  pkce: z.boolean().optional(),
  tokenAuth: z.enum(['body', 'basic']).optional(),
  tokenBodyFormat: z.enum(['form', 'json']).optional(),
  clientId: z.string().min(1).max(500),
  /** Omit to keep the existing secret when updating; required on first create. */
  clientSecret: z.string().min(1).max(4096).optional(),
});
const authorizeSchema = z.object({ origin: z.string().url().optional() });
const providerIdSchema = z.string().min(2).max(64);

export function buildCustomOAuthRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
  providers: CustomOAuthProviderService;
  states: CustomOAuthStateStore;
  allowedOrigins: readonly string[];
  baseUrl: string;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}) {
  const app = new Hono();
  const authed = [requireAuth(deps), requireWorkspace(deps)] as const;

  app.get('/', ...authed, (c) => {
    const ws = getWorkspace(c);
    return c.json({ providers: deps.providers.list(ws.workspaceId) });
  });

  app.put('/:providerId', ...authed, async (c) => {
    const ws = getWorkspace(c);
    const providerId = providerIdSchema.parse(c.req.param('providerId'));
    const body = setSchema.parse(await c.req.json());
    const saved = deps.providers.set({ workspaceId: ws.workspaceId, providerId, ...body });
    return c.json({ provider: saved });
  });

  app.delete('/:providerId', ...authed, (c) => {
    const ws = getWorkspace(c);
    const providerId = providerIdSchema.parse(c.req.param('providerId'));
    deps.providers.delete(ws.workspaceId, providerId);
    return c.json({ ok: true });
  });

  app.post('/:providerId/authorize', ...authed, async (c) => {
    const ws = getWorkspace(c);
    const providerId = providerIdSchema.parse(c.req.param('providerId'));
    const def = deps.providers.get(ws.workspaceId, providerId);
    if (!def) throw new AgentisError('RESOURCE_NOT_FOUND', `no custom OAuth provider "${providerId}" configured for this workspace`);
    const body = authorizeSchema.parse(await c.req.json().catch(() => ({})));
    const origin = requireAllowedOrigin(body.origin, deps.allowedOrigins);
    const codeVerifier = def.pkce ? randomBytes(32).toString('base64url') : undefined;
    const state = deps.states.create({ workspaceId: ws.workspaceId, userId: ws.user.id, providerId, origin, codeVerifier });
    const url = buildAuthorizeUrl({ def, client: def, redirectUri: redirectUri(deps.baseUrl, providerId), state, scopes: def.scopes, codeVerifier });
    return c.json({ url });
  });

  // Public — the provider redirects the browser here after consent. Trust is
  // established by the single-use, TTL'd `state`, same as the built-in flow.
  app.get('/:providerId/callback', async (c) => {
    const providerId = providerIdSchema.parse(c.req.param('providerId'));
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');
    if (error) return c.html(closePage({ ok: false, error: String(error) }), 200);
    if (!code || !state) return c.html(closePage({ ok: false, error: 'missing code or state' }), 200);

    const entry = deps.states.consume(state);
    if (!entry || entry.providerId !== providerId) {
      return c.html(closePage({ ok: false, error: 'invalid or expired state' }), 200);
    }
    const def = deps.providers.get(entry.workspaceId, providerId);
    if (!def) return c.html(closePage({ ok: false, error: 'provider was removed', origin: entry.origin }), 200);
    try {
      const bundle = await exchangeCodeGeneric({
        def,
        client: def,
        code,
        redirectUri: redirectUri(deps.baseUrl, providerId),
        codeVerifier: entry.codeVerifier,
        fetchImpl: deps.fetchImpl,
      });
      const id = randomUUID();
      const name = `${def.label}${bundle.account ? ` (${bundle.account})` : ''} — ${providerId}`;
      deps.db.insert(schema.credentials).values({
        id,
        workspaceId: entry.workspaceId,
        ambientId: null,
        userId: entry.userId,
        name,
        // Same credentialType convention as the built-in flow so the wiring
        // panel's slug filter matches it the same way.
        credentialType: `oauth_${providerId}`,
        encryptedValue: deps.vault.encrypt(JSON.stringify({ provider: providerId, ...bundle })),
      }).run();
      return c.html(closePage({ ok: true, credentialId: id, integrationSlug: providerId, origin: entry.origin }), 201);
    } catch (err) {
      return c.html(closePage({ ok: false, error: (err as Error).message, origin: entry.origin }), 200);
    }
  });

  app.onError((err, c) => {
    if (err instanceof AgentisError) throw err;
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: 'VALIDATION_FAILED', message: 'invalid custom OAuth provider id or body' } }, 422);
    }
    throw err;
  });

  return app;
}

function redirectUri(baseUrl: string, providerId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/oauth/custom/${providerId}/callback`;
}
