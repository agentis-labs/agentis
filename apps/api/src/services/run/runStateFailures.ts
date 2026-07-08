import type { WorkflowNodeState, WorkflowRunState } from '@agentis/core';

export function isErroredNodeState(nodeState: WorkflowNodeState | null | undefined): boolean {
  if (!nodeState) return false;
  if (nodeState.status === 'FAILED') return true;
  return nodeState.status === 'COMPLETED' && typeof nodeState.error === 'string' && nodeState.error.trim().length > 0;
}

export function collectFailedNodeIds(state: WorkflowRunState | null | undefined): string[] {
  if (!state) return [];
  const ids = new Set<string>(state.failedNodeIds ?? []);
  for (const [nodeId, nodeState] of Object.entries(state.nodeStates ?? {})) {
    if (isErroredNodeState(nodeState)) ids.add(nodeId);
  }
  return [...ids];
}

export function firstFailedNodeId(state: WorkflowRunState | null | undefined): string | null {
  return collectFailedNodeIds(state)[0] ?? null;
}

export function failedNodeCount(state: WorkflowRunState | null | undefined): number {
  return collectFailedNodeIds(state).length;
}

export function isFailedNodeId(state: WorkflowRunState | null | undefined, nodeId: string): boolean {
  if (!state) return false;
  return state.failedNodeIds?.includes(nodeId) === true || isErroredNodeState(state.nodeStates?.[nodeId]);
}
