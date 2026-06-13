/**
 * Integration operation normalization (general, all connectors).
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { bestOperationMatch, repairIntegrationOperations, validateIntegrationOperations } from '../../src/services/integrationOperationRepair.js';

const catalog = {
  agentmail: ['send_message', 'add_reaction'],
  gmail: ['send_email'],
  slack: ['send_message', 'create_channel'],
  webhook: ['post'],
};

function g(integrationId: string, operationId: string): WorkflowGraph {
  return {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: 'n', type: 'integration', title: 'Send', position: { x: 0, y: 0 }, config: { kind: 'integration', integrationId, operationId } as never }],
    edges: [],
  };
}

describe('bestOperationMatch', () => {
  it('keeps a valid operation', () => expect(bestOperationMatch('send_message', catalog.agentmail)).toBe('send_message'));
  it('maps send_email → send_message via token overlap', () => expect(bestOperationMatch('send_email', catalog.agentmail)).toBe('send_message'));
  it('uses the only operation when there is exactly one', () => expect(bestOperationMatch('whatever', catalog.webhook)).toBe('post'));
  it('returns null when nothing overlaps (no wrong guess)', () => expect(bestOperationMatch('xyz_zzz', catalog.agentmail)).toBeNull());
});

describe('repairIntegrationOperations', () => {
  it('fixes the agentmail send_email → send_message case generically', () => {
    const { graph, repairs } = repairIntegrationOperations(g('agentmail', 'send_email'), catalog);
    expect((graph.nodes[0]!.config as { operationId: string }).operationId).toBe('send_message');
    expect(repairs).toEqual([{ nodeId: 'n', integration: 'agentmail', from: 'send_email', to: 'send_message' }]);
  });
  it('leaves a valid operation untouched', () => {
    expect(repairIntegrationOperations(g('gmail', 'send_email'), catalog).repairs).toEqual([]);
  });
  it('does not touch an unknown integration (no catalog)', () => {
    expect(repairIntegrationOperations(g('acme', 'do_thing'), catalog).repairs).toEqual([]);
  });
});

describe('validateIntegrationOperations', () => {
  it('flags an unrepairable invalid operation with the supported list', () => {
    const issues = validateIntegrationOperations(g('agentmail', 'totally_unknown'), catalog);
    expect(issues[0]).toMatchObject({ integration: 'agentmail', operation: 'totally_unknown', supported: ['send_message', 'add_reaction'] });
  });
  it('passes a valid operation', () => {
    expect(validateIntegrationOperations(g('slack', 'create_channel'), catalog)).toEqual([]);
  });
});
