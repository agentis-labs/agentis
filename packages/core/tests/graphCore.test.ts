/**
 * Core graph primitives — canonicalization (dedup / divergence detection),
 * deterministic layout, and the workflow validation boundary. These are pure,
 * browser-safe modules shared by both apps; a regression here silently breaks
 * workflow dedup, the "Tidy" layout, or the edit-time validation gate.
 */
import { describe, it, expect } from 'vitest';
import { canonicalizeGraph } from '../src/graphCanonical.js';
import { computeLayeredLayout, layoutWorkflowGraph } from '../src/graphLayout.js';
import { workflowGraphSchema, workflowNodeSchema } from '../src/schemas/workflow.js';
import type { WorkflowGraph } from '../src/types/workflow.js';

function graph(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'M', type: 'merge', title: 'Merge', position: { x: 100, y: 0 }, config: { kind: 'merge', requiredInputs: 'all' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'M' }],
    ...overrides,
  } as WorkflowGraph;
}

describe('canonicalizeGraph', () => {
  it('is stable across viewport and node-position changes (cosmetic)', () => {
    const a = canonicalizeGraph(graph());
    const moved = graph();
    moved.viewport = { x: 999, y: -50, zoom: 2.5 };
    moved.nodes = moved.nodes.map((n) => ({ ...n, position: { x: 777, y: 333 } }));
    expect(canonicalizeGraph(moved)).toBe(a);
  });

  it('is stable across node/edge array ordering', () => {
    const a = canonicalizeGraph(graph());
    const reordered = graph();
    reordered.nodes = [...reordered.nodes].reverse();
    expect(canonicalizeGraph(reordered)).toBe(a);
  });

  it('changes when a behavior-significant config field changes', () => {
    const a = canonicalizeGraph(graph());
    const changed = graph();
    (changed.nodes[1]!.config as { requiredInputs: string }).requiredInputs = 'any';
    expect(canonicalizeGraph(changed)).not.toBe(a);
  });

  it('changes when an edge is added', () => {
    const a = canonicalizeGraph(graph());
    const withEdge = graph();
    withEdge.edges = [...withEdge.edges, { id: 'e2', source: 'M', target: 'T' }];
    expect(canonicalizeGraph(withEdge)).not.toBe(a);
  });

  it('normalizes optional edge fields so default/explicit forms hash alike', () => {
    const bare = graph();
    const explicit = graph();
    explicit.edges = [{ id: 'e1', source: 'T', target: 'M', type: 'default', sourceHandle: undefined, condition: undefined } as never];
    expect(canonicalizeGraph(explicit)).toBe(canonicalizeGraph(bare));
  });
});

describe('computeLayeredLayout', () => {
  it('lays a linear chain into increasing columns', () => {
    const pos = computeLayeredLayout(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      [{ source: 'A', target: 'B' }, { source: 'B', target: 'C' }],
      { colGap: 300, rowGap: 100, originX: 0, originY: 0 },
    );
    expect(pos.get('A')!.x).toBe(0);
    expect(pos.get('B')!.x).toBe(300);
    expect(pos.get('C')!.x).toBe(600);
  });

  it('places a diamond fan-out on the same layer and rejoins downstream', () => {
    const pos = computeLayeredLayout(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      [
        { source: 'A', target: 'B' },
        { source: 'A', target: 'C' },
        { source: 'B', target: 'D' },
        { source: 'C', target: 'D' },
      ],
      { colGap: 200 },
    );
    expect(pos.get('B')!.x).toBe(200);
    expect(pos.get('C')!.x).toBe(200);
    expect(pos.get('B')!.y).not.toBe(pos.get('C')!.y); // siblings separated vertically
    expect(pos.get('D')!.x).toBe(400); // longest path from A
  });

  it('ignores self-loops and edges to unknown nodes', () => {
    const pos = computeLayeredLayout(
      [{ id: 'A' }, { id: 'B' }],
      [{ source: 'A', target: 'A' }, { source: 'A', target: 'B' }, { source: 'B', target: 'ghost' }],
      { colGap: 100 },
    );
    expect(pos.get('A')!.x).toBe(0);
    expect(pos.get('B')!.x).toBe(100);
  });

  it('layoutWorkflowGraph repositions nodes without mutating the source', () => {
    const g = graph();
    const out = layoutWorkflowGraph(g);
    expect(out).not.toBe(g);
    expect(g.nodes[1]!.position).toEqual({ x: 100, y: 0 }); // source untouched
    expect(out.nodes[1]!.position!.x).toBeGreaterThan(out.nodes[0]!.position!.x);
  });
});

describe('workflowGraphSchema — validation boundary', () => {
  it('accepts a valid graph', () => {
    expect(workflowGraphSchema.safeParse(graph()).success).toBe(true);
  });

  it('accepts merge requiredInputs in all three forms', () => {
    for (const requiredInputs of ['all', 'any', ['T']] as const) {
      const node = { id: 'M', config: { kind: 'merge', requiredInputs } };
      const parsed = workflowNodeSchema.safeParse(node);
      expect(parsed.success).toBe(true);
      // Parsed through the concrete merge schema, not silently dropped.
      expect((parsed as { data: { config: { requiredInputs: unknown } } }).data.config.requiredInputs).toEqual(requiredInputs);
    }
  });

  it('rejects a graph with the wrong version', () => {
    const bad = { ...graph(), version: 2 };
    expect(workflowGraphSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a graph missing the viewport', () => {
    const { viewport: _omit, ...rest } = graph();
    expect(workflowGraphSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an edge with an unknown type (enum is strict, no fallback)', () => {
    const bad = graph();
    bad.edges = [{ id: 'e1', source: 'T', target: 'M', type: 'bogus' as never }];
    expect(workflowGraphSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a node with an empty id', () => {
    const bad = graph();
    bad.nodes = [{ ...bad.nodes[0]!, id: '' }];
    expect(workflowGraphSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts an unknown node kind (permissive draft fallback by design)', () => {
    const draft = { id: 'X', config: { kind: 'some_future_kind', foo: 1 } };
    expect(workflowNodeSchema.safeParse(draft).success).toBe(true);
  });
});
