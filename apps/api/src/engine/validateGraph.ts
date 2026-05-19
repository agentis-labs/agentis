/**
 * Workflow validation — runs at every CREATE/UPDATE and before every patch
 * apply. Cycles, missing references, and trigger sanity must be caught at the
 * boundary; the engine assumes graph validity beyond this point.
 */

import type { WorkflowGraph } from '@agentis/core';
import { AgentisError } from '@agentis/core';

export interface ValidationResult {
  ok: true;
  warnings: string[];
}

export interface ValidateWorkflowGraphOptions {
  currentWorkflowId?: string | null;
}

export function validateWorkflowGraph(
  graph: WorkflowGraph,
  options: ValidateWorkflowGraphOptions = {},
): ValidationResult {
  const warnings: string[] = [];
  const ids = new Set<string>();

  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Duplicate node id: ${node.id}`);
    }
    ids.add(node.id);
    if (
      options.currentWorkflowId &&
      node.config.kind === 'subflow' &&
      node.config.workflowId === options.currentWorkflowId
    ) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Subflow node ${node.id} cannot call its own workflow`,
      );
    }
  }

  for (const edge of graph.edges) {
    if (!ids.has(edge.source)) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Edge ${edge.id} references missing source node ${edge.source}`,
      );
    }
    if (!ids.has(edge.target)) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Edge ${edge.id} references missing target node ${edge.target}`,
      );
    }
  }

  if (hasCycle(graph)) {
    throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Workflow graph contains a cycle');
  }

  return { ok: true, warnings };
}

function hasCycle(graph: WorkflowGraph): boolean {
  const adj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adj.get(edge.source) ?? [];
    list.push(edge.target);
    adj.set(edge.source, list);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const node of graph.nodes) color.set(node.id, WHITE);

  function dfs(id: string): boolean {
    color.set(id, GRAY);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const node of graph.nodes) {
    if ((color.get(node.id) ?? WHITE) === WHITE && dfs(node.id)) return true;
  }
  return false;
}
