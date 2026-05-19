import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from '../../src/pages/HomePage';
import { WorkspaceEcosystemCanvas } from '../../src/components/home/WorkspaceEcosystemCanvas';
import { useChatPanelStore } from '../../src/components/chat/ChatPanelStore';

const mocks = vi.hoisted(() => ({
  useWorkspaceData: vi.fn(),
  refreshWorkspaceSnapshot: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock('../../src/lib/workspaceData', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/workspaceData')>('../../src/lib/workspaceData');
  return {
    ...actual,
    useWorkspaceData: mocks.useWorkspaceData,
    refreshWorkspaceSnapshot: mocks.refreshWorkspaceSnapshot,
  };
});

vi.mock('../../src/lib/realtime', () => ({
  useRealtime: vi.fn(),
  rtSubscribe: vi.fn(() => vi.fn()),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function homeSnapshot() {
  return {
    workspaceId: 'ws-1',
    loading: false,
    me: { name: 'Operator' },
    agents: [{ id: 'a1', name: 'Thomas', status: 'online' }],
    approvals: [],
    activeRuns: [],
    failedRuns: [],
    artifacts: [],
    spaces: [],
    fleet: { runs: { active: 0 }, gateways: { total: 1, connected: 1 }, approvals: { pending: 0 } },
    latestActivity: null,
    notifications: [],
    counts: { liveAgents: 1, activeRuns: 0 },
    updatedAt: Date.now(),
  };
}

function stubHomeFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/v1/conversations/orchestrator') {
      return jsonResponse({ agent: { id: 'orch-1', name: 'Workspace Orchestrator', status: 'online' } });
    }
    if (path === '/v1/agents?role=manager') {
      return jsonResponse({ agents: [] });
    }
    if (path === '/v1/apps') return jsonResponse({ apps: [] });
    if (path === '/v1/workflows') return jsonResponse({ workflows: [] });
    if (path === '/v1/knowledge-bases') return jsonResponse({ knowledgeBases: [] });
    if (path.startsWith('/v1/memory/episodes')) return jsonResponse({ episodes: [] });
    if (path.startsWith('/v1/memory')) return jsonResponse({ memory: [] });
    void init;
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function readTranslate3d(element: HTMLElement) {
  const match = element.style.transform.match(/translate3d\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px,\s*0\)/);
  if (!match) throw new Error(`Expected translate3d transform, got "${element.style.transform}"`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

describe('<HomePage />', () => {
  beforeEach(() => {
    useChatPanelStore.getState().setState('hidden');
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
    mocks.useWorkspaceData.mockReturnValue(homeSnapshot());
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    useChatPanelStore.getState().setState('hidden');
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders the workspace canvas as the home surface', async () => {
    const fetchMock = stubHomeFetch();

    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByLabelText(/workspace authority canvas/i)).toBeInTheDocument();
    expect(await screen.findByText('Thomas')).toBeInTheDocument();
    expect(screen.getByLabelText(/message the orchestrator/i)).toBeInTheDocument();
  });
});

describe('<WorkspaceEcosystemCanvas />', () => {
  beforeEach(() => {
    useChatPanelStore.getState().setState('hidden');
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    useChatPanelStore.getState().setState('hidden');
    vi.unstubAllGlobals();
    document.body.classList.remove('agentis-canvas-fullscreen');
  });

  it('maps apps, workflows, agents, knowledge, and recent output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/v1/apps') {
          return jsonResponse({ apps: [{ id: 'app-1', slug: 'newsletter', name: 'Newsletter App', status: 'active', category: 'Marketing' }] });
        }
        if (path === '/v1/workflows') {
          return jsonResponse({ workflows: [{ id: 'wf-1', title: 'Weekly newsletter', status: 'active' }] });
        }
        if (path === '/v1/knowledge-bases') {
          return jsonResponse({ knowledgeBases: [{ id: 'kb-1', name: 'Content Brain' }] });
        }
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter>
        <WorkspaceEcosystemCanvas
          agents={[{ id: 'a1', name: 'Thomas', status: 'online' }]}
          activeRuns={[{ id: 'run-1', workflowId: 'wf-1', workflowName: 'Weekly newsletter', status: 'RUNNING', startedAt: new Date().toISOString() }]}
          artifacts={[{ id: 'art-1', title: 'Newsletter draft', createdAt: new Date().toISOString(), agent: 'Thomas' }]}
          snapshotLoading={false}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Newsletter App')).toBeInTheDocument();
    expect(screen.getAllByText('Weekly newsletter').length).toBeGreaterThan(0);
    expect(screen.getByText('Thomas')).toBeInTheDocument();
    expect(screen.getByText('Content Brain')).toBeInTheDocument();
    expect(screen.getAllByText('Newsletter draft').length).toBeGreaterThan(0);
  });

  it('keeps panning when pointer movement is delivered outside the canvas element', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/v1/apps') return jsonResponse({ apps: [] });
        if (path === '/v1/workflows') return jsonResponse({ workflows: [] });
        if (path === '/v1/knowledge-bases') return jsonResponse({ knowledgeBases: [] });
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter>
        <WorkspaceEcosystemCanvas
          agents={[]}
          activeRuns={[]}
          artifacts={[]}
          snapshotLoading={false}
        />
      </MemoryRouter>,
    );

    const canvas = await screen.findByLabelText(/workspace authority canvas/i);
    const nodeLayer = canvas.querySelector('div[style*="translate3d"]') as HTMLElement | null;
    expect(nodeLayer).not.toBeNull();

    const before = readTranslate3d(nodeLayer!);
    fireEvent.pointerDown(canvas, { pointerId: 9, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 160, clientY: 135 });

    const afterMove = readTranslate3d(nodeLayer!);
    expect(afterMove.x - before.x).toBeCloseTo(60);
    expect(afterMove.y - before.y).toBeCloseTo(35);

    fireEvent.pointerUp(window, { pointerId: 9, clientX: 160, clientY: 135 });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 220, clientY: 180 });
    expect(readTranslate3d(nodeLayer!)).toEqual(afterMove);
  });

  it('turns fullscreen into a focused canvas state without duplicating the live trail controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/v1/apps') return jsonResponse({ apps: [] });
        if (path === '/v1/workflows') return jsonResponse({ workflows: [] });
        if (path === '/v1/knowledge-bases') return jsonResponse({ knowledgeBases: [] });
        return jsonResponse({});
      }),
    );
    const requestFullscreen = vi.fn(async () => undefined);
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    });

    render(
      <MemoryRouter>
        <WorkspaceEcosystemCanvas
          agents={[{ id: 'a1', name: 'Thomas', status: 'online' }]}
          activeRuns={[{ id: 'run-1', workflowId: 'wf-1', workflowName: 'Social Digest', status: 'RUNNING', startedAt: new Date().toISOString() }]}
          approvals={[{ id: 'approval-1', workflowName: 'Lead Review', summary: 'Approve the next outreach email.', createdAt: new Date().toISOString() }]}
          artifacts={[]}
          snapshotLoading={false}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByLabelText(/full screen/i));

    expect(requestFullscreen).toHaveBeenCalled();
    expect(document.body).toHaveClass('agentis-canvas-fullscreen');
    expect(screen.getByText('Workspace Live')).toBeInTheDocument();
    expect(screen.getAllByText('Social Digest').length).toBeGreaterThan(0);
    expect(screen.getByText(/need operator attention/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/open monitor/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/show chat/i)).not.toBeInTheDocument();
  });

  it('hides the canvas composer while the docked chat is open', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/v1/apps') return jsonResponse({ apps: [] });
        if (path === '/v1/workflows') return jsonResponse({ workflows: [] });
        if (path === '/v1/knowledge-bases') return jsonResponse({ knowledgeBases: [] });
        return jsonResponse({});
      });
    vi.stubGlobal('fetch', fetchMock);
    useChatPanelStore.getState().setState('docked');

    render(
      <MemoryRouter>
        <WorkspaceEcosystemCanvas
          agents={[{ id: 'a1', name: 'Thomas', status: 'online' }]}
          activeRuns={[]}
          artifacts={[]}
          snapshotLoading={false}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByLabelText(/message the orchestrator/i)).not.toBeInTheDocument();
  });
});
