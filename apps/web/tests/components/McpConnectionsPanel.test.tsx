import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { McpConnectionsPanel } from '../../src/components/settings/McpConnectionsPanel';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('<McpConnectionsPanel />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  it('lists external servers and the Agentis expose endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/v1/mcp-servers')) return jsonResponse({ servers: [{ id: 's1', name: 'context7', url: 'https://mcp.ctx.dev/rpc', headerKeys: [], createdAt: 'now' }] });
      if (path.includes('/v1/mcp/server-card')) return jsonResponse({ protocolVersion: '1', serverInfo: { name: 'agentis', version: '1.0.0' }, toolCount: 5, endpoint: '/v1/mcp/rpc' });
      return jsonResponse({});
    }));

    render(<McpConnectionsPanel />);

    await waitFor(() => expect(screen.getByText('context7')).toBeInTheDocument());
    expect(screen.getByText('External MCP servers')).toBeInTheDocument();
    // Expose endpoints surfaced for external agents.
    expect(screen.getByText('/v1/mcp/rpc')).toBeInTheDocument();
    expect(screen.getByText('/v1/a2a/agent-card.json')).toBeInTheDocument();
    expect(screen.getByText(/5 tools exposed/i)).toBeInTheDocument();
  });

  it('adds a server through the inline form', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, method: init?.method });
      if (path.includes('/v1/mcp-servers') && init?.method === 'POST') return jsonResponse({ server: { id: 's2', name: 'gh', url: 'https://gh/rpc', headerKeys: [], createdAt: 'now' } }, 201);
      if (path.includes('/v1/mcp-servers')) return jsonResponse({ servers: [] });
      if (path.includes('/v1/mcp/server-card')) return jsonResponse({ protocolVersion: '1', serverInfo: { name: 'agentis', version: '1.0.0' }, toolCount: 0, endpoint: '/v1/mcp/rpc' });
      return jsonResponse({});
    }));

    render(<McpConnectionsPanel />);
    await waitFor(() => expect(screen.getByText('External MCP servers')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /add mcp server/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'gh' } });
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://gh/rpc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mount server' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.includes('/v1/mcp-servers'))).toBe(true));
  });

  it('filters the quick-connect catalog by name/category/description (INTEGRATION-CEILING-10X §4)', async () => {
    const bigCatalog = Array.from({ length: 8 }, (_, i) => ({
      id: `svc${i}`, name: `Service${i}`, category: i === 3 ? 'Payments' : 'Other',
      url: `https://svc${i}.example/mcp`, authType: 'none' as const, authHint: 'no auth', description: `desc ${i}`,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/v1/mcp-servers/catalog')) return jsonResponse({ catalog: bigCatalog });
      if (path.includes('/v1/mcp-servers')) return jsonResponse({ servers: [] });
      if (path.includes('/v1/mcp/server-card')) return jsonResponse({ protocolVersion: '1', serverInfo: { name: 'agentis', version: '1.0.0' }, toolCount: 0, endpoint: '/v1/mcp/rpc' });
      return jsonResponse({});
    }));

    render(<McpConnectionsPanel />);
    await waitFor(() => expect(screen.getByText('Service0')).toBeInTheDocument());
    // With >6 entries, a filter box appears.
    const filterInput = screen.getByPlaceholderText('Filter…');
    expect(screen.getByText('Service7')).toBeInTheDocument();

    fireEvent.change(filterInput, { target: { value: 'payments' } });
    await waitFor(() => {
      expect(screen.getByText('Service3')).toBeInTheDocument();
      expect(screen.queryByText('Service0')).not.toBeInTheDocument();
    });

    fireEvent.change(filterInput, { target: { value: 'no-such-server' } });
    await waitFor(() => expect(screen.getByText(/No servers match/i)).toBeInTheDocument());
  });
});
