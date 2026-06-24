import { useSyncExternalStore } from 'react';

export const OPEN_RUN_MODAL_EVENT = 'agentis:open-run-modal';
export const FOCUS_WORKFLOW_NODE_EVENT = 'agentis:focus-workflow-node';

export interface OpenRunModalDetail {
  runId?: string | null;
  workflowId?: string | null;
  focusNodeId?: string | null;
  source?: string;
  parentRoute?: string;
}

export interface RunModalSnapshot extends OpenRunModalDetail {
  open: boolean;
  openedAt?: number;
}

const CLOSED: RunModalSnapshot = { open: false };

let snapshot: RunModalSnapshot = CLOSED;
const listeners = new Set<() => void>();

function currentRoute(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function emit() {
  for (const listener of listeners) listener();
}

export function getRunModalSnapshot(): RunModalSnapshot {
  return snapshot;
}

export function subscribeRunModal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openRunModal(detail: OpenRunModalDetail): void {
  if (!detail.runId && !detail.workflowId) return;
  snapshot = {
    ...detail,
    runId: detail.runId ?? null,
    workflowId: detail.workflowId ?? null,
    focusNodeId: detail.focusNodeId ?? null,
    parentRoute: detail.parentRoute ?? currentRoute(),
    open: true,
    openedAt: Date.now(),
  };
  emit();
}

export function closeRunModal(): void {
  snapshot = CLOSED;
  emit();
}

export function useRunModalSnapshot(): RunModalSnapshot {
  return useSyncExternalStore(subscribeRunModal, getRunModalSnapshot, getRunModalSnapshot);
}

export function dispatchFocusWorkflowNode(nodeId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FOCUS_WORKFLOW_NODE_EVENT, { detail: { nodeId } }));
}
