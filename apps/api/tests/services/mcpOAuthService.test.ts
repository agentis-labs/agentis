/**
 * McpOAuthService — the spec-compliant discovery → DCR → PKCE → exchange flow
 * (MCP Authorization 2025-06-18). Uses an injected fetch so no network / server
 * is required; asserts the client walks PRM (RFC9728) → AS metadata (RFC8414)
 * → registration (RFC7591) and builds a PKCE authorize URL bound to the
 * resource (RFC8707), then exchanges the code.
 */
import { describe, it, expect } from 'vitest';
import { McpOAuthService } from '../../src/services/mcpOAuthService.js';

const SERVER = 'https://mcp.example.com/mcp';
const AS = 'https://auth.example.com';

/** A fake MCP + OAuth stack: 401→PRM→AS-metadata→register→token. */
function fakeFetch(calls: Array<{ url: string; body?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    // 1. The initialize probe → 401 pointing at PRM.
    if (url === SERVER && init?.method === 'POST' && String(init.body).includes('initialize')) {
      return new Response('unauthorized', {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${SERVER.replace('/mcp', '')}/.well-known/oauth-protected-resource/mcp"` },
      });
    }
    // 2. Protected Resource Metadata (RFC9728).
    if (url.includes('/.well-known/oauth-protected-resource')) {
      return json({ resource: SERVER, authorization_servers: [AS], scopes_supported: ['read', 'write'] });
    }
    // 3. Authorization Server Metadata (RFC8414).
    if (url === `${AS}/.well-known/oauth-authorization-server`) {
      return json({
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        registration_endpoint: `${AS}/register`,
      });
    }
    // 4. Dynamic Client Registration (RFC7591).
    if (url === `${AS}/register` && init?.method === 'POST') {
      return json({ client_id: 'dyn-client-123' }, 201);
    }
    // 5. Token exchange.
    if (url === `${AS}/token` && init?.method === 'POST') {
      return json({ access_token: 'at-xyz', refresh_token: 'rt-xyz', token_type: 'Bearer', expires_in: 3600, scope: 'read write' });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('McpOAuthService', () => {
  it('discovers endpoints via PRM → AS metadata', async () => {
    const calls: Array<{ url: string }> = [];
    const svc = new McpOAuthService({ fetchImpl: fakeFetch(calls) });
    const endpoints = await svc.discover(SERVER, true);
    expect(endpoints).toMatchObject({
      authorizationEndpoint: `${AS}/authorize`,
      tokenEndpoint: `${AS}/token`,
      registrationEndpoint: `${AS}/register`,
      resource: SERVER,
    });
    expect(endpoints!.scopesSupported).toEqual(['read', 'write']);
  });

  it('begins authorization: DCR → PKCE authorize URL bound to the resource', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const svc = new McpOAuthService({ fetchImpl: fakeFetch(calls) });
    const authorizeUrl = await svc.beginAuthorization({
      serverId: 'srv1', serverUrl: SERVER, workspaceId: 'ws', userId: 'u',
      origin: 'https://app.test', redirectUri: 'https://api.test/v1/mcp-oauth/callback', allowPrivateNetwork: true,
    });
    const u = new URL(authorizeUrl);
    expect(u.origin + u.pathname).toBe(`${AS}/authorize`);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('dyn-client-123'); // from DCR
    expect(u.searchParams.get('code_challenge_method')).toBe('S256'); // PKCE
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('resource')).toBe(SERVER); // RFC8707
    expect(u.searchParams.get('redirect_uri')).toBe('https://api.test/v1/mcp-oauth/callback');
    // The registration call really happened.
    expect(calls.some((c) => c.url === `${AS}/register`)).toBe(true);
  });

  it('completes: state is single-use and the code exchanges to a token bundle', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const svc = new McpOAuthService({ fetchImpl: fakeFetch(calls) });
    const authorizeUrl = await svc.beginAuthorization({
      serverId: 'srv1', serverUrl: SERVER, workspaceId: 'ws', userId: 'u',
      origin: 'https://app.test', redirectUri: 'https://api.test/v1/mcp-oauth/callback', allowPrivateNetwork: true,
    });
    const state = new URL(authorizeUrl).searchParams.get('state')!;

    const entry = svc.consumeState(state);
    expect(entry).toBeTruthy();
    expect(svc.consumeState(state)).toBeNull(); // single-use

    const tokens = await svc.exchangeCode(entry!, 'auth-code-abc');
    expect(tokens.accessToken).toBe('at-xyz');
    expect(tokens.refreshToken).toBe('rt-xyz');
    expect(tokens.expiresAt).toBeTruthy();
    // The exchange sent PKCE verifier + resource.
    const tokenCall = calls.find((c) => c.url === `${AS}/token`);
    expect(tokenCall?.body).toContain('code_verifier=');
    expect(tokenCall?.body).toContain('grant_type=authorization_code');
    expect(decodeURIComponent(tokenCall!.body!)).toContain(`resource=${SERVER}`);
  });

  it('returns null when the server does not advertise OAuth', async () => {
    const svc = new McpOAuthService({
      fetchImpl: (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch,
    });
    const endpoints = await svc.discover(SERVER, true);
    expect(endpoints).toBeNull();
  });

  it('CONFIDENTIAL client (Supabase-style): DCR returns a client_secret → token exchange sends it', async () => {
    // Supabase's DCR returns a client_secret while omitting
    // token_endpoint_auth_method; the exchange MUST send the secret or 422.
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url === SERVER && String(init?.body).includes('initialize')) {
        return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${SERVER.replace('/mcp', '')}/.well-known/oauth-protected-resource/mcp"` } });
      }
      if (url.includes('/.well-known/oauth-protected-resource')) return json({ resource: SERVER, authorization_servers: [AS] });
      if (url === `${AS}/.well-known/oauth-authorization-server`) return json({ authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, registration_endpoint: `${AS}/register` });
      if (url === `${AS}/register`) return json({ client_id: 'conf-client', client_secret: 'shhh-secret' }, 201); // confidential!
      if (url === `${AS}/token`) {
        // Reject unless the secret is present (mirrors Supabase's 422).
        if (!String(init?.body).includes('client_secret=shhh-secret')) {
          return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Required parameter: client_secret' }), { status: 422, headers: { 'content-type': 'application/json' } });
        }
        return json({ access_token: 'ok', token_type: 'Bearer' });
      }
      return new Response('nf', { status: 404 });
    }) as unknown as typeof fetch;

    const svc = new McpOAuthService({ fetchImpl });
    const authorizeUrl = await svc.beginAuthorization({
      serverId: 'srv1', serverUrl: SERVER, workspaceId: 'ws', userId: 'u',
      origin: 'https://app.test', redirectUri: 'https://api.test/v1/mcp-oauth/callback', allowPrivateNetwork: true,
    });
    const state = new URL(authorizeUrl).searchParams.get('state')!;
    const entry = svc.consumeState(state)!;
    const tokens = await svc.exchangeCode(entry, 'code-1');
    expect(tokens.accessToken).toBe('ok');
    expect(calls.find((c) => c.url === `${AS}/token`)?.body).toContain('client_secret=shhh-secret');
  });

  it('surfaces a non-standard token error body (Supabase/GoTrue msg) instead of a bare status', async () => {
    const svc = new McpOAuthService({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/token')) return new Response(JSON.stringify({ code: 422, msg: 'Required parameter: client_secret' }), { status: 422, headers: { 'content-type': 'application/json' } });
        return new Response('nf', { status: 404 });
      }) as unknown as typeof fetch,
    });
    const fakeEntry = {
      serverId: 's', workspaceId: 'w', userId: 'u', origin: 'o', codeVerifier: 'v', clientId: 'c',
      tokenEndpoint: `${AS}/token`, resource: SERVER, redirectUri: 'r', allowPrivateNetwork: true, createdAt: Date.now(),
    };
    await expect(svc.exchangeCode(fakeEntry as never, 'code')).rejects.toThrow(/Required parameter: client_secret/);
  });
});
