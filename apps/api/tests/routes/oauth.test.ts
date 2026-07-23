/**
 * /v1/oauth — inline "Sign in with X" credential minting (ORCH §7).
 *
 * Drives the full flow with a stubbed token exchange: providers list reflects
 * configured clients; authorize mints a state + URL; the callback exchanges the
 * code and persists an encrypted credential the wiring panel can pick up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { CredentialVault } from '../../src/services/credentialVault.js';
import { OAuthAppCredentialStore } from '../../src/services/oauthAppCredentialStore.js';
import { OAuthService } from '../../src/services/oauthService.js';
import { buildOAuthRoutes } from '../../src/routes/oauth.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
const vault = new CredentialVault(Buffer.alloc(32, 7).toString('base64'));

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function tokenFetch(): typeof fetch {
  return (async () => new Response(
    JSON.stringify({ access_token: 'at-123', refresh_token: 'rt-456', expires_in: 3600, scope: 'gmail.send', token_type: 'Bearer', email: 'alice@acme.com' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;
}

function appWith(oauth: OAuthService) {
  return ctx.buildApp([{
    path: '/v1/oauth',
    app: buildOAuthRoutes({
      db: ctx.db, auth: ctx.auth, vault, oauth,
      oauthAppCredentials: new OAuthAppCredentialStore(ctx.db, vault),
      allowedOrigins: ['http://localhost:5173'],
    }),
  }]);
}

describe('/v1/oauth', () => {
  it('lists all providers with configured flags', async () => {
    const oauth = new OAuthService({ baseUrl: 'http://localhost:8787', clients: { google: { clientId: 'gid', clientSecret: 'gsec' } } });
    const res = await appWith(oauth).request('/v1/oauth/providers', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { providers: Array<{ id: string; configured: boolean; mode: string }> };
    expect(body.providers.find((p) => p.id === 'google')).toMatchObject({ configured: true, mode: 'self' });
    expect(body.providers.find((p) => p.id === 'slack')).toMatchObject({ configured: false, mode: 'disabled' });
  });

  it('runs authorize → callback and mints an encrypted credential', async () => {
    const oauth = new OAuthService({
      baseUrl: 'http://localhost:8787',
      clients: { google: { clientId: 'gid', clientSecret: 'gsec' } },
      fetchImpl: tokenFetch(),
    });
    const a = appWith(oauth);

    const auth = await a.request('/v1/oauth/google/authorize', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ integrationSlug: 'gmail', origin: 'http://localhost:5173' }),
    });
    expect(auth.status).toBe(200);
    const { url } = await auth.json() as { url: string };
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    const state = parsed.searchParams.get('state')!;
    expect(state).toBeTruthy();

    const cb = await a.request(`/v1/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(201);
    const html = await cb.text();
    expect(html).toContain('agentis-oauth');

    const cred = ctx.db.select().from(schema.credentials).where(eq(schema.credentials.workspaceId, ctx.workspace.id)).all()
      .find((c) => c.credentialType === 'oauth_gmail');
    expect(cred).toBeTruthy();
    expect(cred!.name).toContain('alice@acme.com');
    const tokens = JSON.parse(vault.decrypt(cred!.encryptedValue)) as { accessToken: string; refreshToken: string };
    expect(tokens.accessToken).toBe('at-123');
    expect(tokens.refreshToken).toBe('rt-456');
  });

  it('accepts manifest service slugs for Google OAuth integrations', async () => {
    const oauth = new OAuthService({
      baseUrl: 'http://localhost:8787',
      clients: { google: { clientId: 'gid', clientSecret: 'gsec' } },
    });
    const res = await appWith(oauth).request('/v1/oauth/google/authorize', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ integrationSlug: 'google_sheets', origin: 'http://localhost:5173' }),
    });
    expect(res.status).toBe(200);
    const { url } = await res.json() as { url: string };
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/spreadsheets');
  });

  it('runs the X OAuth PKCE flow and stores a bound credential', async () => {
    let tokenRequest: { url: string; headers: Headers; body: string } | null = null;
    const oauth = new OAuthService({
      baseUrl: 'http://localhost:8787',
      clients: { twitter_x: { clientId: 'xid', clientSecret: 'xsec' } },
      fetchImpl: (async (input, init) => {
        tokenRequest = {
          url: String(input),
          headers: new Headers(init?.headers as HeadersInit),
          body: String(init?.body),
        };
        return new Response(
          JSON.stringify({ access_token: 'x-at', refresh_token: 'x-rt', expires_in: 3600, scope: 'tweet.read tweet.write', token_type: 'Bearer' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });
    const a = appWith(oauth);

    const auth = await a.request('/v1/oauth/twitter_x/authorize', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ integrationSlug: 'twitter_x', origin: 'http://localhost:5173' }),
    });
    expect(auth.status).toBe(200);
    const { url } = await auth.json() as { url: string };
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toContain('tweet.write');

    const state = parsed.searchParams.get('state')!;
    const cb = await a.request(`/v1/oauth/twitter_x/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(201);
    expect(tokenRequest?.url).toBe('https://api.x.com/2/oauth2/token');
    expect(tokenRequest?.headers.get('authorization')).toMatch(/^Basic /);
    expect(tokenRequest?.body).toContain('code_verifier=');

    const cred = ctx.db.select().from(schema.credentials).where(eq(schema.credentials.workspaceId, ctx.workspace.id)).all()
      .find((c) => c.credentialType === 'oauth_twitter_x');
    expect(cred).toBeTruthy();
    const tokens = JSON.parse(vault.decrypt(cred!.encryptedValue)) as { accessToken: string; refreshToken: string };
    expect(tokens.accessToken).toBe('x-at');
    expect(tokens.refreshToken).toBe('x-rt');
  });

  it('rejects a reused / unknown state', async () => {
    const oauth = new OAuthService({ baseUrl: 'http://localhost:8787', clients: { google: { clientId: 'gid', clientSecret: 'gsec' } }, fetchImpl: tokenFetch() });
    const a = appWith(oauth);
    const cb = await a.request('/v1/oauth/google/callback?code=abc&state=bogus');
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('invalid or expired state');
    // No credential created.
    expect(ctx.db.select().from(schema.credentials).all()).toHaveLength(0);
  });

  it('rejects an untrusted popup origin before issuing OAuth state', async () => {
    const oauth = new OAuthService({ baseUrl: 'http://localhost:8787', clients: { google: { clientId: 'gid', clientSecret: 'gsec' } } });
    const res = await appWith(oauth).request('/v1/oauth/google/authorize', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ integrationSlug: 'gmail', origin: 'https://attacker.example' }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects an integration slug that belongs to a different provider', async () => {
    const oauth = new OAuthService({ baseUrl: 'http://localhost:8787', clients: { google: { clientId: 'gid', clientSecret: 'gsec' } } });
    const res = await appWith(oauth).request('/v1/oauth/google/authorize', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ integrationSlug: 'slack', origin: 'http://localhost:5173' }),
    });
    expect(res.status).toBe(422);
  });

  it('routes unconfigured providers through the OAuth proxy and accepts the proxy token callback', async () => {
    const oauth = new OAuthService({
      baseUrl: 'http://localhost:8787',
      clients: {},
      oauthProxyUrl: 'https://connect.example',
    });
    const a = appWith(oauth);

    const providers = await a.request('/v1/oauth/providers', { headers: ctx.authHeaders });
    const providerBody = await providers.json() as { providers: Array<{ id: string; configured: boolean; mode: string }> };
    expect(providerBody.providers.find((p) => p.id === 'google')).toMatchObject({ configured: true, mode: 'proxy' });

    const auth = await a.request('/v1/oauth/google/authorize', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ integrationSlug: 'gmail', origin: 'http://localhost:5173' }),
    });
    expect(auth.status).toBe(200);
    const { url } = await auth.json() as { url: string };
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://connect.example');
    expect(parsed.pathname).toBe('/v1/oauth/google/authorize');
    expect(parsed.searchParams.get('callback_url')).toBe('http://localhost:8787/v1/oauth/proxy/callback');
    const state = parsed.searchParams.get('state')!;

    const cb = await a.request('/v1/oauth/proxy/callback', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'google',
        state,
        accessToken: 'proxy-at',
        refreshToken: 'proxy-rt',
        account: 'alice@example.com',
      }),
    });
    expect(cb.status).toBe(201);
    const body = await cb.json() as { credentialId: string };
    expect(body.credentialId).toBeTruthy();
    const cred = ctx.db.select().from(schema.credentials).where(eq(schema.credentials.workspaceId, ctx.workspace.id)).all()
      .find((c) => c.credentialType === 'oauth_gmail');
    expect(cred).toBeTruthy();
    expect(cred!.name).toContain('alice@example.com');
    const tokens = JSON.parse(vault.decrypt(cred!.encryptedValue)) as { accessToken: string; refreshToken: string };
    expect(tokens.accessToken).toBe('proxy-at');
    expect(tokens.refreshToken).toBe('proxy-rt');
  });

  describe('BYOC app credentials (no restart)', () => {
    it('lets an operator paste OAuth app credentials and use them immediately — no env var needed', async () => {
      const oauth = new OAuthService({ baseUrl: 'http://localhost:8787', clients: {} });
      const a = appWith(oauth);

      const before = await a.request('/v1/oauth/app-credentials', { headers: ctx.authHeaders });
      const beforeBody = await before.json() as { providers: Array<{ id: string; source: string }> };
      expect(beforeBody.providers.find((p) => p.id === 'google')).toMatchObject({ source: 'none' });

      const put = await a.request('/v1/oauth/app-credentials/google', {
        method: 'PUT', headers: ctx.authHeaders,
        body: JSON.stringify({ clientId: 'db-gid', clientSecret: 'db-gsec' }),
      });
      expect(put.status).toBe(200);

      const after = await a.request('/v1/oauth/app-credentials', { headers: ctx.authHeaders });
      const afterBody = await after.json() as { providers: Array<{ id: string; source: string }> };
      expect(afterBody.providers.find((p) => p.id === 'google')).toMatchObject({ source: 'db' });

      // No OAUTH_GOOGLE_CLIENT_ID set anywhere — this must come from the DB-backed store.
      const auth = await a.request('/v1/oauth/google/authorize', {
        method: 'POST', headers: ctx.authHeaders,
        body: JSON.stringify({ integrationSlug: 'gmail', origin: 'http://localhost:5173' }),
      });
      expect(auth.status).toBe(200);
      const { url } = await auth.json() as { url: string };
      expect(new URL(url).searchParams.get('client_id')).toBe('db-gid');

      const del = await a.request('/v1/oauth/app-credentials/google', { method: 'DELETE', headers: ctx.authHeaders });
      expect(del.status).toBe(200);
      const afterDelete = await a.request('/v1/oauth/app-credentials', { headers: ctx.authHeaders });
      const afterDeleteBody = await afterDelete.json() as { providers: Array<{ id: string; source: string }> };
      expect(afterDeleteBody.providers.find((p) => p.id === 'google')).toMatchObject({ source: 'none' });
    });

    it('lets an env var override a DB-stored credential', async () => {
      const oauth = new OAuthService({ baseUrl: 'http://localhost:8787', clients: { google: { clientId: 'env-gid', clientSecret: 'env-gsec' } } });
      const a = appWith(oauth);

      await a.request('/v1/oauth/app-credentials/google', {
        method: 'PUT', headers: ctx.authHeaders,
        body: JSON.stringify({ clientId: 'db-gid', clientSecret: 'db-gsec' }),
      });

      const list = await a.request('/v1/oauth/app-credentials', { headers: ctx.authHeaders });
      const listBody = await list.json() as { providers: Array<{ id: string; source: string }> };
      expect(listBody.providers.find((p) => p.id === 'google')).toMatchObject({ source: 'env' });

      const auth = await a.request('/v1/oauth/google/authorize', {
        method: 'POST', headers: ctx.authHeaders,
        body: JSON.stringify({ integrationSlug: 'gmail', origin: 'http://localhost:5173' }),
      });
      const { url } = await auth.json() as { url: string };
      expect(new URL(url).searchParams.get('client_id')).toBe('env-gid');
    });
  });
});
