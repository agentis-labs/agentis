/**
 * Static template-reference validation (NATIVE-ADVANCEMENT Phase 1, reframed).
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { validateGraphReferences } from '../../src/engine/validateGraphReferences.js';

function node(id: string, config: Record<string, unknown>) {
  return {
    id,
    type: (config.kind as string) ?? 'agent_task',
    title: id,
    position: { x: 0, y: 0 },
    config: { kind: 'agent_task', ...config } as never,
  };
}

function graph(
  nodes: ReturnType<typeof node>[],
  edges: Array<{ source: string; target: string }>,
): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges: edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target })),
  };
}

describe('validateGraphReferences', () => {
  it('accepts a reference to an upstream node', () => {
    const g = graph(
      [node('a', { prompt: 'start' }), node('b', { prompt: 'use {{nodes.a.result}}' })],
      [{ source: 'a', target: 'b' }],
    );
    expect(validateGraphReferences(g)).toEqual([]);
  });

  it('accepts reserved namespaces', () => {
    const g = graph(
      [node('a', { prompt: '{{trigger.topic}} and {{scratchpad.x}} and {{workspace.kv.y}}' })],
      [],
    );
    expect(validateGraphReferences(g)).toEqual([]);
  });

  it('flags a dangling node reference as an error', () => {
    const g = graph([node('a', { prompt: 'use {{nodes.ghost.result}}' })], []);
    const issues = validateGraphReferences(g);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'dangling_node_ref', severity: 'error', nodeId: 'a' });
  });

  it('flags a forward (non-upstream) reference as a warning', () => {
    // b references a, but the edge goes a<-b? No: edge a->b means a is upstream of b.
    // Here we make b reference c where c is NOT upstream of b.
    const g = graph(
      [node('b', { prompt: '{{nodes.c.result}}' }), node('c', { prompt: 'later' })],
      [{ source: 'b', target: 'c' }], // c is downstream of b
    );
    const issues = validateGraphReferences(g);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'forward_node_ref', severity: 'warning' });
  });

  it('honors transitive ancestry (a -> b -> c, c may use a)', () => {
    const g = graph(
      [
        node('a', { prompt: 'start' }),
        node('b', { prompt: '{{nodes.a.result}}' }),
        node('c', { prompt: '{{nodes.a.result}} {{nodes.b.result}}' }),
      ],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    );
    expect(validateGraphReferences(g)).toEqual([]);
  });

  it('flags a self reference as a warning', () => {
    const g = graph([node('a', { prompt: '{{nodes.a.result}}' })], []);
    const issues = validateGraphReferences(g);
    expect(issues[0]).toMatchObject({ code: 'self_ref', severity: 'warning' });
  });

  it('supports the permissive bare-id reference form', () => {
    const g = graph(
      [node('a', { prompt: 'start' }), node('b', { prompt: '{{a.result}}' })],
      [{ source: 'a', target: 'b' }],
    );
    expect(validateGraphReferences(g)).toEqual([]);
  });

  it('flags an unknown namespace as a likely typo', () => {
    const g = graph([node('a', { prompt: '{{nods.x.y}}' })], []);
    const issues = validateGraphReferences(g);
    expect(issues[0]).toMatchObject({ code: 'unknown_namespace', severity: 'warning' });
  });

  it('dedups repeated identical references within a node', () => {
    const g = graph([node('a', { prompt: '{{nodes.ghost.x}} {{nodes.ghost.x}}' })], []);
    expect(validateGraphReferences(g)).toHaveLength(1);
  });

  it('finds references in nested config fields', () => {
    const g = graph(
      [node('h', { kind: 'http_request', url: 'https://x', method: 'POST', headers: { Authorization: '{{nodes.ghost.token}}' } })],
      [],
    );
    const issues = validateGraphReferences(g);
    expect(issues[0]).toMatchObject({ code: 'dangling_node_ref' });
  });

  it('understands $nodes references inside inline AScript fields', () => {
    const g = graph(
      [node('a', { prompt: 'start' }), node('b', { prompt: 'Count {{= $nodes.a.items.length }} for {{= $json.name }}' })],
      [{ source: 'a', target: 'b' }],
    );
    expect(validateGraphReferences(g)).toEqual([]);
  });

  it('flags dangling $nodes references inside inline AScript fields', () => {
    const g = graph([node('a', { prompt: '{{= $nodes.ghost.items.length }}' })], []);
    const issues = validateGraphReferences(g);
    expect(issues[0]).toMatchObject({ code: 'dangling_node_ref', severity: 'error' });
  });
});
