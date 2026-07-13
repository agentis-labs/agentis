/**
 * toPersistedRunState — the shape a run's state takes on disk.
 *
 * The persisted snapshot is a resume cache (the ledger is the replay source of
 * truth), so it drops the historical duplication that makes the blob balloon:
 * a terminal node's `inputData` equals its upstream nodes' retained `outputData`.
 * Only COMPLETED/SKIPPED inputs are dropped — WAITING/RUNNING/PENDING (needed to
 * re-dispatch on resume) and FAILED (self-heal retries with it) are kept.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowRunState, WorkflowNodeState, WorkflowNodeStatus } from '@agentis/core';
import { toPersistedRunState } from '../../src/engine/runStatePersistence.js';

function node(status: WorkflowNodeStatus): WorkflowNodeState {
  return {
    nodeId: `n-${status}`,
    status,
    inputData: { big: 'x'.repeat(1000) },
    outputData: { result: 'kept' },
  };
}

function state(nodeStates: Record<string, WorkflowNodeState>): WorkflowRunState {
  return {
    runId: 'r1',
    workflowId: 'wf1',
    status: 'RUNNING',
    readyQueue: [],
    waitingInputs: {},
    nodeStates,
    activeExecutions: {},
    completedNodeIds: [],
    failedNodeIds: [],
    skippedNodeIds: [],
    graphRevision: 0,
    replanCount: 0,
    lastLedgerSequence: 0,
  };
}

describe('toPersistedRunState', () => {
  it('drops inputData for COMPLETED and SKIPPED nodes and marks the omission', () => {
    const persisted = toPersistedRunState(state({
      done: node('COMPLETED'),
      skip: node('SKIPPED'),
    }));
    const nodeStates = (persisted as unknown as WorkflowRunState).nodeStates;
    expect(nodeStates.done!.inputData).toBeUndefined();
    expect(nodeStates.done!.inputOmitted).toBe(true);
    expect(nodeStates.skip!.inputData).toBeUndefined();
    expect(nodeStates.skip!.inputOmitted).toBe(true);
    // Output is downstream nodes' template source — always retained.
    expect(nodeStates.done!.outputData).toEqual({ result: 'kept' });
  });

  it('keeps inputData for non-terminal and FAILED nodes (needed to resume / self-heal)', () => {
    const persisted = toPersistedRunState(state({
      pending: node('PENDING'),
      waiting: node('WAITING'),
      running: node('RUNNING'),
      failed: node('FAILED'),
    }));
    const nodeStates = (persisted as unknown as WorkflowRunState).nodeStates;
    for (const id of ['pending', 'waiting', 'running', 'failed']) {
      expect(nodeStates[id]!.inputData).toBeDefined();
      expect(nodeStates[id]!.inputOmitted).toBeUndefined();
    }
  });

  it('does not mutate the live state and returns it unchanged when nothing is trimmable', () => {
    const live = state({ running: node('RUNNING') });
    const persisted = toPersistedRunState(live);
    // No terminal nodes with input → same reference, zero allocation.
    expect(persisted).toBe(live as unknown as Record<string, unknown>);
    // The live COMPLETED node keeps its input (trim only touches the copy).
    const withDone = state({ done: node('COMPLETED') });
    toPersistedRunState(withDone);
    expect(withDone.nodeStates.done!.inputData).toBeDefined();
  });
});
