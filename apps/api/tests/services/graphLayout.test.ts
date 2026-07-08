/**
 * computeLayeredLayout / layoutWorkflowGraph — the shared left-to-right layered
 * layout that makes AI-built graphs readable and framable.
 */
import { describe, expect, it } from 'vitest';
import { computeLayeredLayout, layoutWorkflowGraph } from '@agentis/core';
import type { WorkflowGraph } from '@agentis/core';

describe('computeLayeredLayout', () => {
  it('places nodes in left-to-right layers along edges', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
    const pos = computeLayeredLayout(nodes, edges);
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
    expect(pos.get('b')!.x).toBeLessThan(pos.get('c')!.x);
  });

  it('puts independent parallel branches in the same layer, separated vertically', () => {
    // fork: a → b, a → c (b and c are independent, same layer)
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const edges = [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }];
    const pos = computeLayeredLayout(nodes, edges);
    expect(pos.get('b')!.x).toBe(pos.get('c')!.x); // same layer
    expect(pos.get('b')!.y).not.toBe(pos.get('c')!.y); // stacked
  });

  it('ignores self-loops and edges to missing nodes without crashing', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const edges = [{ source: 'a', target: 'a' }, { source: 'a', target: 'ghost' }, { source: 'a', target: 'b' }];
    const pos = computeLayeredLayout(nodes, edges);
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
  });

  it('layoutWorkflowGraph rewrites every node position and preserves nodes/edges', () => {
    const graph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 't', type: 'trigger', title: 'T', position: { x: 999, y: 999 }, config: { kind: 'trigger' } },
        { id: 'o', type: 'return_output', title: 'O', position: { x: -50, y: 12 }, config: { kind: 'return_output' } },
      ],
      edges: [{ id: 'e', source: 't', target: 'o' }],
    } as unknown as WorkflowGraph;
    const out = layoutWorkflowGraph(graph);
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toHaveLength(1);
    const t = out.nodes.find((n) => n.id === 't')!;
    const o = out.nodes.find((n) => n.id === 'o')!;
    expect(t.position.x).toBeLessThan(o.position.x);
    expect(t.position).not.toEqual({ x: 999, y: 999 });
  });
});
