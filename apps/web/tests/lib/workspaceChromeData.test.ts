import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('workspaceChromeData', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.setItem('agentis.workspace', 'ws-chrome');
  });

  it('refreshes shell chrome from the compact dashboard endpoint only', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          workspaceId: 'ws-chrome',
          approvals: [],
          fleet: {
            runs: { active: 1, total: 4 },
            gateways: { total: 2, connected: 1 },
            approvals: { pending: 0 },
          },
          latestActivity: { id: 'evt_1', summary: 'Agent checked in', createdAt: '2026-07-09T00:00:00.000Z' },
          notifications: [],
          counts: { liveAgents: 3, activeRuns: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getWorkspaceChromeSnapshot, refreshWorkspaceChromeSnapshot } = await import('../../src/lib/workspaceChromeData');
    await refreshWorkspaceChromeSnapshot();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/dashboard/chrome');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Headers).get('x-agentis-workspace')).toBe('ws-chrome');
    expect(getWorkspaceChromeSnapshot()).toMatchObject({
      workspaceId: 'ws-chrome',
      loading: false,
      counts: { liveAgents: 3, activeRuns: 2 },
      latestActivity: { summary: 'Agent checked in' },
    });
  });
});
