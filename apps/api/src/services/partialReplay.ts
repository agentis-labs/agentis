/**
 * PartialReplayService — V1-SPEC §6.7.
 *
 * Always creates a NEW WorkflowRun row with `parentRunId = sourceRunId`
 * and `replanCount = parent.replanCount + 1`. Never re-executes nodes
 * whose results we want to keep — instead the new run starts with a
 * pre-seeded `nodeStates` map that copies the chosen completed nodes from
 * the source.
 *
 * Four supported modes:
 *  - replay-from-node: copies node states for everything UPSTREAM of the
 *    target node; the target and its descendants get reset to PENDING.
 *  - replay-failed-branch: copies node states for everything not in the
 *    failed branch; failed nodes and downstream peers are reset.
 *  - replay-with-edited-node: like replay-from-node but the target node's
 *    config is overridden with the supplied patch. Patch is applied to a
 *    deep-cloned graph; the source workflow is untouched.
 *  - replay-from-checkpoint: copies node states for everything before
 *    the checkpoint and clears all approvals from the source — the new
 *    run will request fresh ones at the same checkpoint.
 *
 * Side-effect safety:
 *  - We NEVER call adapters/extensions again for nodes we keep.
 *  - All approvals from the source run are NOT carried over; if the new
 *    run reaches a checkpoint it raises a fresh ApprovalRequest.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  AgentisError,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowRunState,
} from '@agentis/core';
import { buildInitialRunState } from '../engine/initialRunState.js';
import { collectFailedNodeIds } from './run/runStateFailures.js';

export type ReplayMode =
  | 'replay-from-node'
  | 'replay-failed-branch'
  | 'replay-with-edited-node'
  | 'replay-from-checkpoint';

export interface ReplayArgs {
  workspaceId: string;
  sourceRunId: string;
  mode: ReplayMode;
  /** Target node id (mode 1, 3) or checkpoint node id (mode 4). */
  targetNodeId?: string;
  /** Patch for replay-with-edited-node — replaces the target node's config. */
  nodeConfigPatch?: Record<string, unknown>;
  userId: string;
}

export class PartialReplayService {
  constructor(private readonly db: AgentisSqliteDb) {}

