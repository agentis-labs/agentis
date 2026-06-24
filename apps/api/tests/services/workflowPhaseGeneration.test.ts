import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { layoutBuiltWorkflowGraph } from '../../src/services/agentisToolHandlers/build.js';

function graph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'F', type: 'http_request', title: 'Fetch', position: { x: 0, y: 0 }, config: { kind: 'http_request', method: 'GET', url: 'https://example.com' } },
      { id: 'A', type: 'agent_task', title: 'Analyze', position: { x: 0, y: 0 }, config: { kind: 'agent_task', agentRole: 'analyst', capabilityTags: [], prompt: 'Analyze', inputKeys: [], outputKeys: [] } },
      { id: 'R', type: 'return_output', title: 'Return', position: { x: 0, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [
      { id: 'e1', source: 'T', target: 'F' },
      { id: 'e2', source: 'F', target: 'A' },
      { id: 'e3', source: 'A', target: 'R' },
    ],
  };
}

describe('workflow phase generation', () => {
  it('adds ordered phases to a new complex workflow', () => {
    const result = layoutBuiltWorkflowGraph(graph(), { existingWorkflow: false });
    expect(result.phases?.length).toBeGreaterThanOrEqual(2);
    expect(result.phases?.flatMap((phase) => phase.nodeIds).sort()).toEqual(['A', 'F', 'R', 'T']);
    expect(result.nodes[1]!.position.x).toBeGreaterThan(result.nodes[0]!.position.x);
  });

  it('does not introduce phases while revising an existing workflow', () => {
    const result = layoutBuiltWorkflowGraph(graph(), { existingWorkflow: true });
    expect(result.phases).toBeUndefined();
  });

  it('can explicitly organize an existing workflow into visual phases', () => {
    const result = layoutBuiltWorkflowGraph(graph(), { existingWorkflow: true, replacePhases: true });
    expect(result.phases?.length).toBeGreaterThanOrEqual(2);
    expect(result.nodes[1]!.position.x).toBeGreaterThan(result.nodes[0]!.position.x);
  });
});
