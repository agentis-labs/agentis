/**
 * AGENT-PRIMARY M1 — the green ratchet (`evaluateEvolution`). Pure: a proposed
 * graph is judged against its base. A NEW coupling break or an approval bypass is
 * a regression; a pre-existing error is not; a dropped capability is a warning.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { evaluateEvolution } from '../../src/services/atomicEvolution.js';
import type { IntentManifest } from '../../src/services/intentContract.js';

function tf(id: string, expression: string) {
  return { id, type: 'transform', title: id, position: { x: 0, y: 0 }, config: { kind: 'transform', expression } };
}
const trigger = { id: 'T', type: 'trigger', title: 'T', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } };

function graph(nodes: object[], edges: Array<{ id: string; source: string; target: string }>): WorkflowGraph {
  return { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges } as unknown as WorkflowGraph;
}

describe('evaluateEvolution — the green ratchet', () => {
  it('accepts an additive, coupling-clean evolution', () => {
    const base = graph([trigger, tf('P', '({ items: [] })')], [{ id: 'e1', source: 'T', target: 'P' }]);
    const merged = graph(
      [trigger, tf('P', '({ items: [] })'), tf('A', '({ ok: true })')],
      [{ id: 'e1', source: 'T', target: 'P' }, { id: 'e2', source: 'P', target: 'A' }],
    );
    const decision = evaluateEvolution(base, merged);
    expect(decision.ok).toBe(true);
  });

  it('rejects a NEW coupling break (reads a path no upstream produces)', () => {
    const base = graph([trigger, tf('P', '({ items: [] })')], [{ id: 'e1', source: 'T', target: 'P' }]);
    const merged = graph(
      [trigger, tf('P', '({ items: [] })'), tf('Q', '({ bad: input.missing })')],
      [{ id: 'e1', source: 'T', target: 'P' }, { id: 'e2', source: 'P', target: 'Q' }],
    );
    const decision = evaluateEvolution(base, merged);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.regressions.some((r) => r.code === 'COUPLING_BREAK' && r.nodeId === 'Q')).toBe(true);
    }
  });

  it('does NOT count a pre-existing coupling error as a regression', () => {
    const broken = [trigger, tf('P', '({ items: [] })'), tf('Q', '({ bad: input.missing })')];
    const brokenEdges = [{ id: 'e1', source: 'T', target: 'P' }, { id: 'e2', source: 'P', target: 'Q' }];
    const base = graph(broken, brokenEdges);
    // merged keeps the pre-existing break and adds an unrelated clean node.
    const merged = graph([...broken, tf('R', '({ z: 1 })')], [...brokenEdges, { id: 'e3', source: 'P', target: 'R' }]);
    const decision = evaluateEvolution(base, merged);
    expect(decision.ok).toBe(true); // the ratchet is monotonic — never make it WORSE, not "must be perfect"
  });

  it('rejects an approval bypass (`|| true` before an irreversible action)', () => {
    const base = graph([trigger, tf('P', '({ items: [] })')], [{ id: 'e1', source: 'T', target: 'P' }]);
    const merged = graph(
      [trigger, tf('P', '({ items: [] })'), tf('G', '({ approved: gate || true })')],
      [{ id: 'e1', source: 'T', target: 'P' }, { id: 'e2', source: 'P', target: 'G' }],
    );
    const decision = evaluateEvolution(base, merged);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.regressions.some((r) => r.code === 'AUTO_APPROVAL_BYPASS')).toBe(true);
  });

  it('surfaces a dropped capability as a WARNING, not a hard regression', () => {
    const prior: IntentManifest = {
      version: 1,
      capabilities: { agentWorkers: 1, externalFetch: 0, integrations: [], persistence: 0 },
      createdAt: new Date().toISOString(),
    };
    const clean = graph([trigger, tf('A', '({ ok: true })')], [{ id: 'e1', source: 'T', target: 'A' }]);
    const decision = evaluateEvolution(clean, clean, prior); // 0 agent workers vs prior 1
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.warnings.length).toBeGreaterThan(0);
  });
});
