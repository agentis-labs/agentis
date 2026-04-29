/**
 * validateWorkflowGraph — V1-SPEC §6.6.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { AgentisError } from '@agentis/core';
import { validateWorkflowGraph } from '../src/engine/validateGraph.js';

function graph(
  nodes: Array<{ id: string }>,
  edges: Array<{ id: string; source: string; target: string }>,
): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: nodes.map((n) => ({
      id: n.id,
      type: 'skill_task',
      title: n.id,
      position: { x: 0, y: 0 },
      config: {
        kind: 'skill_task',
        skillId: 'echo',
        inputMapping: {},
        outputMapping: {},
      },
    })),
    edges,
  };
}

describe('validateWorkflowGraph', () => {
  it('accepts a linear DAG', () => {
    const g = graph(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
    );
    expect(validateWorkflowGraph(g).ok).toBe(true);
  });

  it('rejects duplicate node ids', () => {
    const g = graph([{ id: 'a' }, { id: 'a' }], []);
    expect(() => validateWorkflowGraph(g)).toThrow(AgentisError);
  });

  it('rejects edges referencing missing nodes', () => {
    const g = graph(
      [{ id: 'a' }],
      [{ id: 'e1', source: 'a', target: 'ghost' }],
    );
    expect(() => validateWorkflowGraph(g)).toThrow(/ghost/);
  });

  it('detects simple cycles', () => {
    const g = graph(
      [{ id: 'a' }, { id: 'b' }],
      [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    );
    expect(() => validateWorkflowGraph(g)).toThrow(/cycle/i);
  });

  it('detects self-loops as cycles', () => {
    const g = graph([{ id: 'a' }], [{ id: 'e1', source: 'a', target: 'a' }]);
    expect(() => validateWorkflowGraph(g)).toThrow(/cycle/i);
  });
});
