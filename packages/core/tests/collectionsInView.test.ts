/**
 * collectionsInView — the read-authorization allowlist for a surface.
 *
 * Must gather every collection the view tree binds (Table/List/Chart/DataBoard +
 * CustomView.collections), recurse through containers, and ignore non-data nodes.
 */
import { describe, it, expect } from 'vitest';
import { collectionsInView, viewNodeSchema, type ViewNode } from '../src/types/view.js';

describe('ViewNode Studio compatibility', () => {
  it('accepts row flex widths without changing existing row payloads', () => {
    expect(viewNodeSchema.parse({ type: 'Row', widths: [2, 1], children: [{ type: 'Text', value: 'Primary' }, { type: 'Text', value: 'Secondary' }] })).toMatchObject({
      type: 'Row',
      widths: [2, 1],
    });
    expect(viewNodeSchema.parse({ type: 'Row', children: [{ type: 'Text', value: 'Existing' }] })).toMatchObject({ type: 'Row' });
  });

  it('validates the Studio composite nodes and requires HTTPS embeds', () => {
    expect(viewNodeSchema.parse({ type: 'Narrative', title: 'Summary', value: 'Everything is on track.' })).toMatchObject({ type: 'Narrative' });
    expect(viewNodeSchema.parse({ type: 'WebEmbed', url: 'https://example.com' })).toMatchObject({ type: 'WebEmbed' });
    expect(() => viewNodeSchema.parse({ type: 'WebEmbed', url: 'http://example.com' })).toThrow();
  });
});

describe('collectionsInView', () => {
  it('returns an empty set for null / data-free views', () => {
    expect([...collectionsInView(null)]).toEqual([]);
    expect([...collectionsInView({ type: 'Stack', children: [{ type: 'Heading', value: 'hi' }] })]).toEqual([]);
  });

  it('collects bound collections across nested containers and node kinds', () => {
    const view: ViewNode = {
      type: 'Stack',
      children: [
        { type: 'Heading', value: 'Dashboard' },
        {
          type: 'Card',
          title: 'Tickets',
          children: [
            { type: 'Table', bind: { collection: 'tickets', live: true }, columns: [{ key: 'subject' }] },
            { type: 'Chart', bind: { collection: 'metrics', live: true }, chartType: 'line', x: 'day', y: 'count' },
          ],
        },
        { type: 'DataBoard', bind: { collection: 'pipeline', live: true }, groupBy: 'stage' },
        {
          type: 'List',
          bind: { collection: 'comments', live: true },
          item: { type: 'Text', value: 'x' },
        },
        { type: 'CustomView', html: '<div></div>', collections: ['audit', 'tickets'] },
      ],
    };
    expect([...collectionsInView(view)].sort()).toEqual(['audit', 'comments', 'metrics', 'pipeline', 'tickets']);
  });

  it('does not invent collections the view never binds (the leak guard)', () => {
    const view: ViewNode = {
      type: 'Stack',
      children: [{ type: 'Table', bind: { collection: 'tickets', live: true }, columns: [{ key: 'subject' }] }],
    };
    const allowed = collectionsInView(view);
    expect(allowed.has('tickets')).toBe(true);
    expect(allowed.has('secrets')).toBe(false);
  });
});
