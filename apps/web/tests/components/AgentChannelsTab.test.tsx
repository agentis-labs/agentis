/**
 * AgentChannelsTab — provider cards + WhatsApp QR flow
 * (OMNICHANNEL-ORCHESTRATOR-10X §3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentChannelsTab } from '../../src/components/agents/AgentChannelsTab';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('<AgentChannelsTab />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders all four provider cards', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ connections: [] })));
    render(<AgentChannelsTab agentId="a1" agentName="Orchestrator" />);
    await waitFor(() => expect(screen.getByText('Telegram')).toBeInTheDocument());
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(screen.getByText('Discord')).toBeInTheDocument();
  });

  it('WhatsApp connect creates a connection then shows a QR to scan', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (url === '/v1/channels' && method === 'GET') return jsonResponse({ connections: [] });
      if (url === '/v1/channels' && method === 'POST') return jsonResponse({ connection: { id: 'c1', kind: 'whatsapp' } }, 201);
      if (url === '/v1/channels/c1/login' && method === 'POST') {
        return jsonResponse({ connectionId: 'c1', status: 'qr', qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
      }
      if (url === '/v1/channels/c1/login' && method === 'GET') return jsonResponse({ connectionId: 'c1', status: 'qr' });
      return jsonResponse({});
    }));

    render(<AgentChannelsTab agentId="a1" agentName="Orchestrator" />);
    await waitFor(() => expect(screen.getByText('WhatsApp')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Connect WhatsApp/i }));

    // QR image appears + linked-devices instruction.
    await waitFor(() => expect(screen.getByAltText(/WhatsApp login QR/i)).toBeInTheDocument());
    expect(screen.getByText(/Linked Devices/i)).toBeInTheDocument();

    // It created the connection (no token) then started a login.
    expect(calls.some((c) => c.url === '/v1/channels' && c.method === 'POST')).toBe(true);
    expect(calls.some((c) => c.url === '/v1/channels/c1/login' && c.method === 'POST')).toBe(true);
  });

  it('Telegram shows a token form with a long-polling toggle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ connections: [] })));
    render(<AgentChannelsTab agentId="a1" agentName="Orchestrator" />);
    await waitFor(() => expect(screen.getByText('Telegram')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Connect Telegram/i }));
    expect(screen.getByText(/long-polling/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Paste the bot token/i)).toBeInTheDocument();
  });
});
