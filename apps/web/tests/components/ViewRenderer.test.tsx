/**
 * ViewRenderer (GenUI Renaissance) — proves the renderer turns bounded style
 * intent into Design-System tokens, drops the "every node is a heavy card"
 * pattern, renders progressive-disclosure (Tabs), and draws real SVG charts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentisAppClient } from '@agentis/app-client';
import type { ViewNode } from '@agentis/core';
import { RuntimeProvider, ViewRenderer } from '../../src/components/apps/ViewRenderer';
import { containerClasses, textClasses, toneSoftClass } from '../../src/components/apps/styleIntent';
import { getBlock, registerBlock, listBlockKinds } from '../../src/components/apps/blocks/registry';
import { appsApi } from '../../src/lib/appsApi';

// The renderer's agent-native nodes subscribe to realtime via socket.io; stub it.
vi.mock('socket.io-client', () => ({
  io: () => ({ on: () => {}, off: () => {}, emit: () => {}, disconnect: () => {}, io: { on: () => {} } }),
}));

function matchesFilter(row: Record<string, unknown>, filter: Record<string, unknown> = {}): boolean {
  return Object.entries(filter).every(([key, expected]) => row[key] === expected);
}

function stubClient(rows: Array<Record<string, unknown>> = []): AgentisAppClient {
  return {
    data: { query: vi.fn(async (_collection, query) => rows.filter((row) => matchesFilter(row, query?.filter))) },
    state: { get: async () => undefined, set: async () => {}, subscribe: () => () => {} },
    actions: { invoke: vi.fn(async () => ({})) },
    navigation: { go: async () => {} },
    realtime: { subscribe: () => () => {} },
    files: { upload: async () => { throw new Error('unsupported'); } },
  } as unknown as AgentisAppClient;
}

function renderNode(node: ViewNode, rows: Array<Record<string, unknown>> = [], opts: { allowCustomCode?: boolean } = {}) {
  return render(
    <RuntimeProvider value={{ appId: 'app-1', surface: 'main', client: stubClient(rows), surfaceActions: [], uiState: {}, allowCustomCode: opts.allowCustomCode ?? false, dataRevision: 0 }}>
      <ViewRenderer node={node} />
    </RuntimeProvider>,
  );
}

describe('styleIntent → Design System tokens', () => {
  it('maps elevation + density-aware padding (and flat = no card)', () => {
    const raised = containerClasses({ elevation: 'raised' }, 'comfortable');
    // `raised` is now the design-language premium panel (`s-panel`); its background
    // + shadow come from the active design's `--s-card-*` tokens (applied via CSS),
    // not literal Tailwind utilities.
    expect(raised).toContain('s-panel');
    expect(raised).toContain('p-4'); // comfortable + default md padding
    expect(containerClasses({ pad: 'lg' }, 'comfortable')).toContain('p-6');
    expect(containerClasses({ pad: 'lg' }, 'compact')).toContain('p-4'); // compact tightens
    expect(containerClasses(undefined, 'comfortable')).toBe(''); // default is flat — no heavy card
  });

  it('maps text size/emphasis and soft tone', () => {
    expect(textClasses({ size: 'xl', emphasis: 'strong' })).toContain('text-[24px]');
    expect(toneSoftClass('danger')).toContain('text-danger');
  });
});

describe('ViewRenderer', () => {
  it('does not wrap a plain Stack in a heavy card', () => {
    const { container } = renderNode({ type: 'Stack', children: [{ type: 'Text', value: 'hello' }] });
    const stack = container.querySelector('.flex-col');
    expect(stack?.className).toContain('flex flex-col');
    expect(container.innerHTML).not.toContain('shadow-card');
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('renders Tabs and switches panel on click (progressive disclosure)', async () => {
    renderNode({
      type: 'Tabs',
      tabs: [
        { label: 'One', children: [{ type: 'Text', value: 'first panel' }] },
        { label: 'Two', children: [{ type: 'Text', value: 'second panel' }] },
      ],
    });
    expect(screen.getByText('first panel')).toBeTruthy();
    expect(screen.queryByText('second panel')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(screen.getByText('second panel')).toBeTruthy();
    expect(screen.queryByText('first panel')).toBeNull();
  });

  it('renders a real SVG chart from bound data (not div bars)', async () => {
    const { container } = renderNode(
      { type: 'Chart', bind: { collection: 'metrics', live: true }, chartType: 'line', x: 'day', y: 'count' },
      [{ day: 'Mon', count: 3 }, { day: 'Tue', count: 7 }, { day: 'Wed', count: 5 }],
    );
    await waitFor(() => expect(container.querySelector('svg')).toBeTruthy());
    expect(container.querySelector('path')).toBeTruthy();
  });

  it('applies a heading size intent', () => {
    const { container } = renderNode({ type: 'Heading', value: 'Big', style: { size: 'xl' } });
    expect(container.querySelector('h2')?.className).toContain('text-[24px]');
  });

  it('CodeSurface mounts a sandboxed iframe when policy allows, blocks otherwise', () => {
    const node: ViewNode = { type: 'CodeSurface', code: 'root.appendChild(ui.heading("Hi"))', collections: ['orders'] };
    const blocked = renderNode(node);
    expect(blocked.container.querySelector('iframe')).toBeNull();
    expect(blocked.getByText(/blocked by app policy/i)).toBeTruthy();

    const allowed = renderNode(node, [], { allowCustomCode: true });
    const frame = allowed.container.querySelector('iframe[title="Code surface"]') as HTMLIFrameElement | null;
    expect(frame).toBeTruthy();
    // Hardened: null-origin sandbox, zero network egress, kit + bridge injected.
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.srcdoc).toContain("connect-src 'none'");
    expect(frame?.srcdoc).toContain('window.ui');
    expect(frame?.srcdoc).toContain('window.agentis');
  });
});

/**
 * E1 — visible broken-binding indicators + design-var spacing. A binding that
 * fails to resolve used to render as silent-empty (or a bare em-dash for a
 * Metric), so a broken App looked merely empty. Now an unresolved `{$bind}` /
 * `{$state}` / `{$row}` surfaces a visible "⚠ unbound: <path>" marker, while
 * literal text and resolved bindings render unchanged.
 */
