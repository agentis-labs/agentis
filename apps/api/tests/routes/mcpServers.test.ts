/**
 * /v1/mcp-servers — external MCP server registry (Pillar 5, consume half).
 * Covers register/list/delete + header redaction + not-found. Live transport
 * is covered by mcpClient.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpServerRoutes } from '../../src/routes/mcpServers.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/mcp-servers', app: buildMcpServerRoutes({ db: ctx.db, auth: ctx.auth }) }]);
}

describe('/v1/mcp-servers', () => {
  it('registers, lists (redacting header values), and deletes a server', async () => {
    const a = app();

    const create = await a.request('/v1/mcp-servers', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'context7', url: 'https://mcp.example.com', headers: { authorization: 'Bearer secret' } }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { server: { id: string; headerKeys: string[]; headers?: unknown } };
    expect(created.server.headerKeys).toEqual(['authorization']);
    expect(created.server.headers).toBeUndefined();
    const id = created.server.id;

    const list = await a.request('/v1/mcp-servers', { headers: ctx.authHeaders });
    const servers = (await list.json() as { servers: Array<{ id: string; name: string; headers?: unknown }> }).servers;
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe('context7');
    expect(servers[0]!.headers).toBeUndefined(); // secret not leaked

    const del = await a.request(`/v1/mcp-servers/${id}`, { method: 'DELETE', headers: ctx.authHeaders });
    expect(del.status).toBe(200);
    const after = await a.request('/v1/mcp-servers', { headers: ctx.authHeaders });
    expect((await after.json() as { servers: unknown[] }).servers).toHaveLength(0);
  });

  it('rejects duplicate names and missing fields', async () => {
    const a = app();
    await a.request('/v1/mcp-servers', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ name: 'dup', url: 'https://x.example.com' }) });
    const dup = await a.request('/v1/mcp-servers', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ name: 'dup', url: 'https://y.example.com' }) });
    expect(dup.status).toBe(409);
    const missing = await a.request('/v1/mcp-servers', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ name: 'noUrl' }) });
    expect(missing.status).toBe(422); // VALIDATION_FAILED
  });

  it('404s tools/call for an unknown server id', async () => {
    const res = await app().request('/v1/mcp-servers/nope/call', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ tool: 'x' }) });
    expect(res.status).toBe(404);
  });

  it('serves the pre-defined mount catalog (Supabase et al. with url + auth shape)', async () => {
    const res = await app().request('/v1/mcp-servers/catalog', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const { catalog } = (await res.json()) as { catalog: Array<{ id: string; url: string; authType: string; connectorService?: string }> };
    const supabase = catalog.find((e) => e.id === 'supabase');
    expect(supabase).toBeTruthy();
    expect(supabase!.url).toMatch(/^https:\/\//);
    expect(supabase!.connectorService).toBe('supabase');
    expect(['none', 'oauth', 'token', 'header']).toContain(supabase!.authType);
  });

  it('verify returns ok:false with the real error for an unreachable mount (never a false success)', async () => {
    const a = app();
    const create = await a.request('/v1/mcp-servers', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'dead', url: 'https://mcp.unreachable.invalid/rpc', allowPrivateNetwork: true }),
    });
    const id = ((await create.json()) as { server: { id: string } }).server.id;
    const verify = await a.request(`/v1/mcp-servers/${id}/verify`, { method: 'POST', headers: ctx.authHeaders });
    expect(verify.status).toBe(200); // reachable-but-failing is a UI state, not an HTTP error
    const body = (await verify.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it('mounts with credentialId + allowedTools, PATCHes governance, and enforces the allowlist on REST calls', async () => {
    const a = app();
    const create = await a.request('/v1/mcp-servers', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'supabase', url: 'https://mcp.supabase.test', credentialId: 'cred-1', allowedTools: ['insert_row', 'insert_row', ''] }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { server: { id: string; credentialId?: string; allowedTools?: string[] } };
    expect(created.server.credentialId).toBe('cred-1');
    expect(created.server.allowedTools).toEqual(['insert_row']); // deduped, blanks dropped
    const id = created.server.id;

    // A call to a tool OFF the allowlist is refused before any network I/O.
    const blocked = await a.request(`/v1/mcp-servers/${id}/call`, {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ tool: 'delete_table' }),
    });
    expect(blocked.status).toBe(422);
    expect(JSON.stringify(await blocked.json())).toMatch(/allowlist/);

    // PATCH: clear the allowlist and the credential.
    const patch = await a.request(`/v1/mcp-servers/${id}`, {
      method: 'PATCH', headers: ctx.authHeaders,
      body: JSON.stringify({ allowedTools: null, credentialId: null }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { server: { credentialId?: string; allowedTools?: string[] } };
    expect(patched.server.allowedTools).toBeUndefined(); // cleared = all tools
    expect(patched.server.credentialId).toBeUndefined();

    const patch404 = await a.request('/v1/mcp-servers/nope', { method: 'PATCH', headers: ctx.authHeaders, body: JSON.stringify({}) });
    expect(patch404.status).toBe(404);
  });
});
