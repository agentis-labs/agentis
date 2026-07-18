import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from '../../src/pages/HomePage';
import { WorkspaceEcosystemCanvas, buildCanvasModel } from '../../src/components/home/WorkspaceEcosystemCanvas';
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
    agents: [{ id: 'a1', name: 'Thomas', role: 'manager', status: 'online' }],
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
    expect((await screen.findAllByText('Thomas')).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/message/i)).toBeInTheDocument();
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

  it('keeps the empty workspace scaffold visible and routes resources through space managers', () => {
    const model = buildCanvasModel(
      {
        loading: false,
        workflows: [],
        knowledgeBases: [],
        spaces: [{ id: 'space-1', name: 'Marketing' }],
      },
      [],
      [],
      [],
      [],
      [],
      { width: 1200, height: 760 },
    );

    const orchestrator = model.nodes.find((node) => node.id === 'ghost-orchestrator');
    const manager = model.nodes.find((node) => node.id === 'ghost-manager-0');
    const resource = model.nodes.find((node) => node.id === 'ghost-resource-0');
    const resourceEdge = model.edges.find((edge) => edge.to === resource?.id);

    expect(orchestrator).toBeDefined();
    expect(manager?.title).toBe('Marketing manager');
    expect(resource).toBeDefined();
    expect(resourceEdge?.from).toBe(manager?.id);
  });

  it('anchors manager-owned workflows under their manager and keeps orchestrator-direct workflows right', () => {
    const data: Parameters<typeof buildCanvasModel>[0] = {
      loading: false,
      knowledgeBases: [],
      spaces: [{ id: 'space-hermes', name: 'Hermes', colorHex: '#22d3ee' }],
      workflows: [
        { id: 'wf-1', title: 'Approval Default Digest', status: 'failed', spaceId: 'space-hermes' },
        { id: 'wf-2', title: 'Daily AI News Insights', status: 'idle', spaceId: 'space-hermes' },
        {
          id: 'wf-3',
          title: 'Agent Task Digest',
          status: 'idle',
          spaceId: 'space-hermes',
          graph: {
            nodes: [{ id: 'n1', type: 'agent_task', title: 'Draft', config: { kind: 'agent_task', agentId: 'worker-1' } }],
            edges: [],
          },
        },
        { id: 'wf-4', title: 'Hello World Workflow', status: 'idle', spaceId: 'space-hermes' },
        { id: 'wf-5', title: 'News Site Monitor', status: 'failed', spaceId: 'space-hermes' },
        { id: 'wf-6', title: 'RSS Monitor Cleanup', status: 'idle', spaceId: 'space-hermes' },
        { id: 'wf-7', title: 'Weekly Source Review', status: 'idle', spaceId: 'space-hermes' },
        { id: 'wf-free', title: 'Workspace Cleanup', status: 'idle' },
      ],
    };
    const agents: Parameters<typeof buildCanvasModel>[1] = [
      { id: 'orch-1', name: 'Orchy', role: 'orchestrator', status: 'online' },
      { id: 'mgr-1', name: 'hermes', role: 'manager', status: 'online', spaceId: 'space-hermes', spaceName: 'Hermes' },
      { id: 'worker-1', name: 'Hermes Worker', role: 'worker', status: 'online', reportsTo: 'mgr-1' },
    ];
    const model = buildCanvasModel(data, agents, [], [], [], [], { width: 2000, height: 760 });

    const orchestrator = model.nodes.find((node) => node.id === 'agent-orch-1');
    const hermes = model.nodes.find((node) => node.id === 'agent-mgr-1');
    const managerWorkflowIds = ['wf-1', 'wf-2', 'wf-3', 'wf-4', 'wf-5', 'wf-6', 'wf-7'];
    const visibleManagerWorkflows = managerWorkflowIds
      .map((id) => model.nodes.find((node) => node.id === `workflow-${id}`))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .sort((a, b) => a.x - b.x);
    const unassignedWorkflow = model.nodes.find((node) => node.id === 'workflow-wf-free');
    const bundle = model.nodes.find((node) => node.id === 'workflow-more:manager%3Aagent-mgr-1');

    expect(orchestrator).toBeDefined();
    expect(hermes).toBeDefined();
    // The collapsed band shows a few workflows and tucks the rest behind a
    // "+N more" expander. The exact visible count tracks the lane width, so
    // assert the invariant (everything is accounted for) over a magic number.
    expect(visibleManagerWorkflows.length).toBeGreaterThanOrEqual(2);
    expect(visibleManagerWorkflows.every((node) => node.laneKind === 'manager-workflows')).toBe(true);
    expect(visibleManagerWorkflows.every((node) => node.y > hermes!.y)).toBe(true);
    expect(visibleManagerWorkflows.some((node) => node.warn)).toBe(true);
    expect(new Set(visibleManagerWorkflows.map((node) => Math.round(node.x))).size).toBeGreaterThan(1);
    const hiddenManagerCount = 7 - visibleManagerWorkflows.length;
    expect(bundle?.title).toBe(`+${hiddenManagerCount} more`);
    expect(bundle?.collapsedCount).toBe(hiddenManagerCount);
    expect(bundle?.laneKind).toBe('manager-workflows');
    expect(bundle!.y).toBeGreaterThan(hermes!.y);
    expect(unassignedWorkflow?.laneKind).toBe('orchestrator-workflows');
    expect(unassignedWorkflow!.x).toBeGreaterThan(orchestrator!.x);

    const expandedModel = buildCanvasModel(data, agents, [], [], [], [], { width: 2000, height: 760 }, null, new Set(['manager:agent-mgr-1']));
    const expandedDomainWorkflows = managerWorkflowIds
      .map((id) => expandedModel.nodes.find((node) => node.id === `workflow-${id}`))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    expect(expandedDomainWorkflows).toHaveLength(7);
    expect(expandedDomainWorkflows.every((node) => node.laneKind === 'manager-workflows')).toBe(true);
    expect(new Set(expandedDomainWorkflows.map((node) => Math.round(node.x))).size).toBeGreaterThan(1);
    expect(new Set(expandedDomainWorkflows.map((node) => Math.round(node.y))).size).toBeGreaterThan(1);
    expect(expandedModel.edges.some((edge) => edge.from === hermes!.id && edge.to === 'workflow-wf-3')).toBe(true);

    const selectedManagerModel = buildCanvasModel(data, agents, [], [], [], [], { width: 2000, height: 760 }, hermes!.id);
    const selectedBranchWorkflows = managerWorkflowIds
      .map((id) => selectedManagerModel.nodes.find((node) => node.id === `workflow-${id}`))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    expect(selectedBranchWorkflows).toHaveLength(7);
    expect(selectedBranchWorkflows.every((node) => node.y > hermes!.y)).toBe(true);
    expect(new Set(selectedBranchWorkflows.map((node) => Math.round(node.x))).size).toBeGreaterThan(1);
    expect(new Set(selectedBranchWorkflows.map((node) => Math.round(node.y))).size).toBeGreaterThan(1);

    const resourceNodes = expandedModel.nodes.filter((node) => node.tier >= 3);
    for (let index = 0; index < resourceNodes.length; index += 1) {
      for (let next = index + 1; next < resourceNodes.length; next += 1) {
        const a = resourceNodes[index]!;
        const b = resourceNodes[next]!;
        const hasHorizontalClearance = Math.abs(a.x - b.x) >= (a.width + b.width) / 2 + 24;
        const hasVerticalClearance = Math.abs(a.y - b.y) >= (a.height + b.height) / 2 + 24;
        expect(hasHorizontalClearance || hasVerticalClearance).toBe(true);
      }
    }
  });

  it('packs the orchestrator\'s direct children into a balanced, non-overlapping pyramid', () => {
    const data: Parameters<typeof buildCanvasModel>[0] = {
      loading: false,
      knowledgeBases: [],
      spaces: [
        { id: 'space-coder', name: 'Coder' },
        { id: 'space-hermes', name: 'Hermes' },
      ],
      workflows: [
        { id: 'wf-coder', title: 'Code Review Bot', status: 'idle', spaceId: 'space-coder' },
        { id: 'wf-hermes', title: 'News Digest', status: 'idle', spaceId: 'space-hermes' },
        // A deliberately wide direct-workflows branch — center-out packing must
        // still keep the middle manager (hermes) directly under the orchestrator
        // rather than letting the heavy right branch drag it left.
        { id: 'wf-direct', title: 'Send Hi Alex Email', status: 'idle' },
        { id: 'wf-direct2', title: 'AI News Email Digest', status: 'idle' },
        { id: 'wf-direct3', title: '24/7 Site Monitor', status: 'idle' },
        { id: 'wf-direct4', title: 'Catalog Launch Workflow', status: 'idle' },
      ],
    };
    const agents: Parameters<typeof buildCanvasModel>[1] = [
      { id: 'orch-1', name: 'Orchy', role: 'orchestrator', status: 'online' },
      { id: 'coder', name: 'Coder', role: 'manager', status: 'online', spaceId: 'space-coder', spaceName: 'Coder' },
      { id: 'hermes', name: 'hermes', role: 'manager', status: 'online', spaceId: 'space-hermes', spaceName: 'Hermes' },
    ];
    const width = 2400;
    const model = buildCanvasModel(data, agents, [], [], [], [], { width, height: 760 });

    const orchestrator = model.nodes.find((n) => n.id === 'agent-orch-1')!;
    const coder = model.nodes.find((n) => n.id === 'agent-coder')!;
    const hermes = model.nodes.find((n) => n.id === 'agent-hermes')!;
    const directNodes = model.nodes.filter(
      (n) => n.laneKind === 'orchestrator-workflows' && n.id.startsWith('workflow-') && !n.id.startsWith('workflow-more:'),
    );

    // Three balanced branches: Coder → left, hermes → center (under the
    // orchestrator), direct workflows → right.
    expect(Math.abs(orchestrator.x - width / 2)).toBeLessThan(2);
    expect(coder.x).toBeLessThan(hermes.x);
    // Center-out packing keeps the middle manager under the orchestrator even
    // though the right (direct-workflows) branch is much wider.
    expect(Math.abs(hermes.x - orchestrator.x)).toBeLessThan(4);
    expect(directNodes.length).toBeGreaterThan(0);
    expect(Math.max(...directNodes.map((n) => n.x))).toBeGreaterThan(hermes.x);
    // Branches never collide horizontally.
    expect(Math.abs(coder.x - hermes.x)).toBeGreaterThan((coder.width + hermes.width) / 2 + 24);
    // The orchestrator's direct workflows read as a first-class branch (a line
    // back to the orchestrator).
    expect(model.edges.some((e) => e.from === orchestrator.id && directNodes.some((d) => d.id === e.to))).toBe(true);
  });

  it('keeps a large fleet of managers packed tight and overlap-free (scales to ~15)', () => {
    const spaces = Array.from({ length: 15 }, (_, i) => ({ id: `space-${i}`, name: `Team ${i}` }));
    const workflows = spaces.flatMap((s, i) => [
      { id: `wf-${i}-a`, title: `Flow ${i} A`, status: 'idle', spaceId: s.id },
      { id: `wf-${i}-b`, title: `Flow ${i} B`, status: 'idle', spaceId: s.id },
    ]);
    const agents: Parameters<typeof buildCanvasModel>[1] = [
      { id: 'orch', name: 'Orchy', role: 'orchestrator', status: 'online' },
      ...spaces.map((s, i) => ({ id: `mgr-${i}`, name: `Lead ${i}`, role: 'manager' as const, status: 'online', spaceId: s.id })),
    ];
    const model = buildCanvasModel({ loading: false, knowledgeBases: [], spaces, workflows }, agents, [], [], [], [], { width: 5600, height: 1600 });

    const managers = spaces
      .map((_, i) => model.nodes.find((n) => n.id === `agent-mgr-${i}`)!)
      .sort((a, b) => a.x - b.x);
    expect(managers).toHaveLength(15);

    // Managers sit at a uniform stride (not spread by their subtrees).
    const gaps = managers.slice(1).map((m, i) => m.x - managers[i]!.x);
    expect(gaps.every((g) => Math.abs(g - gaps[0]!) < 1)).toBe(true);

    // "Not spread by their subtrees" asserted directly: give every manager 4×
    // the workflow load and the stride must not budge. Each branch gets a
    // symmetric lane exactly one stride wide and its columns are capped to fit,
    // so lane width is a function of branch COUNT alone.
    //
    // (This replaces an older `gaps[0] < width + 120` bound, which encoded the
    // long-gone one-manager-width floor. That floor collapsed each lane to a
    // single vertical column of cards once a row had ~5+ branches — a real
    // reported bug — and was deliberately raised to a two-column minimum.)
    const heavyWorkflows = spaces.flatMap((s, i) =>
      Array.from({ length: 8 }, (_, k) => ({ id: `wf-${i}-${k}`, title: `Flow ${i} ${k}`, status: 'idle', spaceId: s.id })),
    );
    const heavy = buildCanvasModel(
      { loading: false, knowledgeBases: [], spaces, workflows: heavyWorkflows },
      agents, [], [], [], [], { width: 5600, height: 1600 },
    );
    const heavyManagers = spaces
      .map((_, i) => heavy.nodes.find((n) => n.id === `agent-mgr-${i}`)!)
      .sort((a, b) => a.x - b.x);
    expect(heavyManagers[1]!.x - heavyManagers[0]!.x).toBeCloseTo(gaps[0]!, 1);

    // A large fleet packs at least as tight as a small one — it never fans out
    // as managers are added (small orgs get extra breathing room instead).
    const smallSpaces = spaces.slice(0, 4);
    const smallModel = buildCanvasModel(
      {
        loading: false,
        knowledgeBases: [],
        spaces: smallSpaces,
        workflows: workflows.filter((w) => smallSpaces.some((s) => s.id === w.spaceId)),
      },
      agents.filter((a) => a.role === 'orchestrator' || smallSpaces.some((s) => s.id === a.spaceId)),
      [], [], [], [], { width: 5600, height: 1600 },
    );
    const smallManagers = smallSpaces
      .map((_, i) => smallModel.nodes.find((n) => n.id === `agent-mgr-${i}`)!)
      .sort((a, b) => a.x - b.x);
    expect(gaps[0]!).toBeLessThanOrEqual(smallManagers[1]!.x - smallManagers[0]!.x);

    // The structural no-overlap rule: no two nodes sharing a row collide.
    const nodes = model.nodes.filter((n) => !n.ghost || n.role === 'manager');
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        if (Math.abs(a.y - b.y) > 24) continue; // different rows
        expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual((a.width + b.width) / 2 - 1);
      }
    }
  });

  it('fans a focused manager\'s workers out under the manager, not the canvas center', () => {
    const data: Parameters<typeof buildCanvasModel>[0] = {
      loading: false,
      knowledgeBases: [],
      spaces: [
        { id: 'space-a', name: 'Alpha' },
        { id: 'space-b', name: 'Beta' },
      ],
      workflows: [],
    };
    const agents: Parameters<typeof buildCanvasModel>[1] = [
      { id: 'orch-1', name: 'Orchy', role: 'orchestrator', status: 'online' },
      { id: 'mgr-a', name: 'Alpha Lead', role: 'manager', status: 'online', spaceId: 'space-a' },
      { id: 'mgr-b', name: 'Beta Lead', role: 'manager', status: 'online', spaceId: 'space-b' },
      { id: 'w1', name: 'Worker One', role: 'worker', status: 'online', reportsTo: 'mgr-a' },
      { id: 'w2', name: 'Worker Two', role: 'worker', status: 'online', reportsTo: 'mgr-a' },
    ];
    const width = 1600;
    // Focus the left-hand manager (mgr-a).
    const model = buildCanvasModel(data, agents, [], [], [], [], { width, height: 760 }, 'agent-mgr-a');
    const mgrA = model.nodes.find((n) => n.id === 'agent-mgr-a')!;
    const workers = model.nodes.filter((n) => n.kind === 'worker');

    expect(workers).toHaveLength(2);
    expect(mgrA.x).toBeLessThan(width / 2);
    // Workers cluster under their (off-center) manager, not the canvas center.
    const workerCenter = workers.reduce((sum, n) => sum + n.x, 0) / workers.length;
    expect(Math.abs(workerCenter - mgrA.x)).toBeLessThan(120);
    expect(Math.abs(workerCenter - width / 2)).toBeGreaterThan(120);
  });

  it('clusters a specialist\'s owned workflows under the specialist when its manager is focused', () => {
    const data: Parameters<typeof buildCanvasModel>[0] = {
      loading: false,
      knowledgeBases: [],
      spaces: [{ id: 'space-a', name: 'Alpha' }],
      workflows: [
        { id: 'wf-seo', title: 'SEO Audit', status: 'idle', ownerAgentId: 'w1' },
      ],
    };
    const agents: Parameters<typeof buildCanvasModel>[1] = [
      { id: 'orch-1', name: 'Orchy', role: 'orchestrator', status: 'online' },
      { id: 'mgr-a', name: 'Alpha Lead', role: 'manager', status: 'online', spaceId: 'space-a' },
      { id: 'w1', name: 'SEO Specialist', role: 'worker', status: 'online', reportsTo: 'mgr-a', spaceId: 'sub-seo', spaceName: 'SEO' },
    ];
    const model = buildCanvasModel(data, agents, [], [], [], [], { width: 1600, height: 760 }, 'agent-mgr-a');
    const specialist = model.nodes.find((n) => n.id === 'agent-w1')!;
    const owned = model.nodes.find((n) => n.id === 'workflow-wf-seo')!;

    expect(specialist).toBeDefined();
    expect(owned).toBeDefined();
    // The owned workflow anchors as a manager-lane resource beneath the specialist
    // (not the orchestrator-direct lane), clustered near the specialist's column.
    expect(owned.laneKind).toBe('manager-workflows');
    expect(owned.y).toBeGreaterThan(specialist.y);
    expect(Math.abs(owned.x - specialist.x)).toBeLessThan(160);
  });

  it('collapses an App\'s workflows into one app node clustered under its domain', () => {
    const data: Parameters<typeof buildCanvasModel>[0] = {
      loading: false,
      knowledgeBases: [],
      spaces: [{ id: 'space-a', name: 'Alpha' }],
      apps: [{ id: 'app-1', name: 'Store Outreach', icon: null, domainId: 'space-a', ownerAgentId: null }],
      workflows: [
        { id: 'wf-1', title: 'Draft', status: 'idle', appId: 'app-1' },
        { id: 'wf-2', title: 'Send', status: 'idle', appId: 'app-1' },
        { id: 'wf-bare', title: 'Standalone', status: 'idle' },
      ],
    };
    const agents: Parameters<typeof buildCanvasModel>[1] = [
      { id: 'orch-1', name: 'Orchy', role: 'orchestrator', status: 'online' },
      { id: 'mgr-a', name: 'Alpha Lead', role: 'manager', status: 'online', spaceId: 'space-a', spaceName: 'Alpha' },
    ];
    const model = buildCanvasModel(data, agents, [], [], [], [], { width: 1600, height: 760 });
    const resourceNodes = model.nodes.filter((n) => n.kind === 'workflow' && n.id.startsWith('workflow-wf-'));
    // The two app workflows collapse to a single representative node; the bare
    // workflow stays on its own.
    const appNode = resourceNodes.find((n) => n.title === 'Store Outreach');
    expect(appNode).toBeDefined();
    expect(appNode!.route).toBe('/apps/app-1');
    expect(appNode!.spaceId).toBe('space-a');
    // No node is titled by an app-owned workflow (they were collapsed).
    expect(resourceNodes.some((n) => n.title === 'Draft' || n.title === 'Send')).toBe(false);
    expect(resourceNodes.some((n) => n.title === 'Standalone')).toBe(true);
  });

  it('fans a focused manager\'s workflows into a multi-column pyramid (not a vertical line)', () => {
    const data: Parameters<typeof buildCanvasModel>[0] = {
      loading: false,
      knowledgeBases: [],
      spaces: [{ id: 'space-a', name: 'Alpha', colorHex: '#22d3ee' }, { id: 'space-b', name: 'Beta' }],
      workflows: Array.from({ length: 6 }, (_, i) => ({ id: `wf-${i}`, title: `Flow ${i}`, status: 'idle', spaceId: 'space-a' })),
    };
    const agents: Parameters<typeof buildCanvasModel>[1] = [
      { id: 'orch-1', name: 'Orchy', role: 'orchestrator', status: 'online' },
      { id: 'mgr-a', name: 'Alpha Lead', role: 'manager', status: 'online', spaceId: 'space-a', spaceName: 'Alpha' },
      { id: 'mgr-b', name: 'Beta Lead', role: 'manager', status: 'online', spaceId: 'space-b' },
    ];
    const model = buildCanvasModel(data, agents, [], [], [], [], { width: 1600, height: 760 }, 'agent-mgr-a');
    const flows = model.nodes.filter((n) => n.kind === 'workflow' && /^workflow-wf-/.test(n.id));
    const distinctX = new Set(flows.map((n) => Math.round(n.x)));
    const distinctY = new Set(flows.map((n) => Math.round(n.y)));
    // A pyramid fans across at least two columns AND two rows — never a single column.
    expect(flows.length).toBeGreaterThanOrEqual(4);
    expect(distinctX.size).toBeGreaterThan(1);
    expect(distinctY.size).toBeGreaterThan(1);
  });

  it('surfaces a specialist count on each manager in the default (collapsed) view', () => {
    const data: Parameters<typeof buildCanvasModel>[0] = {
      loading: false, knowledgeBases: [], spaces: [{ id: 'space-a', name: 'Alpha' }, { id: 'space-b', name: 'Beta' }], workflows: [],
    };
    const agents: Parameters<typeof buildCanvasModel>[1] = [
      { id: 'orch-1', name: 'Orchy', role: 'orchestrator', status: 'online' },
      { id: 'mgr-a', name: 'Alpha Lead', role: 'manager', status: 'online', spaceId: 'space-a' },
      { id: 'mgr-b', name: 'Beta Lead', role: 'manager', status: 'online', spaceId: 'space-b' },
      { id: 'w1', name: 'W1', role: 'worker', status: 'online', reportsTo: 'mgr-a' },
      { id: 'w2', name: 'W2', role: 'worker', status: 'online', reportsTo: 'mgr-a' },
      { id: 'w3', name: 'W3', role: 'worker', status: 'online', reportsTo: 'mgr-b' },
    ];
    // No manager focused: workers hidden, counts shown on the managers.
    const model = buildCanvasModel(data, agents, [], [], [], [], { width: 1600, height: 760 });
    expect(model.nodes.filter((n) => n.kind === 'worker')).toHaveLength(0);
    expect(model.nodes.find((n) => n.id === 'agent-mgr-a')?.specialistCount).toBe(2);
    expect(model.nodes.find((n) => n.id === 'agent-mgr-b')?.specialistCount).toBe(1);
  });

  it('shows a workspace loading state until the first snapshot has loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/v1/workflows') return jsonResponse({ workflows: [] });
        if (path === '/v1/knowledge-bases') return jsonResponse({ knowledgeBases: [] });
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter>
        <WorkspaceEcosystemCanvas
          agents={[{ id: 'a1', name: 'Thomas', role: 'manager', status: 'online' }]}
          activeRuns={[]}
          artifacts={[]}
          snapshotLoading
        />
      </MemoryRouter>,
    );

    // While the snapshot is still loading, the boot skeleton covers the canvas
    // instead of the half-assembled tree.
    expect(await screen.findByText(/loading your workspace/i)).toBeInTheDocument();
  });

  it('maps the hierarchy directly and reveals contextual output on selection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
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
          agents={[
            { id: 'orch-1', name: 'Orchestrator Prime', role: 'orchestrator', status: 'online' },
            {
              id: 'mgr-1',
              name: 'Content Lead',
              role: 'manager',
              status: 'online',
              abilities: [{ id: 'ab-1', name: 'Marketing Expert', slug: 'marketing-expert', domainTag: 'marketing' }],
            },
            {
              id: 'a1',
              name: 'Thomas',
              role: 'worker',
              reportsTo: 'mgr-1',
              status: 'online',
              abilities: [{ id: 'ab-2', name: 'Copywriter', slug: 'copywriter', domainTag: 'marketing' }],
            },
          ]}
          activeRuns={[{ id: 'run-1', workflowId: 'wf-1', workflowName: 'Weekly newsletter', status: 'RUNNING', startedAt: new Date().toISOString() }]}
          artifacts={[{ id: 'art-1', title: 'Newsletter draft', createdAt: new Date().toISOString(), agent: 'Thomas', workflowId: 'wf-1' }]}
          snapshotLoading={false}
        />
      </MemoryRouter>,
    );

    expect((await screen.findAllByText('Content Lead')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Thomas')).not.toBeInTheDocument();
    expect(screen.getAllByText('Weekly newsletter').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Orchestrator Prime online/i)).toBeInTheDocument();
    expect(screen.queryByText('Content Brain')).not.toBeInTheDocument();
    expect(screen.queryByText('Newsletter draft')).not.toBeInTheDocument();
    expect(document.querySelector('[data-node-id="knowledge-kb-1"]')).toBeNull();

    fireEvent.click(screen.getByText('Orchestrator Prime'));
    expect(await screen.findByText('Content Brain')).toBeInTheDocument();
    expect(document.querySelector('[data-node-id="knowledge-kb-1"]')).not.toBeNull();

    const managerNode = document.querySelector('[data-node-id="agent-mgr-1"]') as HTMLElement | null;
    expect(managerNode).not.toBeNull();
    fireEvent.click(managerNode!);
    expect(await screen.findByText('Thomas')).toBeInTheDocument();
    expect(document.querySelector('[data-node-id="knowledge-kb-1"]')).not.toBeNull();

    const focusedWorkflowLabels = await screen.findAllByText('Weekly newsletter');
    fireEvent.click(focusedWorkflowLabels[0]!);
    expect(await screen.findByText('Newsletter draft')).toBeInTheDocument();
  });

  it('opens Live Workspace without duplicating notification-only failed and attention counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/v1/workflows') return jsonResponse({ workflows: [{ id: 'wf-1', title: 'Old failed workflow', status: 'active' }] });
        if (path === '/v1/knowledge-bases') return jsonResponse({ knowledgeBases: [] });
        return jsonResponse({});
      }),
    );

    render(
      <MemoryRouter>
        <WorkspaceEcosystemCanvas
          agents={[{ id: 'a1', name: 'Thomas', role: 'manager', status: 'online' }]}
          activeRuns={[]}
          failedRuns={[{ id: 'failed-1', workflowName: 'Old failed workflow' }]}
          artifacts={[]}
          snapshotLoading={false}
        />
      </MemoryRouter>,
    );

    expect((await screen.findAllByText('Thomas')).length).toBeGreaterThan(0);
    // Fleet metrics now live only in the footer LiveStrip — the canvas itself
    // no longer carries a HUD bar.
    expect(screen.queryByText('running')).not.toBeInTheDocument();
    expect(screen.queryByText('attention')).not.toBeInTheDocument();
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
    expect(screen.queryByText(/failed runs/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open live workspace/i }));
    const liveWorkspace = screen.getByRole('dialog', { name: /live workspace/i });
    expect(liveWorkspace).toBeInTheDocument();
    expect(screen.getAllByText('Old failed workflow').length).toBeGreaterThan(0);
    fireEvent.click(within(liveWorkspace).getByRole('button', { name: 'Tech' }));
    expect(screen.getByText(/normalized runtime event|reconnect to receive/i)).toBeInTheDocument();
    fireEvent.click(within(liveWorkspace).getByRole('button', { name: 'Live' }));
    fireEvent.click(within(liveWorkspace).getByRole('button', { name: 'Expand Live Workspace' }));
    expect(within(liveWorkspace).getByRole('button', { name: 'Restore Live Workspace' })).toBeInTheDocument();
  });

  it('hides the canvas toolbar when no workflow canvas is configured', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/v1/workflows') return jsonResponse({ workflows: [] });
      if (path === '/v1/knowledge-bases') return jsonResponse({ knowledgeBases: [] });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

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

    expect(await screen.findByText(/Your AI organization will appear here/i)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/v1/workflows', expect.anything()));
    expect(screen.queryByRole('button', { name: /open live workspace/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset view/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /full screen/i })).not.toBeInTheDocument();
  });

  it('keeps panning when pointer movement is delivered outside the canvas element', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
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
        if (path === '/v1/workflows') return jsonResponse({ workflows: [{ id: 'wf-1', title: 'Social Digest', status: 'active' }] });
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
    expect(screen.queryByText('attention')).not.toBeInTheDocument();
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/open monitor/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/show chat/i)).not.toBeInTheDocument();
  });

  it('hides the canvas composer while the docked chat is open', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
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
