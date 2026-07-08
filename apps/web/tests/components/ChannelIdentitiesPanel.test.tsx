/**
 * ChannelIdentitiesPanel — cross-surface peer identity (OMNICHANNEL §5.2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelIdentitiesPanel } from '../../src/components/settings/ChannelIdentitiesPanel';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('<ChannelIdentitiesPanel />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('lists senders and links one to the current user', async () => {
    const linkCalls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/v1/auth/me') return jsonResponse({ user: { id: 'u1', displayName: 'Operator' } });
      if (url === '/v1/channels/identities' && method === 'GET') {
        return jsonResponse({ identities: [
          { id: 'i1', channelKind: 'whatsapp', handle: '555@s.whatsapp.net', displayName: 'Bob', userId: null, peerKey: null, messageCount: 3, lastSeenAt: 't' },
        ] });
      }
      if (url === '/v1/channels/identities/link' && method === 'POST') {
        linkCalls.push(JSON.parse(String(init?.body)));
        return jsonResponse({ identity: { id: 'i1' } });
      }
      return jsonResponse({});
    }));

    render(<ChannelIdentitiesPanel />);
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument());
    expect(screen.getByText('whatsapp')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Link to me/i }));
    await waitFor(() => expect(linkCalls).toHaveLength(1));
    expect(linkCalls[0]).toMatchObject({ channelKind: 'whatsapp', handle: '555@s.whatsapp.net', userId: 'u1' });
  });

  it('shows an empty state when there are no senders', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/v1/auth/me') return jsonResponse({ user: { id: 'u1' } });
      return jsonResponse({ identities: [] });
    }));
    render(<ChannelIdentitiesPanel />);
    await waitFor(() => expect(screen.getByText(/No channel senders yet/i)).toBeInTheDocument());
  });
});
