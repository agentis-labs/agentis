/**
 * genuiAudit — the deterministic layout floor. Every anti-pattern that made
 * agent output look broken must be auto-repaired; a good surface must pass
 * through untouched (idempotent).
 */
import { describe, it, expect } from 'vitest';
import { repairSurface, buildArchetypeSurface, type ViewNode } from '../src/index.js';

describe('repairSurface — auto-fixes the garbage', () => {
  it('clamps absurd Split ratios into a readable band', () => {
    const { view, fixes } = repairSurface({ type: 'Split', ratio: 9, left: { type: 'Text', value: 'a' }, right: { type: 'Text', value: 'b' } });
    expect((view as Extract<ViewNode, { type: 'Split' }>).ratio).toBe(2.5);
    expect(fixes).toContain('clamped Split ratio');
  });

  it('removes data panels bound to collections that do not exist', () => {
    const { view } = repairSurface(
      { type: 'Stack', children: [{ type: 'Table', bind: { collection: 'ghost', live: true }, columns: [{ key: 'x' }] }, { type: 'Heading', value: 'Keep me' }] },
      { collections: ['real'] },
    );
    const json = JSON.stringify(view);
    expect(json).not.toContain('ghost');
    expect(json).toContain('Keep me');
  });

  it('caps the number of data panels so a sparse app does not sprawl', () => {
    const tables = Array.from({ length: 8 }, () => ({ type: 'Table' as const, bind: { collection: 'c', live: true }, columns: [{ key: 'x' }] }));
    const { view, fixes } = repairSurface({ type: 'Stack', children: tables }, { collections: ['c'] });
    const count = (JSON.stringify(view).match(/"Table"/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(4); // maxPanels = max(4, 1*2)
    expect(fixes).toContain('capped excess data panels');
  });

  it('strips garbled image-banner headers', () => {
    const { view, fixes } = repairSurface({
      type: 'Stack',
      children: [
        { type: 'Row', children: [{ type: 'Image', src: 'x' }, { type: 'Image', src: 'y' }, { type: 'Image', src: 'z' }] },
        { type: 'Heading', value: 'Real content' },
      ],
    });
    expect(JSON.stringify(view)).not.toContain('"Image"');
    expect(JSON.stringify(view)).toContain('Real content');
    expect(fixes).toContain('removed image-banner header');
  });

  it('drops empty containers and never returns null', () => {
    const { view } = repairSurface({ type: 'Stack', children: [{ type: 'Card', title: 'Empty', children: [] }, { type: 'Stack', children: [] }] });
    expect(view.type).toBe('Stack');
    // both empty children dropped → the root Stack survives (with a guaranteed theme)
    expect((view as Extract<ViewNode, { type: 'Stack' }>).children.length).toBe(0);
  });

  it('guarantees a root theme', () => {
    const { view, fixes } = repairSurface({ type: 'Stack', children: [{ type: 'Chart', bind: { collection: 'm', live: true }, chartType: 'area', x: 'd', y: 'v' }] }, { collections: ['m'] });
    expect(view.style?.theme).toBe('analytics'); // inferred from the Chart
    expect(fixes).toContain('set root theme');
  });

  it('guarantees a premium design language (inferred from theme) so nothing renders flat', () => {
    // A Chart → analytics theme → aurora design language.
    const { view, fixes } = repairSurface({ type: 'Stack', children: [{ type: 'Chart', bind: { collection: 'm', live: true }, chartType: 'area', x: 'd', y: 'v' }] }, { collections: ['m'] });
    expect(view.style?.design).toBe('aurora');
    expect(fixes).toContain('set root design language');
  });

  it('honors a design language the agent already chose', () => {
    const { view, fixes } = repairSurface({ type: 'Stack', style: { theme: 'analytics', design: 'console' }, children: [{ type: 'Heading', value: 'hi' }] });
    expect(view.style?.design).toBe('console');
    expect(fixes).not.toContain('set root design language');
  });

  it('is idempotent and leaves a good (golden) surface essentially intact', () => {
    const golden = buildArchetypeSurface([
      { id: 'c', appId: 'a', name: 'metrics', schema: { fields: [{ key: 'day', type: 'string', required: false, indexed: false }, { key: 'count', type: 'number', required: false, indexed: false }] }, createdAt: '', updatedAt: '' },
    ]).view;
    const once = repairSurface(golden, { collections: ['metrics'] });
    const twice = repairSurface(once.view, { collections: ['metrics'] });
    // golden already has a theme + valid binds + balanced layout → no destructive fixes
    expect(once.fixes).not.toContain('clamped Split ratio');
    expect(once.fixes).not.toContain('removed image-banner header');
    expect(JSON.stringify(once.view)).toBe(JSON.stringify(twice.view)); // idempotent
    expect(JSON.stringify(once.view)).toContain('"Hero"');
  });
});

describe('operability gate — RENDERED ≠ OPERABLE (INTERFACE-OVERHAUL-10X)', () => {
  const workflowAction = { name: 'run_factory', kind: 'workflow' as const, target: 'wf-1' };

  it('wires a declared-but-unreachable workflow action into the page header (the DB-proven Fashion Store case)', () => {
    // The real production failure: run_factory declared, ZERO interactive elements authored.
    const { view, fixes } = repairSurface(
      {
        type: 'Stack',
        children: [
          { type: 'Hero', title: 'Fashion Store Factory' },
          { type: 'Table', bind: { collection: 'factory_leads', live: true }, columns: [{ key: 'lead' }] },
        ],
      },
      { collections: ['factory_leads'], actions: [workflowAction] },
    );
    const json = JSON.stringify(view);
    expect(json).toContain('"run_factory"'); // reachable from a control now
    expect(json).toContain('"Hero"');
    expect(fixes.some((f) => f.includes('wired 1 workflow action'))).toBe(true);
  });

  it('adds an action bar when there is no Hero to carry the workflow action', () => {
    const { view } = repairSurface(
      { type: 'Stack', children: [{ type: 'Table', bind: { collection: 'c', live: true }, columns: [{ key: 'x' }] }] },
      { collections: ['c'], actions: [workflowAction] },
    );
    const json = JSON.stringify(view);
    expect(json).toContain('"Toolbar"');
    expect(json).toContain('"run_factory"');
  });

  it('inserts the OrchestrationPanel when the app drives workflows and none is present', () => {
    const { view, fixes } = repairSurface(
      { type: 'Stack', children: [{ type: 'Hero', title: 'App' }] },
      { actions: [workflowAction] },
    );
    expect(JSON.stringify(view)).toContain('"OrchestrationPanel"');
    expect(fixes).toContain('added the orchestration panel (app drives workflows)');
  });

  it('strips a button bound to an undeclared action (would 404 on click)', () => {
    const { view, fixes } = repairSurface(
      { type: 'Stack', children: [{ type: 'Button', label: 'Ghost', action: { action: 'not_declared' } }, { type: 'Heading', value: 'Keep' }] },
      { actions: [workflowAction] },
    );
    const json = JSON.stringify(view);
    expect(json).not.toContain('not_declared');
    expect(json).toContain('Keep');
    expect(fixes.some((f) => f.includes('undeclared action'))).toBe(true);
  });

  it('keeps navigate/setState buttons (client built-ins need no declaration)', () => {
    const { view } = repairSurface(
      { type: 'Stack', children: [{ type: 'Button', label: 'Go', action: { action: 'navigate', args: { surface: 'board' } } }] },
      { actions: [workflowAction] },
    );
    expect(JSON.stringify(view)).toContain('"navigate"');
  });

  it('wires a declared delete action as a row action on the matching table', () => {
    const del = { name: 'delete_lead', kind: 'data' as const, target: 'leads.delete' };
    const { view, fixes } = repairSurface(
      { type: 'Stack', children: [{ type: 'Table', bind: { collection: 'leads', live: true }, columns: [{ key: 'name' }] }] },
      { collections: ['leads'], actions: [del] },
    );
    const table = JSON.stringify(view);
    expect(table).toContain('"delete_lead"');
    expect(table).toContain('"$row":"id"');
    expect(fixes.some((f) => f.includes('row delete'))).toBe(true);
  });

  it('migrates legacy kinds (AgentConsole → ActivityStream) in place', () => {
    const { view, fixes } = repairSurface(
      { type: 'Stack', children: [{ type: 'AgentConsole', title: 'Ops' } as unknown as ViewNode] },
    );
    const json = JSON.stringify(view);
    expect(json).toContain('"ActivityStream"');
    expect(json).not.toContain('AgentConsole');
    expect(fixes.some((f) => f.includes('migrated legacy'))).toBe(true);
  });

  it('is idempotent: a gated surface passes through the gate unchanged', () => {
    const first = repairSurface(
      {
        type: 'Stack',
        children: [
          { type: 'Hero', title: 'App' },
          { type: 'Table', bind: { collection: 'leads', live: true }, columns: [{ key: 'name' }] },
        ],
      },
      { collections: ['leads'], actions: [workflowAction, { name: 'delete_lead', kind: 'data', target: 'leads.delete' }] },
    );
    const second = repairSurface(first.view, { collections: ['leads'], actions: [workflowAction, { name: 'delete_lead', kind: 'data', target: 'leads.delete' }] });
    expect(JSON.stringify(second.view)).toBe(JSON.stringify(first.view));
  });
});
