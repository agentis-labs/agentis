import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { decideRecoveryPolicy, recoveryFailureFingerprint, repairPlanFingerprint } from '../../src/services/workflow/workflowRecoveryPolicy.js';

function graph(kind: 'transform' | 'http_request' | 'agent_task', patch = ''): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Start', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      kind === 'transform'
        ? { id: 'N', type: kind, title: 'Transform', position: { x: 1, y: 0 }, config: { kind, expression: patch || 'input.value', outputKeys: [] } }
        : kind === 'http_request'
          ? { id: 'N', type: kind, title: 'Call API', position: { x: 1, y: 0 }, config: { kind, url: patch || 'https://example.test/a', method: 'GET', outputKeys: [] } }
          : { id: 'N', type: kind, title: 'Agent', position: { x: 1, y: 0 }, config: { kind, prompt: patch || 'summarize', inputKeys: [], outputKeys: [] } },
    ] as WorkflowGraph['nodes'],
    edges: [{ id: 'edge', source: 'T', target: 'N' }],
  };
}

describe('workflow recovery policy', () => {
  it('auto-applies guarded internal repairs', () => {
    const decision = decideRecoveryPolicy('guarded', graph('transform', 'input.a'), graph('transform', 'input.b'));
    expect(decision.requiresApproval).toBe(false);
    expect(decision.impact.impact).toBe('internal');
  });

  it('requires confirmation for changed outward or unknown-effect steps only in guarded mode', () => {
    expect(decideRecoveryPolicy('guarded', graph('http_request', 'https://one.test'), graph('http_request', 'https://two.test')).requiresApproval).toBe(true);
    expect(decideRecoveryPolicy('guarded', graph('agent_task', 'draft'), graph('agent_task', 'send')).requiresApproval).toBe(true);
    expect(decideRecoveryPolicy('bypass', graph('http_request', 'https://one.test'), graph('http_request', 'https://two.test')).requiresApproval).toBe(false);
  });

  it('uses stable fingerprints to stop restart-reset and duplicate-plan loops', () => {
    expect(recoveryFailureFingerprint('A', 'timeout at 2026-01-01T01:02:03Z request 123'))
      .toBe(recoveryFailureFingerprint('A', 'timeout at 2027-02-02T01:02:03Z request 999'));
    expect(repairPlanFingerprint({ b: 2, a: [1] })).toBe(repairPlanFingerprint({ a: [1], b: 2 }));
  });
});
