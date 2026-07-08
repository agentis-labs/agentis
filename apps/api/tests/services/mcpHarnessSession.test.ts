/**
 * McpHarnessSession — wiring a CLI harness to Agentis's own MCP server so it
 * runs its own tool loop natively (no marker-protocol re-spawn). Zero-config:
 * URL auto-derived (loopback), token auto-minted, on by default.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { McpHarnessSessionService, harnessMcpArgs, type McpHarnessServer } from '../../src/services/mcp/mcpHarnessSession.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('McpHarnessSessionService', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('is enabled only with a URL, and never without a userId', () => {
    expect(new McpHarnessSessionService({ db: ctx.db, enabled: false, publicUrl: 'http://x' }).enabled).toBe(false);
    expect(new McpHarnessSessionService({ db: ctx.db, enabled: true, publicUrl: '' }).enabled).toBe(false);
    const svc = new McpHarnessSessionService({ db: ctx.db, enabled: true, publicUrl: 'http://x' });
    expect(svc.enabled).toBe(true);
    expect(svc.forWorkspace(ctx.workspace.id)).toBeNull(); // no userId → no token
  });

  it('auto-mints a workspace-scoped key and builds the MCP descriptor (zero-config token)', () => {
    const svc = new McpHarnessSessionService({ db: ctx.db, enabled: true, publicUrl: 'http://127.0.0.1:8787/' });
    const server = svc.forWorkspace(ctx.workspace.id, 'amb_1', ctx.user.id, 'agent_1');
    expect(server?.url).toBe('http://127.0.0.1:8787/v1/mcp/rpc');
    expect(server?.headers['x-agentis-workspace']).toBe(ctx.workspace.id);
    expect(server?.headers['x-agentis-agent']).toBe('agent_1');
    expect(server?.headers.authorization).toMatch(/^Bearer agt_/);

    // A real, hashed API key row was persisted (plaintext never stored).
    const key = ctx.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.workspaceId, ctx.workspace.id)).get();
    expect(key?.name).toContain('Harness MCP');
    expect(key?.userId).toBe(ctx.user.id);
    expect(key?.keyHash).not.toContain('agt_'); // it's a hash, not the secret

    // Token is stable for the process (cached) — same descriptor on re-ask.
    const again = svc.forWorkspace(ctx.workspace.id, null, ctx.user.id);
    expect(again?.headers.authorization).toBe(server?.headers.authorization);
  });

  it('is ON by default and auto-derives a loopback URL (no env values required)', () => {
    const svc = McpHarnessSessionService.fromEnv({ AGENTIS_HTTP_PORT: '9999' } as unknown as NodeJS.ProcessEnv, ctx.db);
    expect(svc.enabled).toBe(true);
    expect(svc.forWorkspace(ctx.workspace.id, null, ctx.user.id)?.url).toBe('http://127.0.0.1:9999/v1/mcp/rpc');
  });

  it('opts out only when explicitly disabled', () => {
    const svc = McpHarnessSessionService.fromEnv({ AGENTIS_HARNESS_MCP: 'false' } as unknown as NodeJS.ProcessEnv, ctx.db);
    expect(svc.enabled).toBe(false);
  });
});

describe('harnessMcpArgs', () => {
  const server: McpHarnessServer = {
    name: 'agentis',
    url: 'https://a/v1/mcp/rpc',
    headers: { authorization: 'Bearer k', 'x-agentis-workspace': 'ws_1' },
  };

  it('emits an inline streamable-HTTP --mcp-config for Claude Code', () => {
    const args = harnessMcpArgs('claude_code', [server]);
    expect(args[0]).toBe('--strict-mcp-config');
    expect(args[1]).toBe('--mcp-config');
    expect(JSON.parse(args[2]!)).toEqual({
      mcpServers: { agentis: { type: 'http', url: 'https://a/v1/mcp/rpc', headers: server.headers } },
    });
  });

  it('bridges the remote endpoint via the local Agentis stdio proxy for Codex (-c TOML overrides)', () => {
    const args = harnessMcpArgs('codex', [server]);
    expect(args.some((arg) => arg.startsWith('mcp_servers.agentis.command='))).toBe(true);
    const argsLine = args.find((a) => a.startsWith('mcp_servers.agentis.args='));
    expect(argsLine).toContain('agentis-mcp-stdio-bridge.mjs');
    expect(argsLine).toContain('https://a/v1/mcp/rpc');
    expect(argsLine).toContain('authorization: Bearer k');
    expect(argsLine).toContain('x-agentis-workspace: ws_1');
  });

  it('is a no-op for non-CLI adapters / empty servers', () => {
    expect(harnessMcpArgs('http', [server])).toEqual([]);
    expect(harnessMcpArgs('codex', [])).toEqual([]);
  });
});
