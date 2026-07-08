/**
 * /v1/mcp-oauth — auth scoping.
 *
 * The OAuth provider redirects the BROWSER to `/callback` with no bearer token,
 * so that route MUST be public. `/:serverId/authorize` MUST require auth. A
 * wildcard-sub-app middleware once caught `/callback` too and 401'd it with
 * "Missing bearer token" — this fences that regression.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpOAuthRoutes } from '../../src/routes/mcpOAuth.js';
import { McpOAuthService } from '../../src/services/mcp/mcpOAuthService.js';
import { CredentialVault } from '../../src/services/credentialVault.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{
    path: '/v1/mcp-oauth',
    app: buildMcpOAuthRoutes({
      db: ctx.db,
      auth: ctx.auth,
      vault: new CredentialVault(ctx.secrets.credentialKeyB64),
      oauth: new McpOAuthService(),
      publicUrl: 'https://api.test',
      allowedOrigins: ['https://app.test'],
    }),
  }]);
}

describe('/v1/mcp-oauth', () => {
  it('the callback is PUBLIC — no bearer token needed (the provider redirects the browser here)', async () => {
    // No auth headers, missing code/state → renders the close-popup HTML, NOT a
    // 401 "Missing bearer token". The key assertion: it is not an auth failure.
    const res = await app().request('/v1/mcp-oauth/callback');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Agentis MCP OAuth'); // the close-popup page
    expect(body).not.toContain('AUTH_TOKEN_INVALID');
    expect(body).not.toContain('Missing bearer token');
  });

  it('the callback surfaces a provider error without auth', async () => {
    const res = await app().request('/v1/mcp-oauth/callback?error=access_denied&error_description=nope');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('nope');
  });

  it('authorize REQUIRES auth (401 without a bearer token)', async () => {
    const res = await app().request('/v1/mcp-oauth/srv1/authorize', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('authorize 404s for an unknown server (with auth)', async () => {
    const res = await app().request('/v1/mcp-oauth/nope/authorize', {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ origin: 'https://app.test' }),
    });
    expect(res.status).toBe(404);
  });
});
