/**
 * MCP CAPABILITY PLANE — secrets plane (S1).
 *
 * A mounted MCP server registered with a vault `credentialId` gets its headers
 * resolved at call time: a JSON credential becomes headers verbatim; a bare
 * token becomes `Authorization: Bearer`. Failures degrade with a NAMED error
 * (never a throw) so one bad credential cannot take the whole bridge down.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { CredentialVault } from '../../src/services/credentialVault.js';
import { McpToolBridge } from '../../src/services/mcpToolBridge.js';
import { resolveMcpServerHeaders, saveMcpServers, type McpServerConfig } from '../../src/services/mcpServerStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('resolveMcpServerHeaders', () => {
  it('JSON credential → headers verbatim; bare token → Bearer; missing → named error; inline headers merge', () => {
    const vault = new CredentialVault(ctx.secrets.credentialKeyB64);
    const now = new Date().toISOString();
    const jsonCredId = randomUUID();
    const tokenCredId = randomUUID();
    ctx.db.insert(schema.credentials).values([
      { id: jsonCredId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'supabase headers', credentialType: 'mcp_headers', encryptedValue: vault.encrypt(JSON.stringify({ apikey: 'svc_key', Authorization: 'Bearer svc_key' })), createdAt: now, updatedAt: now },
      { id: tokenCredId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'linear token', credentialType: 'mcp_token', encryptedValue: vault.encrypt('lin_secret_token'), createdAt: now, updatedAt: now },
    ]).run();

    const base = { id: 'srv', name: 's', url: 'https://x', createdAt: now } as McpServerConfig;

    const json = resolveMcpServerHeaders(ctx.db, vault, ctx.workspace.id, { ...base, credentialId: jsonCredId });
    expect(json.credentialError).toBeUndefined();
    expect(json.headers).toMatchObject({ apikey: 'svc_key', Authorization: 'Bearer svc_key' });

    const token = resolveMcpServerHeaders(ctx.db, vault, ctx.workspace.id, { ...base, credentialId: tokenCredId });
    expect(token.headers.Authorization).toBe('Bearer lin_secret_token');

    // Inline headers still apply and merge under the credential (vault wins).
    const merged = resolveMcpServerHeaders(ctx.db, vault, ctx.workspace.id, {
      ...base, credentialId: jsonCredId, headers: { 'x-extra': '1', apikey: 'stale_inline' },
    });
    expect(merged.headers['x-extra']).toBe('1');
    expect(merged.headers.apikey).toBe('svc_key');

    // Unknown credential degrades with a NAMED error, never a throw.
    const missing = resolveMcpServerHeaders(ctx.db, vault, ctx.workspace.id, { ...base, credentialId: randomUUID() });
    expect(missing.credentialError).toMatch(/not found/);
    // No credentialId at all → inline headers pass through untouched.
    const plain = resolveMcpServerHeaders(ctx.db, vault, ctx.workspace.id, { ...base, headers: { apikey: 'inline' } });
    expect(plain).toEqual({ headers: { apikey: 'inline' } });
  });

  it('an OAuth token BUNDLE resolves to a Bearer header (never leaks bundle fields as headers)', () => {
    const vault = new CredentialVault(ctx.secrets.credentialKeyB64);
    const now = new Date().toISOString();
    const oauthCredId = randomUUID();
    ctx.db.insert(schema.credentials).values({
      id: oauthCredId, workspaceId: ctx.workspace.id, userId: ctx.user.id,
      name: 'supabase (me@x) — supabase', credentialType: 'oauth_supabase',
      encryptedValue: vault.encrypt(JSON.stringify({ accessToken: 'oauth_at_123', refreshToken: 'rt_456', account: 'me@x' })),
      createdAt: now, updatedAt: now,
    }).run();
    const base = { id: 'srv', name: 's', url: 'https://x', createdAt: now } as McpServerConfig;
    const resolved = resolveMcpServerHeaders(ctx.db, vault, ctx.workspace.id, { ...base, credentialId: oauthCredId });
    expect(resolved.credentialError).toBeUndefined();
    expect(resolved.headers.Authorization).toBe('Bearer oauth_at_123');
    expect(resolved.headers.refreshToken).toBeUndefined(); // bundle fields never become headers
    expect(resolved.headers.account).toBeUndefined();
  });
});

describe('McpToolBridge — per-tool allowlist (least privilege)', () => {
  it('lists ONLY allowlisted tools and refuses calls to hidden ones', async () => {
    const server: McpServerConfig = {
      id: randomUUID(), name: 'supabase', url: 'https://mcp.supabase.test',
      allowedTools: ['insert_row'], createdAt: new Date().toISOString(),
    };
    saveMcpServers(ctx.db, ctx.workspace.id, [server]);
    const bridge = new McpToolBridge({
      db: ctx.db,
      logger: ctx.logger,
      clientFactory: () => ({
        listTools: async () => [
          { name: 'insert_row', description: 'ok' },
          { name: 'delete_table', description: 'dangerous' },
        ],
        callTool: async () => ({ content: { ok: true }, isError: false }),
      }),
    });

    const tools = await bridge.listTools(ctx.workspace.id);
    expect(tools.map((t) => t.toolName)).toEqual(['insert_row']);

    // The hidden tool simply does not exist for this workspace.
    const blocked = await bridge.call(ctx.workspace.id, 'mcp__supabase__delete_table', {});
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/not available/);

    const allowed = await bridge.call(ctx.workspace.id, 'mcp__supabase__insert_row', {});
    expect(allowed.ok).toBe(true);
  });
});
