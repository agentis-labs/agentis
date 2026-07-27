/**
 * /v1/oauth/custom — "bring your own OAuth app" for ANY service
 * (INTEGRATION-CEILING-10X §2). Drives the full flow with a stubbed token
 * exchange: register a custom provider def → authorize mints a state + URL →
 * the callback exchanges the code and persists an encrypted credential, the
 * same shape the built-in flow produces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { CustomOAuthProviderService } from '../../src/services/customOAuthProviderService.js';
import { CustomOAuthStateStore } from '../../src/services/customOAuthState.js';
import { buildCustomOAuthRoutes } from '../../src/routes/customOAuth.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let providers: CustomOAuthProviderService;
let states: CustomOAuthStateStore;

beforeEach(async () => {
  ctx = await createTestContext();
  providers = new CustomOAuthProviderService({ db: ctx.db, vault: ctx.vault });
  states = new CustomOAuthStateStore();
});
afterEach(() => ctx.close());

function tokenFetch(): typeof fetch {
  // The shared generic exchange only recognizes email/workspace_name/authed_user.id
  // as an "account" label (oauthFlow.ts) — mirror that, not an arbitrary field name.
  return (async () => new Response(
    JSON.stringify({ access_token: 'ig-at-123', refresh_token: 'ig-rt-456', expires_in: 3600, scope: 'user_profile', token_type: 'Bearer', email: 'my_ig_handle' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;
}

function app(fetchImpl?: typeof fetch) {
  return ctx.buildApp([{
    path: '/v1/oauth/custom',
    app: buildCustomOAuthRoutes({
      db: ctx.db, auth: ctx.auth, vault: ctx.vault, providers, states,
      allowedOrigins: ['http://localhost:5173'],
      baseUrl: 'http://localhost:8787',
      fetchImpl,
    }),
  }]);
}

describe('/v1/oauth/custom', () => {
  it('PUT registers a custom provider def; GET lists it without the secret', async () => {
    const put = await app().request('/v1/oauth/custom/instagram', {
      method: 'PUT',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        label: 'Instagram', authUrl: 'https://api.instagram.com/oauth/authorize', tokenUrl: 'https://api.instagram.com/oauth/access_token',
        clientId: 'ig-client', clientSecret: 'ig-secret', scopes: ['user_profile'],
      }),
    });
    expect(put.status).toBe(200);
    const list = await app().request('/v1/oauth/custom', { headers: ctx.authHeaders });
    const body = await list.json() as { providers: Array<{ providerId: string; hasClientSecret: boolean }> };
    expect(body.providers.find((p) => p.providerId === 'instagram')).toMatchObject({ hasClientSecret: true });
    expect(JSON.stringify(body)).not.toContain('ig-secret');
  });

  it('runs authorize → callback end to end and mints an encrypted credential (same shape as the built-in flow)', async () => {
    providers.set({
      workspaceId: ctx.workspace.id, providerId: 'instagram', label: 'Instagram',
      authUrl: 'https://api.instagram.com/oauth/authorize', tokenUrl: 'https://api.instagram.com/oauth/access_token',
      clientId: 'ig-client', clientSecret: 'ig-secret', scopes: ['user_profile', 'user_media'],
    });
    const a = app(tokenFetch());

    const auth = await a.request('/v1/oauth/custom/instagram/authorize', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ origin: 'http://localhost:5173' }),
    });
    expect(auth.status).toBe(200);
    const { url } = await auth.json() as { url: string };
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://api.instagram.com/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('ig-client');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:8787/v1/oauth/custom/instagram/callback');
    expect(parsed.searchParams.get('scope')).toBe('user_profile user_media');
    const state = parsed.searchParams.get('state')!;
    expect(state).toBeTruthy();

    const cb = await a.request(`/v1/oauth/custom/instagram/callback?code=abc123&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(201);
    const html = await cb.text();
    expect(html).toContain('agentis-oauth');

    const cred = ctx.db.select().from(schema.credentials).where(eq(schema.credentials.workspaceId, ctx.workspace.id)).all()
      .find((c) => c.credentialType === 'oauth_instagram');
    expect(cred).toBeTruthy();
    expect(cred!.name).toContain('my_ig_handle');
    const tokens = JSON.parse(ctx.vault.decrypt(cred!.encryptedValue)) as { accessToken: string; refreshToken: string };
    expect(tokens.accessToken).toBe('ig-at-123');
    expect(tokens.refreshToken).toBe('ig-rt-456');
  });

  it('rejects authorize for a providerId with no registered def', async () => {
    const res = await app().request('/v1/oauth/custom/nope/authorize', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ origin: 'http://localhost:5173' }),
    });
    expect(res.status).toBe(404);
  });

  it('the callback rejects a reused / unknown state', async () => {
    providers.set({
      workspaceId: ctx.workspace.id, providerId: 'instagram', label: 'Instagram',
      authUrl: 'https://api.instagram.com/oauth/authorize', tokenUrl: 'https://api.instagram.com/oauth/access_token',
      clientId: 'ig-client', clientSecret: 'ig-secret',
    });
    const a = app(tokenFetch());
    const cb = await a.request('/v1/oauth/custom/instagram/callback?code=abc&state=not-a-real-state');
    expect(cb.status).toBe(200); // renders the close-popup error page, not a hard 4xx
    const html = await cb.text();
    expect(html).toContain('invalid or expired state');
  });

  it('rejects an untrusted popup origin before issuing state', async () => {
    providers.set({
      workspaceId: ctx.workspace.id, providerId: 'instagram', label: 'Instagram',
      authUrl: 'https://api.instagram.com/oauth/authorize', tokenUrl: 'https://api.instagram.com/oauth/access_token',
      clientId: 'ig-client', clientSecret: 'ig-secret',
    });
    const res = await app().request('/v1/oauth/custom/instagram/authorize', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ origin: 'https://evil.example.com' }),
    });
    expect(res.status).toBe(422);
  });

  it('PKCE: when pkce is enabled, the authorize URL carries a code_challenge and the callback verifies it', async () => {
    providers.set({
      workspaceId: ctx.workspace.id, providerId: 'pkce_svc', label: 'PKCE Service',
      authUrl: 'https://auth.example.com/authorize', tokenUrl: 'https://auth.example.com/token',
      clientId: 'c', clientSecret: 's', pkce: true,
    });
    let seenVerifier: string | undefined;
    const fetchImpl = (async (_url, init) => {
      const params = new URLSearchParams(String(init?.body));
      seenVerifier = params.get('code_verifier') ?? undefined;
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const a = app(fetchImpl);

    const auth = await a.request('/v1/oauth/custom/pkce_svc/authorize', {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ origin: 'http://localhost:5173' }),
    });
    const { url } = await auth.json() as { url: string };
    const parsed = new URL(url);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    const state = parsed.searchParams.get('state')!;

    await a.request(`/v1/oauth/custom/pkce_svc/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(seenVerifier).toBeTruthy();
  });
});
