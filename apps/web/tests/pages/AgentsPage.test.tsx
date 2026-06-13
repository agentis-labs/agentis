/**
 * AgentsPage — RTL component test (Batch 5 / D36).
 *
 * Stubs `fetch` to return agents, asserts the canvas-first page renders,
 * the table fallback still works, and the commissioning drawer opens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders the empty state when /v1/agents returns no agents', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      return jsonResponse({ agents: [] });
    }));
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(/No agents yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/0 agents/i)).toBeInTheDocument();
  });

  it('defaults to the hierarchy canvas and keeps the table fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        return jsonResponse({
          agents: [
            {
              id: 'a1',
              name: 'Hermes',
              description: 'Research manager',
              adapterType: 'http',
              runtimeModel: null,
              role: 'manager',
              reportsTo: null,
              capabilityTags: ['research', 'reply'],
              status: 'online',
              colorHex: '#7ad1ff',
              gatewayId: null,
              lastHeartbeatAt: null,
              currentTaskId: null,
            },
          ],
        });
      }),
    );
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Hermes')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^All$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Fleet map/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Managers$/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Table view/i }));
    expect(screen.getByText(/(HTTP|No harness)/i)).toBeInTheDocument();
    expect(screen.getByText(/1 agent/i)).toBeInTheDocument();
  });

  it('opens the agent quick-detail panel when a fleet card is clicked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/v1/channels') return jsonResponse({ connections: [] });
        return jsonResponse({
          agents: [
            {
              id: 'a1',
              name: 'Hermes',
              description: 'Research manager',
              adapterType: 'http',
              runtimeModel: 'gpt-4.1',
              role: 'manager',
              status: 'online',
              colorHex: '#7ad1ff',
              currentTaskId: null,
              runsToday: 3,
              spendTodayCents: 125,
              pendingApprovals: 1,
              connectionCounts: { workflows: 1, memoryLayers: 1 },
            },
          ],
        });
      }),
    );

    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Hermes')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Hermes'));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Open agent$/i })).toBeInTheDocument();
    expect(screen.getByText(/Live status/i)).toBeInTheDocument();
  });

  it('resets the canvas layout and persists the fallback positions', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/v1/agents/a1' && init?.method === 'PATCH') return jsonResponse({ ok: true });
      return jsonResponse({
        agents: [
          {
            id: 'a1',
            name: 'Hermes',
            description: 'Research manager',
            adapterType: 'http',
            runtimeModel: 'gpt-4.1',
            role: 'manager',
            status: 'online',
            colorHex: '#7ad1ff',
            canvasPosition: { x: 999, y: 999 },
            runsToday: 1,
            spendTodayCents: 50,
            pendingApprovals: 0,
            connectionCounts: { workflows: 0, memoryLayers: 0 },
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Hermes')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Reset layout/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/v1/agents/a1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ canvasPosition: { x: 0, y: 300 } }),
        }),
      );
    });
  });

  it('reparents managers to the current orchestrator when roles change', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/v1/agents/mgr' && init?.method === 'PATCH') return jsonResponse({ ok: true });
      return jsonResponse({
        agents: [
          {
            id: 'orch',
            name: 'The Brain',
            adapterType: 'codex',
            role: 'orchestrator',
            status: 'online',
          },
          {
            id: 'mgr',
            name: 'Social Analyst',
            adapterType: 'http',
            role: 'manager',
            reportsTo: 'old-orchestrator',
            status: 'online',
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Social Analyst')).toBeInTheDocument());
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/v1/agents/mgr',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ reportsTo: 'orch' }),
        }),
      );
    });
  });

  it('clears stale manager parents when there is no orchestrator', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/v1/agents/mgr' && init?.method === 'PATCH') return jsonResponse({ ok: true });
      return jsonResponse({
        agents: [
          {
            id: 'mgr',
            name: 'Social Analyst',
            adapterType: 'http',
            role: 'manager',
            reportsTo: 'old-orchestrator',
            status: 'online',
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Social Analyst')).toBeInTheDocument());
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/v1/agents/mgr',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ reportsTo: null }),
        }),
      );
    });
  });

  it('opens the commissioning drawer when Add agent is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/v1/adapters/harness-status') return jsonResponse({ adapters: [] });
      return jsonResponse({ agents: [] });
    }));
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/No agents yet/i)).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole('button', { name: /Add agent/i })[0]!);
    expect(screen.getByRole('heading', { name: /Commission agent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Commission agent/i })).toBeInTheDocument();
    expect(screen.getByText(/Name it, give it a runtime/i)).toBeInTheDocument();
  });
});
