/**
 * AgentsPage — RTL component test (Batch 5 / D36).
 *
 * Stubs `fetch` to return a couple of agents, asserts the table renders
 * them and that the "+ Register" button opens the inline drawer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AgentsPage } from '../../src/pages/AgentsPage';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('<AgentsPage />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders the empty-state row when /v1/agents returns no agents', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ agents: [] })));
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/No agents yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/0 registered/i)).toBeInTheDocument();
  });

  it('lists agents from /v1/agents in a table', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          agents: [
            {
              id: 'a1',
              name: 'Hermes',
              adapterType: 'http',
              capabilityTags: ['research', 'reply'],
              status: 'online',
              colorHex: '#7ad1ff',
              gatewayId: null,
              lastHeartbeatAt: null,
              currentTaskId: null,
            },
          ],
        }),
      ),
    );
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Hermes')).toBeInTheDocument());
    expect(screen.getByText(/research, reply/i)).toBeInTheDocument();
    expect(screen.getByText(/1 registered/i)).toBeInTheDocument();
  });

  it('opens the register drawer when "+ Register" is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ agents: [] })));
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: /\+ Register/i }));
    expect(screen.getByText(/Register agent/i)).toBeInTheDocument();
  });
});
