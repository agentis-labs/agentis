import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import {
  validateGraphExpressions,
  dryRunGraphExpressions,
  repairExpressionReferences,
  analyzeInputReachability,
  analyzeEdgeCouplings,
} from '../../src/engine/validateExpressions.js';

function graphWith(config: Record<string, unknown>): WorkflowGraph {
  return {
    nodes: [{ id: 'n1', type: config.kind as string, title: 'Node', position: { x: 0, y: 0 }, config } as never],
    edges: [],
  } as WorkflowGraph;
}

describe('validateGraphExpressions', () => {
  it('flags an unknown reference in a transform (the "X is not defined" class)', () => {
    const issues = validateGraphExpressions(
      graphWith({ kind: 'transform', expression: '({ rejected: payload.items })' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('unknown_reference');
    expect(issues[0]!.identifier).toBe('payload');
  });

  it('accepts every contract name (input/inputs/output/nodes/...) — no false positives', () => {
    const expr =
      '({ a: input.x, b: inputs.y, c: output.z, d: nodes.fetch && nodes.fetch.n, e: trigger.t, f: scratchpad.s })';
    expect(validateGraphExpressions(graphWith({ kind: 'transform', expression: expr }))).toEqual([]);
  });

  it('does NOT flag data-shape access on a real-but-absent field (zero false positives)', () => {
    // `input.items.map` throws at probe time on empty input, but that is a
    // data-dependent runtime error, not a contract bug — must not be flagged.
    expect(
      validateGraphExpressions(graphWith({ kind: 'transform', expression: '({ n: input.items.map((x) => x.id) })' })),
    ).toEqual([]);
  });

  it('flags a syntax error', () => {
    const issues = validateGraphExpressions(graphWith({ kind: 'transform', expression: 'const ;;; nope' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('syntax_error');
  });

  it('checks {{= … }} template expressions in any field', () => {
    const issues = validateGraphExpressions(
      graphWith({ kind: 'agent_task', prompt: 'Hello {{= bogus.name }}', agentId: 'a1' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.identifier).toBe('bogus');
  });
});

describe('dryRunGraphExpressions (sample-threaded, P4.1)', () => {
  it('unmasks a reference error hidden behind a data access on empty input', () => {
    const graph = {
      nodes: [
        { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'X', type: 'transform', title: 'shape', position: { x: 1, y: 0 }, config: { kind: 'transform', expression: '({ ids: input.items.map((i) => i.id), bad: payld })' } },
      ],
      edges: [{ id: 'e', source: 'T', target: 'X' }],
      inputContract: { fields: [{ key: 'items', type: 'array' }] },
    } as unknown as WorkflowGraph;
    // The empty-context probe masks `payld` behind `input.items` (undefined).map:
    expect(validateGraphExpressions(graph)).toEqual([]);
    // Sample threading populates items=[{}], so the masked `payld` surfaces:
    const issues = dryRunGraphExpressions(graph);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.identifier).toBe('payld');
    expect(issues[0]!.message).toContain('Expression Contract');
  });

  it('threads declared output keys forward so a downstream transform sees arrays', () => {
    const graph = {
      nodes: [
        { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'F', type: 'agent_task', title: 'fetch', position: { x: 1, y: 0 }, config: { kind: 'agent_task', agentRole: 'analyst', prompt: 'x', outputKeys: ['rows'] } },
        { id: 'X', type: 'transform', title: 'shape', position: { x: 2, y: 0 }, config: { kind: 'transform', expression: '({ n: nodes.F.rows.length, bad: bogusRef })' } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'F' }, { id: 'e2', source: 'F', target: 'X' }],
    } as unknown as WorkflowGraph;
    expect(dryRunGraphExpressions(graph).map((i) => i.identifier)).toContain('bogusRef');
  });

  it('suggests the nearest contract name for a near-miss (P4.3 grammar card)', () => {
    const issues = validateGraphExpressions(graphWith({ kind: 'transform', expression: '({ x: triger.id })' }));
    expect(issues[0]!.message).toContain('Did you mean "trigger"?');
  });
});

describe('repairExpressionReferences', () => {
  it('repairs a near-miss of a contract name deterministically', () => {
    const r = repairExpressionReferences('({ prior: noeds.fetch.count, who: inpt.name })');
    expect(r.changed).toBe(true);
    expect(r.expression).toBe('({ prior: nodes.fetch.count, who: input.name })');
    expect(r.rewrites).toEqual(
      expect.arrayContaining([
        { from: 'noeds', to: 'nodes' },
        { from: 'inpt', to: 'input' },
      ]),
    );
    // The repaired expression now passes the gate.
    expect(validateGraphExpressions(graphWith({ kind: 'transform', expression: r.expression }))).toEqual([]);
  });

  it('leaves a genuinely unknowable reference untouched', () => {
    const r = repairExpressionReferences('({ x: customThing.value })');
    expect(r.changed).toBe(false);
    expect(r.expression).toBe('({ x: customThing.value })');
  });

  it('does not touch a valid expression', () => {
    const r = repairExpressionReferences('({ x: input.value })');
    expect(r.changed).toBe(false);
  });
});

describe('analyzeInputReachability (P0.5 — input scoping)', () => {
  it('flags a field the node references but its inputKeys drops', () => {
    const issues = analyzeInputReachability(
      graphWith({ kind: 'agent_task', prompt: 'Score input.candidates for the store', inputKeys: ['lead'], outputKeys: [] }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.identifier).toBe('input.candidates');
    expect(issues[0]!.message).toContain('inputKeys');
  });

  it('does not flag when inputKeys is empty (whole input passes through)', () => {
    expect(
      analyzeInputReachability(
        graphWith({ kind: 'agent_task', prompt: 'Score input.candidates', inputKeys: [], outputKeys: [] }),
      ),
    ).toEqual([]);
  });

  it('does not flag a referenced field that IS kept by inputKeys', () => {
    expect(
      analyzeInputReachability(
        graphWith({ kind: 'agent_task', prompt: 'Score input.candidates', inputKeys: ['candidates'], outputKeys: [] }),
      ),
    ).toEqual([]);
  });

  it('flags a dropped field for an extension_task inputMapping too', () => {
    const issues = analyzeInputReachability(
      graphWith({ kind: 'extension_task', operationName: 'run', inputMapping: { leadName: 'candidates.0.name' }, note: 'reads input.candidates' }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('inputMapping');
  });
});

describe('analyzeEdgeCouplings (Organ 1 — typed edges)', () => {
  const N = (id: string, kind: string, config: Record<string, unknown>) =>
    ({ id, type: kind, title: id, position: { x: 0, y: 0 }, config: { kind, ...config } });
  const G = (nodes: unknown[], edges: unknown[]) => ({ nodes, edges } as unknown as WorkflowGraph);

  it('flags a node that reads a key its upstream does not produce (the Fashion Store shape-mismatch)', () => {
    const graph = G([
      N('T', 'trigger', { triggerType: 'manual' }),
      N('A', 'transform', { expression: '({ evidence: { signals: input.raw } })' }),
      N('B', 'transform', { expression: '({ score: input.signals })' }),
    ], [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'B' }]);
    const issues = analyzeEdgeCouplings(graph);
    expect(issues.some((i) => i.nodeId === 'B' && i.identifier === 'input.signals')).toBe(true);
  });

  it('does NOT flag a valid coupling (upstream produces the key)', () => {
    const graph = G([
      N('T', 'trigger', { triggerType: 'manual' }),
      N('A', 'transform', { expression: '({ signals: input.raw })' }),
      N('B', 'transform', { expression: '({ score: input.signals })' }),
    ], [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'B' }]);
    expect(analyzeEdgeCouplings(graph)).toEqual([]);
  });

  it('does NOT flag when the producer is opaque (an integration with no declared shape)', () => {
    const graph = G([
      N('T', 'trigger', { triggerType: 'manual' }),
      N('A', 'integration', { integrationId: 'x', operationId: 'y', inputs: {} }),
      N('B', 'transform', { expression: '({ score: input.anything })' }),
    ], [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'B' }]);
    expect(analyzeEdgeCouplings(graph)).toEqual([]);
  });

  it('does NOT flag past a spread (open shape)', () => {
    const graph = G([
      N('T', 'trigger', { triggerType: 'manual' }),
      N('A', 'transform', { expression: '({ ...input, extra: 1 })' }),
      N('B', 'transform', { expression: '({ score: input.anything })' }),
    ], [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'B' }]);
    expect(analyzeEdgeCouplings(graph)).toEqual([]);
  });

  it('flags a nodes["id"].key read the producer does not emit', () => {
    const graph = G([
      N('T', 'trigger', { triggerType: 'manual' }),
      N('score', 'agent_task', { agentRole: 'analyst', prompt: 'x', outputKeys: ['scoredCount'] }),
      N('B', 'transform', { expression: '({ ok: nodes["score"].candidates })' }),
    ], [{ id: 'e1', source: 'T', target: 'score' }, { id: 'e2', source: 'score', target: 'B' }]);
    expect(analyzeEdgeCouplings(graph).some((i) => i.identifier === 'nodes["score"].candidates')).toBe(true);
  });

  it('ORGAN 1-deep: flags a 2-segment read the nested shape lacks (input.evidence.signals ← evidence is { candidates })', () => {
    const graph = G([
      N('T', 'trigger', { triggerType: 'manual' }),
      N('A', 'transform', { expression: '({ evidence: { candidates: input.raw } })' }),
      N('B', 'transform', { expression: '({ score: input.evidence.signals })' }),
    ], [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'B' }]);
    expect(analyzeEdgeCouplings(graph).some((i) => i.nodeId === 'B' && i.identifier === 'input.evidence.signals')).toBe(true);
  });

  it('ORGAN 1-deep: does NOT flag a valid 2-segment read (evidence really has signals)', () => {
    const graph = G([
      N('T', 'trigger', { triggerType: 'manual' }),
      N('A', 'transform', { expression: '({ evidence: { signals: input.raw } })' }),
      N('B', 'transform', { expression: '({ score: input.evidence.signals })' }),
    ], [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'B' }]);
    expect(analyzeEdgeCouplings(graph)).toEqual([]);
  });

  it('ORGAN 1-deep: does NOT flag when the nested value is opaque (evidence = a call, open shape)', () => {
    const graph = G([
      N('T', 'trigger', { triggerType: 'manual' }),
      N('A', 'transform', { expression: '({ evidence: buildEvidence(input) })' }),
      N('B', 'transform', { expression: '({ score: input.evidence.signals })' }),
    ], [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'B' }]);
    expect(analyzeEdgeCouplings(graph)).toEqual([]);
  });
});