describe('binding markers + design-var spacing (E1)', () => {
  function renderWithState(node: ViewNode, uiState: Record<string, unknown>) {
    return render(
      <RuntimeProvider value={{ appId: 'app-1', surface: 'main', client: stubClient(), surfaceActions: [], uiState, allowCustomCode: false, dataRevision: 0 }}>
        <ViewRenderer node={node} />
      </RuntimeProvider>,
    );
  }

  it('shows a visible unbound marker when a Text binding does not resolve (not silent-empty)', () => {
    renderNode({ type: 'Text', value: { $state: 'missing' } } as unknown as ViewNode);
    expect(screen.getByText(/unbound:\s*state\.missing/i)).toBeTruthy();
  });

  it('Metric surfaces an unbound marker instead of a bare em-dash', () => {
    const { container } = renderNode({ type: 'Metric', label: 'Revenue', value: { $state: 'rev' } } as unknown as ViewNode);
    expect(screen.getByText(/unbound:\s*state\.rev/i)).toBeTruthy();
    expect(container.textContent).not.toContain('—'); // the silent dash no longer hides a broken value
  });

  it('renders the bound value (no marker) when the binding resolves', () => {
    renderWithState({ type: 'Metric', label: 'Revenue', value: { $state: 'rev' } } as unknown as ViewNode, { rev: '$2.4k' });
    expect(screen.getByText('$2.4k')).toBeTruthy();
    expect(screen.queryByText(/unbound/i)).toBeNull();
  });

  it('does not cry wolf on literal (non-bound) text', () => {
    renderNode({ type: 'Text', value: 'literal copy' });
    expect(screen.getByText('literal copy')).toBeTruthy();
    expect(screen.queryByText(/unbound/i)).toBeNull();
  });

  it('Stack spacing honors the design --s-gap var (not a hardcoded binary gap)', () => {
    const { container } = renderNode({ type: 'Stack', children: [{ type: 'Text', value: 'a' }, { type: 'Text', value: 'b' }] });
    const stack = container.querySelector('.flex-col') as HTMLElement;
    expect(stack.style.gap).toContain('--s-gap');
  });

  it('renders legacy count templates as human KPI numbers, never raw moustache text', async () => {
    const { container } = renderNode(
      {
        type: 'KPIStrip',
        items: [
          { label: 'Qualified leads', value: '{{count:fashion leads}}' },
          { label: 'Positive replies', value: '{{count:fashion leads.stage:positive}}' },
        ],
      },
      [
        { id: '1', stage: 'positive' },
        { id: '2', stage: 'greeted' },
        { id: '3', stage: 'positive' },
      ],
    );

    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
    expect(screen.getByText('2')).toBeTruthy();
    expect(container.textContent).not.toContain('{{count:');
  });
});

/**
 * E2 — the block registry is the OPEN seam. The renderer dispatches through
 * `getBlock(node.type)` instead of a hard-coded switch, so the built-in set is
 * registered, an unregistered kind renders a visible marker (not silent null),
 * and a new kind can be added at runtime via `registerBlock`.
 */
describe('block registry (E2)', () => {
  it('registers every built-in kind (dispatch table is populated on import)', () => {
    const kinds = listBlockKinds();
    for (const k of ['Stack', 'Grid', 'Metric', 'KPIStrip', 'Table', 'Chart', 'Tabs', 'Form', 'CodeSurface']) {
      expect(kinds).toContain(k);
      expect(getBlock(k)).toBeTypeOf('function');
    }
  });

  it('renders a visible UnknownBlock for an unregistered kind (not silent null)', () => {
    renderNode({ type: 'NotARealBlock' } as unknown as ViewNode);
    expect(screen.getByText(/unknown block/i)).toBeTruthy();
    expect(screen.getByText('NotARealBlock')).toBeTruthy();
  });

  it('lets an agent/plugin register a brand-new block kind at runtime', () => {
    expect(getBlock('CustomChip')).toBeUndefined();
    registerBlock('CustomChip', (node) => <div data-testid="custom-chip">chip:{node.type}</div>);
    renderNode({ type: 'CustomChip' } as unknown as ViewNode);
    expect(screen.getByTestId('custom-chip').textContent).toBe('chip:CustomChip');
  });
});

