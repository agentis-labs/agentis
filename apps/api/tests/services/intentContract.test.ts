import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { deriveIntentManifest, checkIntentIntegrity } from '../../src/services/intentContract.js';

const N = (id: string, kind: string, config: Record<string, unknown> = {}) =>
  ({ id, type: kind, title: id, position: { x: 0, y: 0 }, config: { kind, ...config } });
const G = (nodes: unknown[]) => ({ nodes, edges: [] } as unknown as WorkflowGraph);

describe('intentContract — approval integrity', () => {
  it('flags a `|| true` approval bypass (the deploy-contract-input bug)', () => {
    const g = G([N('T', 'trigger', { triggerType: 'manual' }), N('appr', 'transform', { expression: '({ approved: input.gate.ok || true })' })]);
    expect(checkIntentIntegrity(g).some((x) => x.code === 'AUTO_APPROVAL_BYPASS' && x.nodeId === 'appr')).toBe(true);
  });

  it('flags a constant `approved: true`', () => {
    const g = G([N('appr', 'transform', { expression: '({ approved: true, note: "x" })' })]);
    expect(checkIntentIntegrity(g).some((x) => x.code === 'AUTO_APPROVAL_BYPASS')).toBe(true);
  });

  it('does NOT flag a computed approval', () => {
    const g = G([N('appr', 'transform', { expression: '({ approved: input.gate.passed === true })' })]);
    expect(checkIntentIntegrity(g).some((x) => x.code === 'AUTO_APPROVAL_BYPASS')).toBe(false);
  });
});

describe('intentContract — capability preservation (anti-gut)', () => {
  const full = G([
    N('T', 'trigger', { triggerType: 'manual' }),
    N('scout', 'agent_task', { prompt: 'find', outputKeys: ['candidates'] }),
    N('build', 'agent_task', { prompt: 'build', outputKeys: ['ok'] }),
    N('deploy', 'integration', { integrationId: 'vercel', operationId: 'deploy', inputs: {} }),
  ]);

  it('flags an edit that removes agent workers (replacing real work with stubs)', () => {
    const prior = deriveIntentManifest(full);
    const gutted = G([
      N('T', 'trigger', { triggerType: 'manual' }),
      N('scout', 'transform', { expression: '({ candidates: [] })' }),
      N('build', 'transform', { expression: '({ ok: 1 })' }),
      N('deploy', 'integration', { integrationId: 'vercel', operationId: 'deploy', inputs: {} }),
    ]);
    expect(checkIntentIntegrity(gutted, prior).some((x) => x.code === 'CAPABILITY_REMOVED' && /agent worker/.test(x.message))).toBe(true);
  });

  it('flags dropping an integration the workflow was built with', () => {
    const prior = deriveIntentManifest(full);
    const noDeploy = G([N('T', 'trigger', { triggerType: 'manual' }), N('scout', 'agent_task', { prompt: 'find', outputKeys: ['candidates'] }), N('build', 'agent_task', { prompt: 'build', outputKeys: ['ok'] })]);
    expect(checkIntentIntegrity(noDeploy, prior).some((x) => x.code === 'CAPABILITY_REMOVED' && /vercel/.test(x.message))).toBe(true);
  });

  it('does NOT flag when capabilities are preserved', () => {
    const prior = deriveIntentManifest(full);
    expect(checkIntentIntegrity(full, prior).some((x) => x.code === 'CAPABILITY_REMOVED')).toBe(false);
  });
});
