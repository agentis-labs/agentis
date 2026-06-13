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
      type: 'extension_task',
      title: n.id,
      position: { x: 0, y: 0 },
      config: {
        kind: 'extension_task',
        extensionId: 'echo',
        operationName: 'run',
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

  it('rejects a subflow node that calls the same workflow', () => {
    const g: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'self',
          type: 'subflow',
          title: 'Self',
          position: { x: 0, y: 0 },
          config: {
            kind: 'subflow',
            workflowId: 'wf-self',
            inputMapping: {},
            outputMapping: {},
          },
        },
      ],
      edges: [],
    };
    expect(() => validateWorkflowGraph(g, { currentWorkflowId: 'wf-self' })).toThrow(/own workflow/i);
  });

  it('rejects unsupported draft node kinds before execution', () => {
    const g = graph([{ id: 'a' }], []);
    (g.nodes[0]!.config as unknown as { kind: string }).kind = 'future_magic';
    expect(() => validateWorkflowGraph(g)).toThrow(/unsupported kind/i);
  });

  it('strict validation throws on incomplete node configuration', () => {
    const g = graph([{ id: 'a' }], []);
    g.nodes[0]!.config = { kind: 'extension_task' }; // missing extensionId
    expect(() => validateWorkflowGraph(g, { strict: true })).toThrow(/missing extensionId/);
    expect(() => validateWorkflowGraph(g)).toThrow(/missing extensionId/); // default should be strict
  });

  it('lenient validation permits incomplete node configuration and produces warnings', () => {
    const g = graph([{ id: 'a' }], []);
    g.nodes[0]!.config = { kind: 'extension_task' }; // missing extensionId
    const res = validateWorkflowGraph(g, { strict: false });
    expect(res.ok).toBe(true);
    expect(res.warnings).toContain('Node a (extension_task) missing extensionId or extensionSlug');
  });

  it('persists authoring drafts leniently but blocks incomplete execution nodes', () => {
    for (const config of [
      { kind: 'agent_task', prompt: '' },
      { kind: 'router', routingMode: 'first_match', branches: [] },
      { kind: 'scratchpad', operation: 'read', key: '' },
    ]) {
      const g = graph([{ id: 'a' }], []);
      g.nodes[0]!.config = config as WorkflowGraph['nodes'][number]['config'];
      expect(validateWorkflowGraph(g, { strict: false }).warnings.length).toBeGreaterThan(0);
      expect(() => validateWorkflowGraph(g)).toThrow();
    }
  });

  it('rejects router branch conditions that are not valid safe-condition syntax', () => {
    const g = graph([{ id: 'route' }], []);
    g.nodes[0]!.type = 'router';
    g.nodes[0]!.config = {
      kind: 'router',
      routingMode: 'first_match',
      branches: [
        { branchId: 'yes', label: 'Yes', condition: '{{nodes.fetch.count}} === 1' },
      ],
    };
    expect(() => validateWorkflowGraph(g)).toThrow(/invalid condition syntax/i);
  });

  it('warns in lenient mode when an edge condition uses invalid syntax', () => {
    const g = graph(
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    g.edges[0]!.condition = 'inputs.count = 1';
    const result = validateWorkflowGraph(g, { strict: false });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => /Edge e1 has invalid condition syntax/i.test(warning))).toBe(true);
  });

  it('rejects dangling node template references at the validation boundary', () => {
    const g = graph([{ id: 'a' }], []);
    g.nodes[0]!.type = 'agent_task';
    g.nodes[0]!.config = {
      kind: 'agent_task',
      prompt: 'Use {{nodes.missing.output}}',
      inputKeys: [],
      outputKeys: [],
      capabilityTags: ['analysis'],
    };
    expect(() => validateWorkflowGraph(g)).toThrow(/does not exist/i);
  });

  it('warns on forward references in lenient mode so authoring can continue', () => {
    const g: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'a',
          type: 'agent_task',
          title: 'A',
          position: { x: 0, y: 0 },
          config: {
            kind: 'agent_task',
            prompt: 'Use {{nodes.b.output}}',
            inputKeys: [],
            outputKeys: [],
            capabilityTags: ['analysis'],
          },
        },
        {
          id: 'b',
          type: 'agent_task',
          title: 'B',
          position: { x: 0, y: 0 },
          config: {
            kind: 'agent_task',
            prompt: 'Second',
            inputKeys: [],
            outputKeys: [],
            capabilityTags: ['analysis'],
          },
        },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
    };
    const result = validateWorkflowGraph(g, { strict: false });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => /not upstream/i.test(warning))).toBe(true);
  });

  function mergeGraph(requiredInputs: 'all' | 'any' | string[]): WorkflowGraph {
    return {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'a', type: 'trigger', title: 'a', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'b', type: 'trigger', title: 'b', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'm', type: 'merge', title: 'm', position: { x: 0, y: 0 }, config: { kind: 'merge', requiredInputs } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'm' },
        { id: 'e2', source: 'b', target: 'm' },
      ],
    };
  }

  it("accepts merge requiredInputs 'all' / 'any' / a valid subset", () => {
    expect(validateWorkflowGraph(mergeGraph('all')).ok).toBe(true);
    expect(validateWorkflowGraph(mergeGraph('any')).ok).toBe(true);
    expect(validateWorkflowGraph(mergeGraph(['a'])).ok).toBe(true);
    expect(validateWorkflowGraph(mergeGraph(['a', 'b'])).ok).toBe(true);
  });

  it('rejects a merge subset that names a non-incoming source', () => {
    expect(() => validateWorkflowGraph(mergeGraph(['ghost']))).toThrow(/not an incoming source/);
  });

  it('rejects an empty merge subset list', () => {
    expect(() => validateWorkflowGraph(mergeGraph([]))).toThrow(/empty requiredInputs/);
  });
});
