import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppEditorPage } from '../../src/pages/AppEditorPage';

vi.mock('../../src/pages/WorkflowCanvasPage', () => ({
  WorkflowCanvasPage: ({ workflowId }: { workflowId?: string }) => (
    <div data-testid="workflow-canvas">Canvas {workflowId}</div>
  ),
  WorkflowBrainTab: () => <div>Brain tab</div>,
}));

vi.mock('../../src/components/apps/AppRuntime', () => ({
  AppRuntime: () => <div data-testid="app-runtime">App runtime</div>,
}));

// The builder canvas subscribes to realtime via socket.io; stub it so tests
// never open a real connection.
vi.mock('socket.io-client', () => ({
  io: () => ({ on: () => {}, off: () => {}, emit: () => {}, disconnect: () => {}, io: { on: () => {} } }),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function appRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    workspaceId: 'ws-1',
    slug: 'store-outreach',
    name: 'Store outreach',
    description: '',
    version: '0.1.0',
    status: 'draft',
    entrySurfaceId: null,
    icon: null,
    manifest: { slug: 'store-outreach', name: 'Store outreach', version: '0.1.0', capabilities: [], requiredPlugins: [] },
    policy: { audience: [], shareable: false, customCode: 'disabled', grants: [] },
    source: null,
    installedChecksum: null,
    createdBy: 'u-1',
    createdAt: '2026-06-23T00:00:00.000Z',
    updatedAt: '2026-06-23T00:00:00.000Z',
    ...overrides,
  };
}

function surfaceRow(name: string, view: unknown = { type: 'Stack', children: [] }, overrides: Record<string, unknown> = {}) {
  return {
    id: 'surface-1',
    appId: 'app-1',
    name,
    kind: 'page',
    view,
    actions: [],
    shareable: false,
    revision: 0,
    updatedAt: '2026-06-23T00:00:00.000Z',
    ...overrides,
  };
}

function renderEditor(facet: 'interface' | 'workflow' = 'interface') {
  render(
    <MemoryRouter initialEntries={[`/apps/app-1?facet=${facet}`]}>
      <Routes>
        <Route path="/apps/:id" element={<AppEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<AppEditorPage />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the workflow facet mounted after renaming a workflow', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      // Control-plane summary shape (E0): the page reads id + title directly, no per-workflow fetch.
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [{ id: 'wf-1', title: 'Original workflow', purpose: null, order: 0, enabled: true, dependsOn: [], triggerKind: 'manual', lastRun: null }] });
      if (path === '/v1/workflows/wf-1' && method === 'PATCH') return jsonResponse({ ok: true });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('workflow');

    await waitFor(() => expect(screen.getByTestId('workflow-canvas')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Original workflow' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Rename Original workflow' }));
    const input = screen.getByLabelText('Workflow title');
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed workflow');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/v1/workflows/wf-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Renamed workflow' }) }),
      );
    });

    expect(screen.getByRole('tab', { name: 'Renamed workflow' })).toBeInTheDocument();
    expect(screen.getByTestId('workflow-canvas')).toHaveTextContent('Canvas wf-1');
  });

  it('renames surfaces and adds a block on the live builder canvas', async () => {
    let surfaceName = 'surface';
    let lastSavedView: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [surfaceRow(surfaceName)] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/surfaces/surface' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { name: string };
        surfaceName = body.name;
        return jsonResponse({ data: surfaceRow(surfaceName, { type: 'Stack', children: [] }, { revision: 1 }) });
      }
      if (path === '/v1/apps/app-1/surfaces' && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { view: unknown };
        lastSavedView = body.view;
        return jsonResponse({ data: surfaceRow(surfaceName, body.view, { revision: 2 }) });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await waitFor(() => expect(screen.getByRole('button', { name: 'surface' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Rename surface' }));
    const surfaceInput = screen.getByLabelText('Surface name');
    await userEvent.clear(surfaceInput);
    await userEvent.type(surfaceInput, 'Main dashboard');
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Main dashboard' })).toBeInTheDocument());

    // Interface opens Live; editing is opt-in.
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // Add a Heading element from the palette — it renders live on the canvas.
    await userEvent.click(screen.getByRole('button', { name: 'Heading' }));
    expect(screen.getAllByText('New heading').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(lastSavedView).toMatchObject({ type: 'Stack', children: [{ type: 'Heading', value: 'New heading' }] });
    });
  });

  it('drops a data-bound section and persists its declared action', async () => {
    let lastSavedView: any = null;
    let lastSavedActions: any = null;
    const collection = {
      id: 'c1',
      appId: 'app-1',
      name: 'tasks',
      schema: { fields: [{ key: 'title', type: 'string', required: false, indexed: false }] },
      createdAt: '2026-06-23T00:00:00.000Z',
      updatedAt: '2026-06-23T00:00:00.000Z',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [surfaceRow('surface')] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [collection] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      if (path.startsWith('/v1/apps/app-1/collections/tasks/query')) return jsonResponse({ rows: [] });
      if (path === '/v1/apps/app-1/surfaces' && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { view: unknown; actions: unknown };
        lastSavedView = body.view;
        lastSavedActions = body.actions;
        return jsonResponse({ data: surfaceRow('surface', body.view, { revision: 2 }) });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Form' }));

    // The create form renders the collection field, and its insert action is declared.
    expect((await screen.findAllByText('Title')).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(JSON.stringify(lastSavedView)).toContain('"type":"Form"');
      expect(lastSavedActions).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'create_tasks', kind: 'data', target: 'tasks.insert' })]),
      );
    });
  });

  it('renders the GenUI palette in edit mode', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [surfaceRow('surface')] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    for (const name of ['Hero', 'KPI strip', 'Chart', 'Table', 'Board', 'Tabs', 'Split', 'Callout', 'Code surface']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('generates a surface from the AI prompt and loads it into the canvas', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [surfaceRow('surface')] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/surfaces/generate' && method === 'POST') {
        return jsonResponse({
          data: {
            view: { type: 'Stack', children: [{ type: 'Heading', value: 'AI heading' }] },
            actions: [],
            source: 'model',
          },
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByLabelText('Describe a surface'), 'a dashboard');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect((await screen.findAllByText('AI heading')).length).toBeGreaterThan(0);
  });

  it('renders the activity stream without an operator command line', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appRecord() });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') {
        return jsonResponse({ data: [surfaceRow('surface', { type: 'Stack', children: [{ type: 'ActivityStream' }] })] });
      }
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(await screen.findByText('Live activity')).toBeInTheDocument();
    expect(screen.queryByLabelText('Direct the operator')).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for activity...')).toBeInTheDocument();
  });

  it('opens the App engine and saves identity and access settings without raw plumbing', async () => {
    let appState = appRecord();
    let lastPatch: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';

      if (path === '/v1/apps/app-1' && method === 'GET') return jsonResponse({ data: appState });
      if (path === '/v1/apps/app-1/surfaces' && method === 'GET') return jsonResponse({ data: [surfaceRow('Dashboard')] });
      if (path === '/v1/apps/app-1/collections' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1/workflows' && method === 'GET') return jsonResponse({ data: [] });
      if (path === '/v1/apps/app-1' && method === 'PATCH') {
        lastPatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        appState = {
          ...appState,
          ...lastPatch,
          policy: { ...(appState.policy as Record<string, unknown>), ...((lastPatch.policy as Record<string, unknown>) ?? {}) },
        };
        return jsonResponse({ data: appState });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    renderEditor('interface');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Store outreach' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'App engine' }));

    const dialog = screen.getByRole('dialog', { name: 'App engine' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Identity' }));
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Store Command Center');
    await userEvent.type(within(dialog).getByLabelText('Description'), 'Operator-facing store app.');
    await userEvent.type(within(dialog).getByLabelText('Icon, image URL, or emoji'), 'S');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Access' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Entry surface'), 'surface-1');
    await userEvent.click(within(dialog).getByLabelText('Shareable via public link'));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Advanced' }));
    await userEvent.click(within(dialog).getByLabelText('Allow custom-coded views'));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Save settings' }));

    await waitFor(() => {
      expect(lastPatch).toMatchObject({
        name: 'Store Command Center',
        description: 'Operator-facing store app.',
        icon: 'S',
        entrySurfaceId: 'surface-1',
        policy: { shareable: true, customCode: 'allowed', grants: [] },
      });
    });
    expect(screen.getByRole('button', { name: 'Store Command Center' })).toBeInTheDocument();
  });
});
