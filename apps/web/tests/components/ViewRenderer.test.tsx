/**
 * ViewRenderer (GenUI Renaissance) — proves the renderer turns bounded style
 * intent into Design-System tokens, drops the "every node is a heavy card"
 * pattern, renders progressive-disclosure (Tabs), and draws real SVG charts.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentisAppClient } from '@agentis/app-client';
import type { ViewNode } from '@agentis/core';
import { RuntimeProvider, ViewRenderer } from '../../src/components/apps/ViewRenderer';
import { containerClasses, textClasses, toneSoftClass } from '../../src/components/apps/styleIntent';

// The renderer's agent-native nodes subscribe to realtime via socket.io; stub it.
vi.mock('socket.io-client', () => ({
  io: () => ({ on: () => {}, off: () => {}, emit: () => {}, disconnect: () => {}, io: { on: () => {} } }),
}));

function stubClient(rows: Array<Record<string, unknown>> = []): AgentisAppClient {
  return {
    data: { query: vi.fn(async () => rows) },
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
    expect(raised).toContain('bg-surface');
    expect(raised).toContain('shadow-card');
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
