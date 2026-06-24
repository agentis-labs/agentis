/**
 * McpToolBridge — Phase 2/3A. Verifies the bridge resolves workspace-registered
 * MCP servers + an env-configured built-in computer-use server, lists their
 * tools under namespaced ids, and routes calls to the right server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpToolBridge, computerUseServerFromEnv, type McpClientLike } from '../../src/services/mcpToolBridge.js';
import { saveMcpServers } from '../../src/services/mcpServerStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.close();
});

/** A fake MCP client whose tools + call behavior are scripted per URL. */
function fakeClientFactory(byUrl: Record<string, { tools: Array<{ name: string; description?: string }>; onCall?: (name: string, args: Record<string, unknown>) => { content: unknown; isError: boolean } }>) {
  const calls: Array<{ url: string; name: string; args: Record<string, unknown> }> = [];
  const factory = (url: string): McpClientLike => ({
    async listTools() {
      return byUrl[url]?.tools ?? [];
    },
    async callTool(name, args) {
      calls.push({ url, name, args });
      return byUrl[url]?.onCall?.(name, args) ?? { content: { ok: true, name, args }, isError: false };
    },
  });
  return { factory, calls };
}

describe('McpToolBridge', () => {
  it('lists registered-server tools under namespaced ids and calls the right server', async () => {
    saveMcpServers(ctx.db, ctx.workspace.id, [
      { id: 's1', name: 'Acme Tools', url: 'https://acme.example/mcp', createdAt: new Date().toISOString() },
    ]);
    const { factory, calls } = fakeClientFactory({
      'https://acme.example/mcp': { tools: [{ name: 'do_thing', description: 'Does a thing' }] },
    });
    const bridge = new McpToolBridge({ db: ctx.db, logger: ctx.logger, allowPrivateNetwork: true, clientFactory: factory });

    const tools = await bridge.listTools(ctx.workspace.id);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.id).toBe('mcp__acme_tools__do_thing');
    expect(tools[0]!.serverName).toBe('Acme Tools');

    const res = await bridge.call(ctx.workspace.id, 'mcp__acme_tools__do_thing', { a: 1 });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([{ url: 'https://acme.example/mcp', name: 'do_thing', args: { a: 1 } }]);
  });

  it('mounts the env-configured computer-use server tagged with the computerUse affordance', async () => {
    const { factory } = fakeClientFactory({
      'https://localhost:9999/mcp': { tools: [{ name: 'screenshot', description: 'Capture the screen' }, { name: 'click' }] },
    });
    const bridge = new McpToolBridge({
      db: ctx.db,
      logger: ctx.logger,
      clientFactory: factory,
      computerUse: { url: 'https://localhost:9999/mcp', allowPrivateNetwork: true },
    });

    const tools = await bridge.listTools(ctx.workspace.id);
    expect(tools.map((t) => t.id)).toEqual(['mcp__computer_use__screenshot', 'mcp__computer_use__click']);
    expect(tools.every((t) => t.provides === 'computerUse')).toBe(true);
  });

  it('surfaces a tool error as ok:false', async () => {
    saveMcpServers(ctx.db, ctx.workspace.id, [
      { id: 's1', name: 'Flaky', url: 'https://flaky.example/mcp', createdAt: new Date().toISOString() },
    ]);
    const { factory } = fakeClientFactory({
      'https://flaky.example/mcp': {
        tools: [{ name: 'boom' }],
        onCall: () => ({ content: 'kaboom', isError: true }),
      },
    });
    const bridge = new McpToolBridge({ db: ctx.db, logger: ctx.logger, allowPrivateNetwork: true, clientFactory: factory });

    const res = await bridge.call(ctx.workspace.id, 'mcp__flaky__boom', {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('kaboom');
  });

  it('returns an actionable error for an unknown tool id', async () => {
    const bridge = new McpToolBridge({ db: ctx.db, logger: ctx.logger });
    const res = await bridge.call(ctx.workspace.id, 'mcp__nope__nada', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not available/);
  });
});

describe('computerUseServerFromEnv', () => {
  it('parses url + headers + private flag', () => {
    const cfg = computerUseServerFromEnv({
      AGENTIS_COMPUTER_USE_MCP_URL: 'https://host/mcp',
      AGENTIS_COMPUTER_USE_MCP_HEADERS: '{"authorization":"Bearer x"}',
      AGENTIS_COMPUTER_USE_MCP_ALLOW_PRIVATE: 'true',
    });
    expect(cfg).toEqual({ url: 'https://host/mcp', headers: { authorization: 'Bearer x' }, allowPrivateNetwork: true });
  });

  it('returns undefined when no url is set', () => {
    expect(computerUseServerFromEnv({})).toBeUndefined();
  });
});
