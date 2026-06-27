/**
 * GenUI Renaissance grammar — additive style intent, new layout/shell/atom/viz
 * nodes, richer Chart, and the read-authz allowlist over the new data-bound and
 * container nodes. The headline invariant: **old trees stay byte-valid.**
 */
import { describe, it, expect } from 'vitest';
import { collectionsInView, viewNodeSchema, surfaceThemeOf, type ViewNode } from '../src/types/view.js';

describe('back-compat (old trees parse unchanged)', () => {
  it('parses a pre-renaissance tree with no style and the old single-series Chart', () => {
    const legacy: ViewNode = {
      type: 'Stack',
      gap: 16,
      children: [
        { type: 'Heading', value: 'Operator' },
        { type: 'AgentConsole' },
        { type: 'ActivityStream', title: 'Live activity' },
        { type: 'Card', title: 'Add to leads', children: [{ type: 'Form', fields: [{ key: 'name', type: 'text' }], submit: { action: 'create_leads' } }] },
        { type: 'Table', bind: { collection: 'leads', live: true }, columns: [{ key: 'name' }] },
        { type: 'Chart', bind: { collection: 'metrics', live: true }, chartType: 'bar', x: 'day', y: 'count' },
        { type: 'DataBoard', bind: { collection: 'pipeline', live: true }, groupBy: 'stage' },
      ],
    };
    expect(viewNodeSchema.parse(legacy)).toMatchObject({ type: 'Stack', gap: 16 });
  });
});

describe('style intent is accepted on any node', () => {
  it('accepts bounded style on layout and content nodes', () => {
    expect(viewNodeSchema.parse({ type: 'Card', children: [], style: { elevation: 'raised', pad: 'lg', tone: 'danger' } })).toMatchObject({ style: { elevation: 'raised' } });
    expect(viewNodeSchema.parse({ type: 'Heading', value: 'Hi', style: { size: 'xl', emphasis: 'strong' } })).toMatchObject({ type: 'Heading' });
    expect(viewNodeSchema.parse({ type: 'Stack', children: [], style: { theme: 'console', density: 'compact' } })).toMatchObject({ style: { theme: 'console' } });
  });

  it('rejects out-of-bounds style enums (no raw CSS)', () => {
    expect(() => viewNodeSchema.parse({ type: 'Card', children: [], style: { elevation: 'glow' } })).toThrow();
    expect(() => viewNodeSchema.parse({ type: 'Card', children: [], style: { accent: '#ff0000' } })).toThrow();
  });
});

describe('new nodes validate', () => {
  it('layout & shell nodes', () => {
    expect(viewNodeSchema.parse({ type: 'Tabs', tabs: [{ label: 'Overview', children: [{ type: 'Text', value: 'x' }] }] })).toMatchObject({ type: 'Tabs' });
    expect(viewNodeSchema.parse({ type: 'Accordion', sections: [{ title: 'A', children: [] }] })).toMatchObject({ type: 'Accordion' });
    expect(viewNodeSchema.parse({ type: 'Split', left: { type: 'Text', value: 'l' }, right: { type: 'Text', value: 'r' }, ratio: 2 })).toMatchObject({ type: 'Split' });
    expect(viewNodeSchema.parse({ type: 'Hero', title: 'Welcome', subtitle: 'sub', eyebrow: 'NEW' })).toMatchObject({ type: 'Hero' });
    expect(viewNodeSchema.parse({ type: 'Toolbar', title: 'Bar', children: [{ type: 'Button', label: 'Go', action: { action: 'go' } }] })).toMatchObject({ type: 'Toolbar' });
    expect(viewNodeSchema.parse({ type: 'Grid', columns: 4, children: [] })).toMatchObject({ columns: 4 });
  });

  it('atom & viz nodes', () => {
    expect(viewNodeSchema.parse({ type: 'KPIStrip', items: [{ label: 'MRR', value: 1200, delta: '+8%', tone: 'success', spark: [1, 2, 3] }] })).toMatchObject({ type: 'KPIStrip' });
    expect(viewNodeSchema.parse({ type: 'Sparkline', points: [1, 2, 3] })).toMatchObject({ type: 'Sparkline' });
    expect(viewNodeSchema.parse({ type: 'ProgressBar', value: 42, max: 100, label: 'Done' })).toMatchObject({ type: 'ProgressBar' });
    expect(viewNodeSchema.parse({ type: 'Avatar', name: 'Ada Lovelace', size: 'lg' })).toMatchObject({ type: 'Avatar' });
    expect(viewNodeSchema.parse({ type: 'Callout', title: 'Heads up', value: 'Body', style: { tone: 'warning' } })).toMatchObject({ type: 'Callout' });
    expect(viewNodeSchema.parse({ type: 'Timeline', bind: { collection: 'events', live: true }, titleField: 'name', atField: 'created_at' })).toMatchObject({ type: 'Timeline' });
  });

  it('richer Chart: multi-series, area, stacked, donut', () => {
    expect(viewNodeSchema.parse({
      type: 'Chart',
      bind: { collection: 'metrics', live: true },
      chartType: 'area',
      x: 'day',
      y: 'count',
      series: [{ y: 'count', label: 'Visits', color: 'blue' }, { y: 'signups', color: 'teal' }],
      stacked: true,
      legend: true,
      curve: 'smooth',
    })).toMatchObject({ chartType: 'area', stacked: true });
    expect(viewNodeSchema.parse({ type: 'Chart', bind: { collection: 'm', live: true }, chartType: 'donut', x: 'label', y: 'value' })).toMatchObject({ chartType: 'donut' });
  });
});

