/**
 * @agentis/core schemas/workflow — workflowGraph + node configs.
 */

import { describe, it, expect } from 'vitest';
import { schemas } from '@agentis/core';

const validGraph = {
  version: 1 as const,
  nodes: [
    {
      id: 'n1',
      type: 'trigger' as const,
      title: 'Manual',
      position: { x: 0, y: 0 },
      config: { kind: 'trigger' as const, triggerType: 'manual' as const },
    },
    {
      id: 'n2',
      type: 'skill_task' as const,
      title: 'Echo',
      position: { x: 100, y: 0 },
      config: { kind: 'skill_task' as const, skillId: 'echo' },
    },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
  viewport: { x: 0, y: 0, zoom: 1 },
};

describe('workflowGraphSchema', () => {
  it('accepts a minimal valid graph', () => {
    expect(() => schemas.workflowGraphSchema.parse(validGraph)).not.toThrow();
  });

  it('preserves the optional output declaration flag', () => {
    const parsed = schemas.workflowGraphSchema.parse({
      ...validGraph,
      nodes: [
        {
          ...validGraph.nodes[0],
          config: { ...validGraph.nodes[0].config, isOutput: true },
        },
        validGraph.nodes[1],
      ],
    });
    expect(parsed.nodes[0]!.config.isOutput).toBe(true);
  });

  it('rejects unknown version', () => {
    expect(() =>
      schemas.workflowGraphSchema.parse({ ...validGraph, version: 2 as unknown as 1 }),
    ).toThrow();
  });

  it('rejects empty node id', () => {
    const bad = { ...validGraph, nodes: [{ ...validGraph.nodes[0], id: '' }, validGraph.nodes[1]] };
    expect(() => schemas.workflowGraphSchema.parse(bad)).toThrow();
  });

  it('rejects node title > 255 chars', () => {
    const bad = {
      ...validGraph,
      nodes: [{ ...validGraph.nodes[0], title: 'x'.repeat(256) }, validGraph.nodes[1]],
    };
    expect(() => schemas.workflowGraphSchema.parse(bad)).toThrow();
  });

  it('requires numeric x/y in position', () => {
    const bad = {
      ...validGraph,
      nodes: [
        {
          ...validGraph.nodes[0],
          position: { x: 'left', y: 0 } as unknown as { x: number; y: number },
        },
        validGraph.nodes[1],
      ],
    };
    expect(() => schemas.workflowGraphSchema.parse(bad)).toThrow();
  });

  it('accepts router with at least one branch', () => {
    const ok = {
      ...validGraph,
      nodes: [
        ...validGraph.nodes,
        {
          id: 'n3',
          type: 'router' as const,
          title: 'Branch',
          position: { x: 200, y: 0 },
          config: {
            kind: 'router' as const,
            routingMode: 'first_match' as const,
            branches: [{ branchId: 'b1', label: 'yes', condition: 'inputs.x > 0' }],
          },
        },
      ],
    };
    expect(() => schemas.workflowGraphSchema.parse(ok)).not.toThrow();
  });

  it('rejects router with zero branches', () => {
    const bad = {
      ...validGraph,
      nodes: [
        ...validGraph.nodes,
        {
          id: 'n3',
          type: 'router' as const,
          title: 'Branch',
          position: { x: 200, y: 0 },
          config: {
            kind: 'router' as const,
            routingMode: 'first_match' as const,
            branches: [],
          },
        },
      ],
    };
    expect(() => schemas.workflowGraphSchema.parse(bad)).toThrow();
  });

  it('checkpoint accepts manual / auto_after_timeout modes', () => {
    for (const mode of ['manual', 'auto_after_timeout'] as const) {
      const ok = {
        ...validGraph,
        nodes: [
          ...validGraph.nodes,
          {
            id: 'n3',
            type: 'checkpoint' as const,
            title: 'Approve',
            position: { x: 200, y: 0 },
            config: { kind: 'checkpoint' as const, approvalMode: mode },
          },
        ],
      };
      expect(() => schemas.workflowGraphSchema.parse(ok)).not.toThrow();
    }
  });

  it('scratchpad config requires a key', () => {
    const bad = {
      ...validGraph,
      nodes: [
        ...validGraph.nodes,
        {
          id: 'n3',
          type: 'scratchpad' as const,
          title: 'Pad',
          position: { x: 200, y: 0 },
          config: { kind: 'scratchpad' as const, operation: 'read' as const, key: '' },
        },
      ],
    };
    expect(() => schemas.workflowGraphSchema.parse(bad)).toThrow();
  });

  it('agent_task requires a non-empty prompt', () => {
    const bad = {
      ...validGraph,
      nodes: [
        ...validGraph.nodes,
        {
          id: 'n3',
          type: 'agent_task' as const,
          title: 'Ask',
          position: { x: 200, y: 0 },
          config: { kind: 'agent_task' as const, prompt: '' },
        },
      ],
    };
    expect(() => schemas.workflowGraphSchema.parse(bad)).toThrow();
  });

  it('edges with optional condition + handles parse', () => {
    const ok = {
      ...validGraph,
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'out', targetHandle: 'in', condition: 'true' },
      ],
    };
    expect(() => schemas.workflowGraphSchema.parse(ok)).not.toThrow();
  });
});
