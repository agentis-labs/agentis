import { describe, expect, it } from 'vitest';
import { repairSurface, viewNodeSchema, type ViewNode } from '@agentis/core';
import { interfaceBenchmarks } from '../fixtures/interfaceBenchmarks.js';

function blockKinds(node: ViewNode, out = new Set<string>()): Set<string> {
  out.add(node.type);
  if (node.type === 'Split') {
    blockKinds(node.left, out);
    blockKinds(node.right, out);
  } else if (node.type === 'List') blockKinds(node.item, out);
  else if (node.type === 'AgentRegion' && node.child) blockKinds(node.child, out);
  else if (node.type === 'Tabs') node.tabs.flatMap((tab) => tab.children).forEach((child) => blockKinds(child, out));
  else if (node.type === 'Accordion') node.sections.flatMap((section) => section.children).forEach((child) => blockKinds(child, out));
  else if ('children' in node && Array.isArray(node.children)) node.children.forEach((child) => blockKinds(child, out));
  return out;
}

describe('interface benchmark fixtures', () => {
  for (const benchmark of interfaceBenchmarks) {
    it(`${benchmark.name} remains valid, operable, and idempotent`, () => {
      const parsed = viewNodeSchema.parse(benchmark.view);
      const first = repairSurface(parsed, { collections: benchmark.collections, actions: benchmark.actions });
      const second = repairSurface(first.view, { collections: benchmark.collections, actions: benchmark.actions });
      const kinds = blockKinds(first.view);

      expect(second.fixes).toEqual([]);
      expect(benchmark.requiredBlocks.every((kind) => kinds.has(kind))).toBe(true);
    });
  }

  it('covers the release domains without a universal template composition', () => {
    expect(interfaceBenchmarks.map((benchmark) => benchmark.name)).toEqual(expect.arrayContaining([
      'prospecting pipeline',
      'customer support inbox',
      'relationship workspace',
      'operations control room',
      'editorial intelligence',
    ]));
    const kindSets = interfaceBenchmarks.map((benchmark) => blockKinds(benchmark.view));
    const commonKinds = [...kindSets[0]!].filter((kind) => kindSets.every((set) => set.has(kind)));
    expect(commonKinds).toEqual(['Stack']);
    expect(new Set(interfaceBenchmarks.map((benchmark) => JSON.stringify([...blockKinds(benchmark.view)].sort()))).size)
      .toBe(interfaceBenchmarks.length);
  });
});
