/**
 * Core graph primitives — canonicalization (dedup / divergence detection),
 * deterministic layout, and the workflow validation boundary. These are pure,
 * browser-safe modules shared by both apps; a regression here silently breaks
 * workflow dedup, the "Tidy" layout, or the edit-time validation gate.
 */
import { describe, it, expect } from 'vitest';
import { canonicalizeGraph } from '../src/graphCanonical.js';
import { computeLayeredLayout, layoutWorkflowGraph } from '../src/graphLayout.js';
import { computePhaseAwareLayout, layoutWorkflowGraphByPhases, suggestWorkflowPhases } from '../src/graphPhases.js';
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

describe('workflow phases', () => {
  it('suggests deterministic, ordered phases for graphs with four or more nodes', () => {
    const source = graph({
      nodes: [
        graph().nodes[0]!,
        { id: 'F', type: 'http_request', title: 'Fetch data', position: { x: 0, y: 0 }, config: { kind: 'http_request', method: 'GET', url: 'https://example.com' } },
        { id: 'A', type: 'agent_task', title: 'Analyze', position: { x: 0, y: 0 }, config: { kind: 'agent_task', agentRole: 'analyst', capabilityTags: [], prompt: 'Analyze', inputKeys: [], outputKeys: [] } },
        { id: 'R', type: 'return_output', title: 'Return output', position: { x: 0, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'F' },
        { id: 'e2', source: 'F', target: 'A' },
        { id: 'e3', source: 'A', target: 'R' },
      ],
    });
    const first = suggestWorkflowPhases(source);
    expect(first).toEqual(suggestWorkflowPhases(source));
    expect(first.length).toBe(2);
    expect(first.flatMap((phase) => phase.nodeIds)).toEqual(['T', 'F', 'A', 'R']);
  });

  it('keeps branches within a phase lane and unassigned nodes in a final lane', () => {
    const source = graph({
      nodes: [
        graph().nodes[0]!,
        { id: 'B', type: 'transform', title: 'B', position: { x: 0, y: 0 }, config: { kind: 'transform', expression: 'input' } },
        { id: 'C', type: 'transform', title: 'C', position: { x: 0, y: 0 }, config: { kind: 'transform', expression: 'input' } },
        graph().nodes[1]!,
      ],
      edges: [
        { id: 'e1', source: 'T', target: 'B' },
        { id: 'e2', source: 'T', target: 'C' },
        { id: 'e3', source: 'B', target: 'M' },
        { id: 'e4', source: 'C', target: 'M' },
      ],
      phases: [{ id: 'p1', name: 'Work', color: '#2563eb', nodeIds: ['T', 'B', 'C'] }],
    });
    const result = computePhaseAwareLayout(source);
    expect(result.lanes.map((lane) => lane.id)).toEqual(['p1', '__unassigned__']);
    // Siblings B and C share a column (same x) and stack vertically within the lane.
    expect(result.positions.get('B')!.x).toBe(result.positions.get('C')!.x);
    expect(result.positions.get('B')!.y).not.toBe(result.positions.get('C')!.y);
    // Lanes flow left-to-right, so the unassigned lane (holding M) sits to the
    // right of the work lane and shares its top edge.
    expect(result.positions.get('M')!.x).toBeGreaterThan(result.positions.get('B')!.x);
    const [workLane, unassignedLane] = result.lanes;
    expect(unassignedLane!.y).toBe(workLane!.y);
    expect(unassignedLane!.x).toBeGreaterThan(workLane!.x + workLane!.width - 1);
    const laid = layoutWorkflowGraphByPhases(source);
    expect(laid.nodes.find((node) => node.id === 'M')!.position.x).toBeGreaterThan(0);
  });

  it('uses semantic seven-phase grouping for larger operational workflows', () => {
    const mk = (id: string, title: string, kind = 'transform') => ({
      id,
      type: kind,
      title,
      position: { x: 0, y: 0 },
      config: kind === 'return_output'
        ? { kind: 'return_output' as const, renderAs: 'json' as const }
        : { kind: kind as 'transform', expression: 'input' },
    });
    const nodes = [
      { id: 'start', type: 'trigger', title: 'Start Store Factory', position: { x: 0, y: 0 }, config: { kind: 'trigger' as const, triggerType: 'manual' as const } },
      mk('input', 'Transform'),
      mk('qualify', 'Qualify and Harvest Candidate'),
      mk('qual_gate', 'Qualification Gate'),
      mk('reject', 'Return Rejected Lead', 'return_output'),
      mk('approve_curate', 'Approve Candidate Before Curation'),
      mk('curate', 'Curate Assets and Generate Brand Config'),
      mk('curation_gate', 'Curation and Config Gate'),
      mk('curation_fail', 'Return Curation Failure', 'return_output'),
      mk('approve_seed', 'Approve Supabase Seed'),
      mk('seed', 'Seed Supabase and Validate Builds'),
      mk('local_gate', 'Local Release Gate'),
      mk('local_fail', 'Return Local Failure', 'return_output'),
      mk('progress', 'Build In-Progress Lead Output'),
      mk('persist_progress', 'Persist Lead Progress'),
      mk('approve_deploy', 'Approve Production Deployment'),
      mk('deploy', 'Deploy and Validate Live Store'),
      mk('live_gate', 'Live Release Gate'),
      mk('deploy_fail', 'Return Deployment Failure', 'return_output'),
      mk('deployed', 'Build Deployed Lead Output'),
      mk('persist_deployed', 'Persist Deployed Lead'),
      mk('final', 'Return Agentis Store Output', 'return_output'),
    ];
    const phases = suggestWorkflowPhases({
      nodes,
      edges: nodes.slice(1).map((node, index) => ({ id: `e${index}`, source: nodes[index]!.id, target: node.id })),
    });

    expect(phases).toHaveLength(7);
    expect(phases.map((phase) => phase.name)).toEqual([
      'Intake',
      'Qualification',
      'Curation',
      'Seed & Validate',
      'Persist Progress',
      'Deployment',
      'Final Output',
    ]);
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

  it('rejects malformed phase metadata', () => {
    const bad = graph({
      phases: [{ id: 'p1', name: '', color: 'blue', nodeIds: [] }],
    });
    expect(workflowGraphSchema.safeParse(bad).success).toBe(false);
  });
});