describe('collectionsInView — read authz over the new nodes', () => {
  it('walks new data-bound and container nodes without inventing collections', () => {
    const view: ViewNode = {
      type: 'Tabs',
      tabs: [
        { label: 'A', children: [{ type: 'Timeline', bind: { collection: 'events', live: true } }] },
        {
          label: 'B',
          children: [
            { type: 'Split', left: { type: 'Sparkline', bind: { collection: 'metrics', live: true }, y: 'v' }, right: { type: 'Toolbar', children: [{ type: 'Table', bind: { collection: 'orders', live: true }, columns: [{ key: 'id' }] }] } },
            { type: 'Accordion', sections: [{ title: 'More', children: [{ type: 'DataBoard', bind: { collection: 'pipeline', live: true }, groupBy: 'stage' }] }] },
          ],
        },
      ],
    };
    expect([...collectionsInView(view)].sort()).toEqual(['events', 'metrics', 'orders', 'pipeline']);
  });

  it('Sparkline/Timeline with static data bind nothing', () => {
    expect([...collectionsInView({ type: 'Stack', children: [{ type: 'Sparkline', points: [1, 2] }, { type: 'Timeline', items: [{ title: 'x' }] }] })]).toEqual([]);
  });

  it('domain composites validate and expose their bound collections', () => {
    expect(viewNodeSchema.parse({ type: 'ChatThread', title: 'Chat', bind: { collection: 'messages', live: true }, send: { action: 'reply' } })).toMatchObject({ type: 'ChatThread' });
    expect(viewNodeSchema.parse({ type: 'Inbox', bind: { collection: 'conversations', live: true }, messagesBind: { collection: 'messages', live: true }, matchField: 'conversationId' })).toMatchObject({ type: 'Inbox' });
    expect(viewNodeSchema.parse({ type: 'MediaGen', generate: { action: 'gen' }, bind: { collection: 'images', live: true } })).toMatchObject({ type: 'MediaGen' });
    expect(viewNodeSchema.parse({ type: 'Funnel', stages: [{ label: 'Visit', value: 100 }, { label: 'Buy', value: 12 }] })).toMatchObject({ type: 'Funnel' });
    expect(viewNodeSchema.parse({ type: 'Calendar', events: [{ date: '2026-06-25', label: 'Demo', tone: 'accent' }] })).toMatchObject({ type: 'Calendar' });
    expect(viewNodeSchema.parse({ type: 'Gauge', label: 'Load', value: 72, max: 100, tone: 'success' })).toMatchObject({ type: 'Gauge' });

    // Inbox exposes BOTH the conversations and the messages collections; nothing else.
    expect([...collectionsInView({ type: 'Inbox', bind: { collection: 'conversations', live: true }, messagesBind: { collection: 'messages', live: true } })].sort()).toEqual(['conversations', 'messages']);
    expect([...collectionsInView({ type: 'ChatThread', bind: { collection: 'dm', live: true } })]).toEqual(['dm']);
    expect([...collectionsInView({ type: 'Funnel', stages: [{ label: 'x', value: 1 }] })]).toEqual([]);
  });

  it('CodeSurface (Pillar 4): validates and exposes only its declared collections', () => {
    expect(viewNodeSchema.parse({ type: 'CodeSurface', code: 'root.appendChild(ui.heading("Hi"))', collections: ['orders'] })).toMatchObject({ type: 'CodeSurface' });
    expect([...collectionsInView({ type: 'Stack', children: [{ type: 'CodeSurface', code: 'x', collections: ['orders', 'metrics'] }] })].sort()).toEqual(['metrics', 'orders']);
    expect([...collectionsInView({ type: 'CodeSurface', code: 'x' })]).toEqual([]);
  });
});

describe('surfaceThemeOf', () => {
  it('reads the theme from the root node style', () => {
    expect(surfaceThemeOf({ type: 'Stack', children: [], style: { theme: 'console' } })).toBe('console');
    expect(surfaceThemeOf({ type: 'Stack', children: [] })).toBeUndefined();
    expect(surfaceThemeOf(null)).toBeUndefined();
  });
});
