/**
 * WaitingInputBuffer — V1-SPEC §3.3, §6.3 spec-named module.
 *
 * Tracks downstream nodes that are still missing required upstream
 * outputs. The engine populates this from `buildInitialRunState()` and
 * decrements `requiredInputs` as each upstream node completes. When a
 * node's `requiredInputs` becomes empty it is moved to the `ReadyQueue`.
 *
 * Like `ReadyQueue`, this is a thin operational facade over the
 * `WorkflowRunState.waitingInputs` map so the engine code can read like
 * the spec.
 */

import type { WorkflowRunState } from '@agentis/core';

type Waiting = WorkflowRunState['waitingInputs'][string];

export class WaitingInputBuffer {
  constructor(private readonly map: WorkflowRunState['waitingInputs']) {}

  get(nodeId: string): Waiting | undefined {
    return this.map[nodeId];
  }

  has(nodeId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.map, nodeId);
  }

  /**
   * Mark `upstreamNodeId` as having produced output for `nodeId`. Returns
   * `true` when the downstream node now has all required inputs satisfied.
   */
  satisfy(nodeId: string, upstreamNodeId: string, payload: unknown): boolean {
    const entry = this.map[nodeId];
    if (!entry) return true;
    entry.receivedInputs[upstreamNodeId] = payload;
    entry.requiredInputs = entry.requiredInputs.filter((id) => id !== upstreamNodeId);
    return entry.requiredInputs.length === 0;
  }

  remove(nodeId: string): void {
    delete this.map[nodeId];
  }

  pendingNodeIds(): string[] {
    return Object.keys(this.map);
  }
}
