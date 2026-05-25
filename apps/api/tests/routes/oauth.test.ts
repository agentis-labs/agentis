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
  return ctx.buildApp([{ path: '/v1/oauth', app: buildOAuthRoutes({ db: ctx.db, auth: ctx.auth, vault, oauth }) }]);
}

describe('/v1/oauth', () => {
  it('lists only configured providers', async () => {
    const oauth = new OAuthService({ baseUrl: 'http://localhost:8787', clients: { google: { clientId: 'gid', clientSecret: 'gsec' } } });
    const res = await appWith(oauth).request('/v1/oauth/providers', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { providers: Array<{ id: string }> };
    expect(body.providers.map((p) => p.id)).toEqual(['google']);
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

  it('rejects a reused / unknown state', async () => {
    const oauth = new OAuthService({ baseUrl: 'http://localhost:8787', clients: { google: { clientId: 'gid', clientSecret: 'gsec' } }, fetchImpl: tokenFetch() });
    const a = appWith(oauth);
    const cb = await a.request('/v1/oauth/google/callback?code=abc&state=bogus');
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('invalid or expired state');
    // No credential created.
    expect(ctx.db.select().from(schema.credentials).all()).toHaveLength(0);
  });
});
