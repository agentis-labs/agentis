/**
 * McpClient — Agentis as an MCP consumer (Pillar 5, consume half).
 * Drives a fake Streamable-HTTP MCP server via an injected fetch, covering
 * JSON + SSE response framing, tools/list, tools/call, and SSRF refusal.
 */
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../src/services/mcpClient.js';

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
});
