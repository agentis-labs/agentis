import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppsPage } from '../../src/pages/AppsPage';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function appRecord() {
  return {
    id: 'app-1',
    workspaceId: 'ws-1',
    slug: 'store-desk',
    name: 'Store desk',
    description: 'Interface, logic, data, and memory in one App.',
    version: '0.1.0',
    status: 'draft',
    entrySurfaceId: null,
    icon: null,
    manifest: { slug: 'store-desk', name: 'Store desk', version: '0.1.0', capabilities: [], requiredPlugins: [] },
    policy: { customCode: 'disabled', grants: [] },
    source: null,
    installedChecksum: null,
    createdBy: 'u-1',
    createdAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:00.000Z',
  };
}

describe('<AppsPage />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens App engine settings from a card without navigating into the app', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';

      if (path === '/v1/apps' && method === 'GET') return jsonResponse({ data: [appRecord()] });
      if (path === '/v1/workflows' && method === 'GET') return jsonResponse({ workflows: [] });
      if (path === '/v1/domains' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/agents' && method === 'GET') return jsonResponse({ agents: [] });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [] });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/apps']}>
        <AppsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Store desk' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'App engine Store desk' }));

    expect(screen.getByRole('dialog', { name: 'App engine' })).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/v1/apps/app-1/surfaces', expect.anything());
  });
});