/**
 * E3 — the Workflow Control Plane block renders the App's own workflows (E0
 * endpoint) with purpose + trigger + last run, and starts one on click. This is
 * the control that was missing: run/see workflows without leaving the App.
 */
describe('WorkflowControl block (E3)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists the app workflows with purpose + trigger and runs one', async () => {
    vi.spyOn(appsApi, 'listWorkflows').mockResolvedValue([
      { id: 'wf1', title: 'Lead Qualifier', purpose: 'Scores inbound leads', order: 0, enabled: true, dependsOn: [], triggerKind: 'webhook', lastRun: { id: 'r1', status: 'completed', at: new Date().toISOString() } },
    ]);
    const runSpy = vi.spyOn(appsApi, 'runAppWorkflow').mockResolvedValue({ runId: 'run-1' });
    renderNode({ type: 'WorkflowControl' } as ViewNode);

    await userEvent.click(await screen.findByRole('button', { name: /expand/i }));
    expect(await screen.findByText('Lead Qualifier')).toBeTruthy();
    expect(screen.getByText('Scores inbound leads')).toBeTruthy();
    expect(screen.getByText('webhook')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /run lead qualifier/i }));
    expect(runSpy).toHaveBeenCalledWith('app-1', 'wf1');
  });

  it('shows an empty state when the app has no workflows', async () => {
    vi.spyOn(appsApi, 'listWorkflows').mockResolvedValue([]);
    renderNode({ type: 'WorkflowControl' } as ViewNode);
    expect(await screen.findByText(/no workflows yet/i)).toBeTruthy();
  });
});

describe('Table sorting (E3)', () => {
  it('sorts a bound table by a numeric column on header click (asc → desc)', async () => {
    const { container } = renderNode(
      { type: 'Table', bind: { collection: 'leads', live: true }, columns: [{ key: 'name', label: 'Name' }, { key: 'score', label: 'Score' }] },
      [{ name: 'Zoe', score: 10 }, { name: 'Ana', score: 90 }, { name: 'Mia', score: 50 }],
    );
    await screen.findByText('Ana');
    const scoreCol = () => [...container.querySelectorAll('tbody tr td:nth-child(2)')].map((c) => c.textContent?.trim());
    await userEvent.click(screen.getByRole('button', { name: /sort by score/i }));
    expect(scoreCol()).toEqual(['10', '50', '90']);
    await userEvent.click(screen.getByRole('button', { name: /sort by score/i }));
    expect(scoreCol()).toEqual(['90', '50', '10']);
  });

  it('filters and paginates a large bound table', async () => {
    const rows = Array.from({ length: 23 }, (_, i) => ({ name: `Lead ${i + 1}`, score: i }));
    const { container } = renderNode(
      { type: 'Table', bind: { collection: 'leads', live: true }, columns: [{ key: 'name', label: 'Name' }, { key: 'score', label: 'Score' }] },
      rows,
    );
    await screen.findByText('Lead 1');
    expect(container.querySelectorAll('tbody tr').length).toBe(10); // page size
    expect(screen.getByText(/1.10 of 23/)).toBeTruthy(); // footer range
    await userEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.getByText(/11.20 of 23/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Filter rows'), 'zzz-no-match');
    expect(screen.getByText(/no matches/i)).toBeTruthy(); // filter-aware empty state
  });

  // Regression: a multi-column table in a NARROW container (a Split rail, a
  // narrow viewport) used to collapse its columns to sub-word widths inside an
  // `overflow-hidden` panel, so the browser broke cell/header text one glyph per
  // line — the "vertical column of single characters" failure. The table must
  // now sit in a horizontal-scroll wrapper with a min-width floor so it scrolls
  // instead of squishing.
  it('keeps a table scrollable with a min-width floor (no single-character columns)', async () => {
    const { container } = renderNode(
      { type: 'Table', bind: { collection: 'orders', live: true }, columns: [
        { key: 'product', label: 'Product' }, { key: 'status', label: 'Status' },
        { key: 'region', label: 'Region' }, { key: 'total', label: 'Total' },
      ] },
      [{ product: 'Widget', status: 'shipped', region: 'EMEA', total: 42 }],
    );
    const table = await screen.findByRole('table');
    const scroller = table.closest('.overflow-x-auto');
    expect(scroller).toBeTruthy(); // horizontal scroll wrapper present
    const minWidth = parseInt((table as HTMLElement).style.minWidth || '0', 10);
    expect(minWidth).toBeGreaterThanOrEqual(480); // never collapses below a readable width
  });
});
