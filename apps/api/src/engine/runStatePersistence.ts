/**
 * runStatePersistence — how a `WorkflowRunState` is shaped for the DB.
 *
 * The full in-memory run state inlines every node's `inputData` and
 * `outputData`. In a fan-in pipeline the same payload is copied at every hop
 * (an upstream node's `outputData` becomes the next node's `inputData`, then
 * its `outputData`, and so on), so the persisted blob balloons to many MB and
 * is rewritten synchronously on every checkpoint — stalling the event loop.
 *
 * `toPersistedRunState` produces the shape we actually store: it drops
 * `inputData` for nodes that have reached a terminal, never-re-dispatched
 * status (COMPLETED / SKIPPED). That input is pure historical duplication —
 * it equals the upstream nodes' `outputData`, which we retain (downstream
 * `{{nodes.X.output}}` templates resolve from it) and which the run detail view
 * already surfaces per upstream node. Resume, replay and self-heal never read a
 * COMPLETED/SKIPPED node's `inputData`:
 *   - WAITING / RUNNING / PENDING nodes keep `inputData` (needed to re-dispatch
 *     after a crash),
 *   - FAILED nodes keep it (self-heal retries with the recorded input).
 *
 * The transform is a shallow copy that only drops references — it never
 * deep-clones payloads and never mutates the live state.
 */

import type { WorkflowRunState, WorkflowNodeState } from '@agentis/core';

/** Node statuses whose `inputData` is safe to omit from the persisted snapshot. */
function isRedundantInputStatus(status: WorkflowNodeState['status']): boolean {
  return status === 'COMPLETED' || status === 'SKIPPED';
}

/**
 * Shape a run state for durable storage. Returns the same object when there is
 * nothing to trim (no allocation on the common early-run path), otherwise a
 * shallow copy with terminal nodes' `inputData` stripped.
 */
export function toPersistedRunState(state: WorkflowRunState): Record<string, unknown> {
  let trimmedNodeStates: Record<string, WorkflowNodeState> | undefined;
  for (const [nodeId, ns] of Object.entries(state.nodeStates)) {
    if (ns.inputData === undefined || !isRedundantInputStatus(ns.status)) continue;
    trimmedNodeStates ??= { ...state.nodeStates };
    const { inputData: _dropped, ...rest } = ns;
    // `inputOmitted` keeps the omission legible to the run detail view instead
    // of an ambiguous "no input recorded".
    trimmedNodeStates[nodeId] = { ...rest, inputOmitted: true };
  }
  if (!trimmedNodeStates) return state as unknown as Record<string, unknown>;
  return { ...state, nodeStates: trimmedNodeStates };
}
