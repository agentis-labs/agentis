/**
 * McpClient — Agentis as an MCP consumer (Pillar 5, consume half).
 * Drives a fake Streamable-HTTP MCP server via an injected fetch, covering
 * JSON + SSE response framing, tools/list, tools/call, and SSRF refusal.
 */
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../src/services/mcp/mcpClient.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sseResponse(body: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}

describe('McpClient', () => {
  // allowPrivateNetwork:true makes assertSafeUrl short-circuit before DNS, so
  // the injected fetch is exercised hermetically (no network/DNS in tests).
  it('lists tools from a JSON-responding server', async () => {
    const fetchImpl = (async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search', description: 'web search' }] } })) as unknown as typeof fetch;
    const client = new McpClient('https://example.com/mcp', {}, { allowPrivateNetwork: true, fetchImpl });
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('search');
  });

  it('calls a tool and parses an SSE-framed result', async () => {
    const fetchImpl = (async () => sseResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }], isError: false } })) as unknown as typeof fetch;
    const client = new McpClient('https://example.com/mcp', {}, { allowPrivateNetwork: true, fetchImpl });
    const result = await client.callTool('search', { q: 'agentis' });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('surfaces a JSON-RPC error from the server', async () => {
    const fetchImpl = (async () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } })) as unknown as typeof fetch;
    const client = new McpClient('https://example.com/mcp', {}, { allowPrivateNetwork: true, fetchImpl });
    await expect(client.listTools()).rejects.toThrow(/boom/);
  });

  it('refuses a private/loopback URL unless explicitly allowed', async () => {
    const client = new McpClient('http://127.0.0.1:9/mcp', {}, { allowPrivateNetwork: false });
    await expect(client.listTools()).rejects.toThrow();
  });

  it('establishes a Streamable-HTTP session: initialize → session id → carried on later requests (the Supabase 400 fix)', async () => {
    const calls: Array<{ method: string; sessionHeader: string | null; protoHeader: string | null }> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const msg = JSON.parse(String(init?.body)) as { method: string };
      const headers = new Headers(init?.headers as HeadersInit);
      calls.push({ method: msg.method, sessionHeader: headers.get('mcp-session-id'), protoHeader: headers.get('mcp-protocol-version') });
      if (msg.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'supabase' }, capabilities: {} } }), {
          status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-abc' },
        });
      }
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
      // A real server 400s here if the session id is missing (the reported bug).
      if (!headers.get('mcp-session-id')) return new Response('no session', { status: 400 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'sql', description: 'run sql' }] } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new McpClient('https://mcp.supabase.com/mcp', {}, { allowPrivateNetwork: true, fetchImpl });
    const tools = await client.listTools();
    expect(tools[0]!.name).toBe('sql');

    expect(calls.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(calls[0]!.sessionHeader).toBeNull(); // initialize carries no session yet
    expect(calls[1]!.sessionHeader).toBe('sess-abc'); // initialized notification
    expect(calls[2]!.sessionHeader).toBe('sess-abc'); // tools/list
    expect(calls.every((c) => c.protoHeader === '2025-06-18')).toBe(true);
  });
});
