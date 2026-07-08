/**
 * buildInitialRunState — pure function, V1-SPEC §6 ready-queue seeding.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { buildInitialRunState } from '../src/engine/initialRunState.js';

function makeNode(id: string, kind: 'trigger' | 'extension_task' = 'extension_task') {
  if (kind === 'trigger') {
    return {
      id,
      type: 'trigger' as const,
      title: id,
      position: { x: 0, y: 0 },
      config: { kind: 'trigger' as const, triggerType: 'manual' as const },
    };
  }
  return {
    id,
    type: 'extension_task' as const,
    title: id,
    position: { x: 0, y: 0 },
    config: {
      kind: 'extension_task' as const,
      skillId: 'echo',
      inputMapping: {},
      outputMapping: {},
    },
  };
}

function graph(
  nodes: Array<{ id: string; kind?: 'trigger' | 'extension_task' }>,
  edges: Array<{ id: string; source: string; target: string }>,
): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: nodes.map((n) => makeNode(n.id, n.kind ?? 'extension_task')),
    edges,
  };
}

describe('buildInitialRunState', () => {
  it('seeds the ready queue with trigger / root nodes', () => {
    const g = graph(
      [{ id: 't', kind: 'trigger' }, { id: 'a' }, { id: 'b' }],
      [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
      ],
    );
    const state = buildInitialRunState({
      runId: 'r1',
      workflowId: 'w1',
      graph: g,
      inputs: { x: 1 },
    });
    expect(state.runId).toBe('r1');
    expect(state.status).toBe('CREATED');
    expect(state.readyQueue.map((q) => q.nodeId)).toEqual(['t']);
    expect(state.readyQueue[0]!.inputData).toEqual({ x: 1 });
    expect(state.waitingInputs.a?.requiredInputs).toEqual(['t']);
    expect(state.waitingInputs.b?.requiredInputs).toEqual(['a']);
  });

  it('treats every node with no incoming edge as a root', () => {
    const g = graph([{ id: 'a' }, { id: 'b' }, { id: 'c' }], []);
    const state = buildInitialRunState({
      runId: 'r1',
      workflowId: 'w1',
      graph: g,
      inputs: {},
    });
    expect(state.readyQueue.map((q) => q.nodeId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('records waitingInputs for diamond topologies', () => {
    const g = graph(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'a', target: 'c' },
        { id: 'e3', source: 'b', target: 'd' },
        { id: 'e4', source: 'c', target: 'd' },
      ],
    );
    const state = buildInitialRunState({
      runId: 'r1',
      workflowId: 'w1',
      graph: g,
      inputs: {},
    });
    expect(state.waitingInputs.d?.requiredInputs.sort()).toEqual(['b', 'c']);
  });

  it('resets ledger sequence + replan counters', () => {
    const state = buildInitialRunState({
      runId: 'r1',
      workflowId: 'w1',
      graph: graph([{ id: 'a' }], []),
      inputs: {},
    });
    expect(state.lastLedgerSequence).toBe(0);
    expect(state.replanCount).toBe(0);
    expect(state.graphRevision).toBe(1);
    expect(state.failedNodeIds).toEqual([]);
  });
});
