/**
 * Node capability manifests + graph fingerprint (NATIVE-ADVANCEMENT Phase 0,
 * Tasks 4 & 2).
 */
import { describe, it, expect } from 'vitest';
import {
  NODE_CAPABILITY_CATALOG,
  summarizeGraphCapabilities,
  canonicalizeGraph,
  type WorkflowGraph,
} from '@agentis/core';
import { hashWorkflowGraph } from '../../src/services/graphHash.js';

// Node kinds the engine supports (engine/validateGraph.ts SUPPORTED_NODE_KINDS).
const SUPPORTED_KINDS = [
  'trigger', 'agent_task', 'agent_session', 'extension_task', 'knowledge',
  'router', 'merge', 'checkpoint', 'subflow', 'scratchpad', 'agent_swarm',
  'dynamic_swarm', 'planner', 'artifact_collect', 'wait', 'transform', 'filter',
  'integration', 'http_request', 'workflow_store', 'workspace_store', 'evaluator',
  'guardrails', 'loop', 'parallel', 'return_output', 'artifact_save', 'browser',
];

function node(id: string, config: Record<string, unknown>) {
  return {
    id,
    type: config.kind as string,
    title: id,
    position: { x: 0, y: 0 },
    config: config as never,
  };
}

function graph(nodes: ReturnType<typeof node>[]): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges: [],
  };
}

describe('NODE_CAPABILITY_CATALOG', () => {
  it('covers every supported node kind (no catalog gaps)', () => {
    const missing = SUPPORTED_KINDS.filter((k) => !NODE_CAPABILITY_CATALOG[k]);
    expect(missing).toEqual([]);
  });

  it('keeps the manifest nodeKind in sync with its catalog key', () => {
    for (const [key, manifest] of Object.entries(NODE_CAPABILITY_CATALOG)) {
      expect(manifest.nodeKind).toBe(key);
    }
  });
});

describe('summarizeGraphCapabilities', () => {
  it('reports a purely-local workflow as having no external access', () => {
    const g = graph([
      node('a', { kind: 'trigger' }),
      node('b', { kind: 'transform', expression: '1+1' }),
      node('c', { kind: 'return_output' }),
    ]);
    const s = summarizeGraphCapabilities(g);
    expect(s.sendsDataExternally).toBe(false);
    expect(s.hasUnrestrictedNetwork).toBe(false);
    expect(s.runsCode).toBe(false);
    expect(s.requiresCredentials).toEqual([]);
    expect(s.headline).toContain('purely local');
  });

  it('extracts the static host from an http_request URL', () => {
    const g = graph([node('h', { kind: 'http_request', url: 'https://api.example.com/v1/x', method: 'GET' })]);
    const s = summarizeGraphCapabilities(g);
    expect(s.externalHosts).toContain('api.example.com');
    expect(s.requiresCredentials).toContain('http_auth');
  });

  it('does not invent a host for a templated URL', () => {
    const g = graph([node('h', { kind: 'http_request', url: 'https://{{secret.host}}/x', method: 'GET' })]);
    const s = summarizeGraphCapabilities(g);
    expect(s.externalHosts).toEqual([]);
  });

  it('flags unbounded network + model credentials for agent nodes', () => {
    const g = graph([node('a', { kind: 'agent_task', prompt: 'do it', agentId: 'x' })]);
    const s = summarizeGraphCapabilities(g);
    expect(s.hasUnrestrictedNetwork).toBe(true);
    expect(s.sendsDataExternally).toBe(true);
    expect(s.requiresCredentials).toContain('model_provider');
  });

  it('flags code execution for extension and browser nodes', () => {
    const g = graph([
      node('e', { kind: 'extension_task', extensionId: 'x', operationName: 'run' }),
      node('b', { kind: 'browser', operation: 'goto' }),
    ]);
    const s = summarizeGraphCapabilities(g);
    expect(s.runsCode).toBe(true);
    expect(s.writesFilesystem).toBe(true);
  });

  it('records unknown node kinds rather than throwing', () => {
    const g = graph([node('z', { kind: 'totally_made_up' })]);
    const s = summarizeGraphCapabilities(g);
    expect(s.unknownNodeKinds).toContain('totally_made_up');
  });
});

describe('hashWorkflowGraph (divergence fingerprint)', () => {
  const base = graph([
    node('a', { kind: 'agent_task', prompt: 'hello', agentId: 'x' }),
    node('b', { kind: 'return_output' }),
  ]);

  it('is stable for the same graph', () => {
    expect(hashWorkflowGraph(base)).toBe(hashWorkflowGraph(base));
  });

  it('ignores cosmetic position/viewport changes', () => {
    const moved = { ...base, viewport: { x: 999, y: 999, zoom: 3 }, nodes: base.nodes.map((n) => ({ ...n, position: { x: 500, y: 500 } })) };
    expect(hashWorkflowGraph(moved)).toBe(hashWorkflowGraph(base));
  });

  it('is order-independent for nodes', () => {
    const reordered = { ...base, nodes: [...base.nodes].reverse() };
    expect(hashWorkflowGraph(reordered)).toBe(hashWorkflowGraph(base));
  });

  it('changes when behaviour-significant config changes', () => {
    const edited = { ...base, nodes: base.nodes.map((n) => (n.id === 'a' ? { ...n, config: { ...(n.config as object), prompt: 'goodbye' } as never } : n)) };
    expect(hashWorkflowGraph(edited)).not.toBe(hashWorkflowGraph(base));
  });

  it('produces a 64-char hex sha256', () => {
    expect(hashWorkflowGraph(base)).toMatch(/^[0-9a-f]{64}$/);
    // canonical form is valid JSON
    expect(() => JSON.parse(canonicalizeGraph(base))).not.toThrow();
  });
});
