import type {
  ReadyQueueItem,
  WaitingInputBuffer,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeState,
  WorkflowRunState,
} from '@agentis/core';

/**
 * Builds the initial run-state from a workflow graph.
 *
 * Discovery rules:
 *  - Trigger nodes (or roots with no incoming edges) seed the ready queue.
 *  - Every other node is PENDING with a WaitingInputBuffer keyed on its
 *    incoming-edge source node ids.
 *
 * The resulting state object is the single source of truth for the engine.
 * Persistence is handled by RunStateStore — this function is pure.
 */
export function buildInitialRunState(args: {
  runId: string;
  workflowId: string;
  graph: WorkflowGraph;
  inputs: Record<string, unknown>;
}): WorkflowRunState {
  const { runId, workflowId, graph, inputs } = args;

  const incomingByTarget = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = incomingByTarget.get(edge.target) ?? [];
    list.push(edge.source);
    incomingByTarget.set(edge.target, list);
  }

  const nodeStates: Record<string, WorkflowNodeState> = {};
  const waitingInputs: Record<string, WaitingInputBuffer> = {};
  const readyQueue: ReadyQueueItem[] = [];
  const now = new Date().toISOString();

  for (const node of graph.nodes) {
    nodeStates[node.id] = { nodeId: node.id, status: 'PENDING' };
    const incoming = incomingByTarget.get(node.id) ?? [];

    if (isRoot(node, incoming)) {
      readyQueue.push({
        nodeId: node.id,
        priority: 0,
        insertedAt: now,
        // Trigger nodes get the workflow inputs as their input data; downstream
        // nodes get whatever their upstream node produces (filled in later).
        inputData: { ...inputs },
      });
      nodeStates[node.id]!.inputData = { ...inputs };
    } else {
      waitingInputs[node.id] = {
        requiredInputs: incoming.slice(),
        receivedInputs: {},
        sourceNodeIds: incoming.slice(),
      };
    }
  }

  return {
    runId,
    workflowId,
    status: 'CREATED',
    readyQueue,
    waitingInputs,
    nodeStates,
    activeExecutions: {},
    completedNodeIds: [],
    failedNodeIds: [],
    skippedNodeIds: [],
    graphRevision: 1,
    replanCount: 0,
    lastLedgerSequence: 0,
    selfHealAttempts: {},
    selfHealIncidents: {},
  };
}

function isRoot(node: WorkflowNode, incoming: string[]): boolean {
  if (incoming.length > 0) return false;
  // Even non-trigger nodes can be roots when the operator runs a sub-workflow
  // directly, so we don't strictly require type === 'trigger' here.
  return true;
}
