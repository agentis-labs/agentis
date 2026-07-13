import { describe, it, expect } from 'vitest';
import { buildVariableOptions, slugForNode, type UpstreamNode } from '../src/components/canvas/VariablePicker';

const trigger: UpstreamNode = { id: 'trigger-mrj63dwv', title: 'Qualified Lead', type: 'trigger', outputKeys: ['status'] };

describe('slugForNode', () => {
  it('maps a node id to its readable title slug', () => {
    expect(slugForNode([trigger]).get('trigger-mrj63dwv')).toBe('qualified_lead');
  });

  it('omits ambiguous titles from the map', () => {
    const a: UpstreamNode = { id: 'a', title: 'Send Message', type: 'channel' };
    const b: UpstreamNode = { id: 'b', title: 'Send Message', type: 'channel' };
    const map = slugForNode([a, b]);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(false);
  });
});

describe('buildVariableOptions', () => {
  it('inserts the readable slug, not the raw node id', () => {
    const options = buildVariableOptions([trigger]);
    const bare = options.find((o) => o.label === 'nodes.qualified_lead');
    expect(bare).toBeDefined();
    expect(bare?.origin).toBe('Qualified Lead');
    expect(options.some((o) => o.label.includes('trigger-mrj63dwv'))).toBe(false);
  });

  it('falls back to the raw id when the title has no usable slug', () => {
    const options = buildVariableOptions([{ id: 'node-abc123', title: '', type: 'transform' }]);
    expect(options.some((o) => o.label === 'nodes.node-abc123')).toBe(true);
  });

  it('tags every option with its origin kind for the picker icon', () => {
    const options = buildVariableOptions([trigger]);
    expect(options.find((o) => o.path === 'trigger')?.kind).toBe('trigger');
    expect(options.find((o) => o.path === 'nodes.qualified_lead')?.kind).toBe('trigger');
    expect(options.find((o) => o.path === 'nodes.qualified_lead.status')?.kind).toBe('trigger');
  });
});