  prepare(args: ReplayArgs): {
    runId: string;
    workflowId: string;
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    inputs: Record<string, unknown>;
    initialState: WorkflowRunState;
    graph: WorkflowGraph;
  } {
    const source = this.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, args.sourceRunId))
      .get();
    if (!source || source.workspaceId !== args.workspaceId) {
      throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', `source run ${args.sourceRunId} not found`);
    }
    if (!source.workflowId) {
      throw new AgentisError('WORKFLOW_RUN_INVALID_STATE', 'ephemeral runs cannot be replayed as saved workflows');
    }
    const workflow = this.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, source.workflowId))
      .get();
    if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${source.workflowId} not found`);

    const baseGraph = workflow.graph as WorkflowGraph;
    const sourceState = source.runState as WorkflowRunState;

    // Deep-clone the graph so we never mutate the canonical workflow row.
    const graph: WorkflowGraph = structuredClone(baseGraph);

    if (args.mode === 'replay-with-edited-node') {
      if (!args.targetNodeId || !args.nodeConfigPatch) {
        throw new AgentisError('REPLAY_TARGET_INVALID', 'replay-with-edited-node requires targetNodeId and nodeConfigPatch');
      }
      const node = graph.nodes.find((n) => n.id === args.targetNodeId);
      if (!node) throw new AgentisError('REPLAY_TARGET_INVALID', `node ${args.targetNodeId} not in graph`);
      node.config = { ...(node.config as object), ...args.nodeConfigPatch } as unknown as WorkflowNode['config'];
    }

    // Compute the set of nodes to KEEP (i.e. their completed state copies over).
    const keepIds = this.#computeKeepSet({ mode: args.mode, graph, sourceState, targetNodeId: args.targetNodeId });

    const runId = randomUUID();
    // V1 replay does not re-feed seed inputs into the trigger node — we trust
    // the preserved upstream node outputs. The new run's inputs object is
    // intentionally empty; only the readyQueue + nodeStates carry data.
    const inputs: Record<string, unknown> = {};
    const newState = buildInitialRunState({
      runId,
      workflowId: workflow.id,
      graph,
      inputs,
    });

    // Copy preserved node states from the source.
    for (const id of keepIds) {
      const ns = sourceState.nodeStates[id];
      if (ns && ns.status === 'COMPLETED' && newState.nodeStates[id]) {
        newState.nodeStates[id] = { ...ns };
        if (!newState.completedNodeIds.includes(id)) newState.completedNodeIds.push(id);
        // Anything fanning out from a kept node should pre-fill waiting buffers.
        for (const edge of graph.edges) {
          if (edge.source !== id) continue;
          const buf = newState.waitingInputs[edge.target];
          if (buf) {
            buf.receivedInputs[id] = ns.outputData ?? {};
            buf.requiredInputs = buf.requiredInputs.filter((x) => x !== id);
          }
        }
      }
    }

    // Anything in waitingInputs that has no remaining required inputs becomes ready.
    for (const [nodeId, buf] of Object.entries(newState.waitingInputs)) {
      if (buf.requiredInputs.length === 0 && !keepIds.has(nodeId)) {
        const merged: Record<string, unknown> = {};
        for (const [src, value] of Object.entries(buf.receivedInputs)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(merged, value);
          else merged[src] = value;
        }
        newState.readyQueue.push({
          nodeId,
          priority: 0,
          insertedAt: new Date().toISOString(),
          inputData: merged,
        });
        delete newState.waitingInputs[nodeId];
      }
    }

    return {
      runId,
      workflowId: workflow.id,
      workspaceId: source.workspaceId,
      ambientId: source.ambientId,
      userId: args.userId,
      inputs,
      initialState: newState,
      graph,
    };
  }

  /** Insert the new workflow_runs row carrying parentRunId and replanCount. */
  persistChildRun(args: {
    runId: string;
    workspaceId: string;
    ambientId: string | null;
    workflowId: string;
    userId: string;
    parentRunId: string;
    initialState: WorkflowRunState;
    parentReplanCount: number;
  }) {
    this.db
      .insert(schema.workflowRuns)
      .values({
        id: args.runId,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        workflowId: args.workflowId,
        userId: args.userId,
        status: 'CREATED',
        runState: args.initialState as unknown as object,
        replanCount: args.parentReplanCount + 1,
        triggerId: null,
        parentRunId: args.parentRunId,
      })
      .run();
  }

  #computeKeepSet(args: {
    mode: ReplayMode;
    graph: WorkflowGraph;
    sourceState: WorkflowRunState;
    targetNodeId?: string;
  }): Set<string> {
    const keep = new Set<string>();
    const completed = new Set(args.sourceState.completedNodeIds);
    const failed = new Set(collectFailedNodeIds(args.sourceState));

    if (args.mode === 'replay-from-node' || args.mode === 'replay-with-edited-node' || args.mode === 'replay-from-checkpoint') {
      if (!args.targetNodeId) throw new AgentisError('REPLAY_TARGET_INVALID', 'targetNodeId required');
      const ancestors = collectAncestors(args.graph, args.targetNodeId);
      for (const id of ancestors) if (completed.has(id)) keep.add(id);
      return keep;
    }
    // replay-failed-branch: keep all completed nodes that are NOT ancestors of any failed node.
    const failedAncestors = new Set<string>();
    for (const f of failed) {
      for (const a of collectAncestors(args.graph, f)) failedAncestors.add(a);
      failedAncestors.add(f);
    }
    for (const id of completed) if (!failedAncestors.has(id)) keep.add(id);
    return keep;
  }
}

function collectAncestors(graph: WorkflowGraph, nodeId: string): Set<string> {
  const ancestors = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const e of graph.edges) {
      if (e.target === cur && !ancestors.has(e.source)) {
        ancestors.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return ancestors;
}
