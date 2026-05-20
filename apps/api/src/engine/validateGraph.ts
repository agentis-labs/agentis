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
    // Per-kind semantic validation. Required config fields are caught at save
    // time, not at run time. Agent task lacking an agentId is a warning — the
    // canvas can assign one later from a capability tag match.
    const kind = node.config.kind;
    switch (kind) {
      case 'agent_task':
        if (!node.config.agentId && (!node.config.capabilityTags || node.config.capabilityTags.length === 0)) {
          warnings.push(`Node ${node.id} (${kind}): no agentId or capabilityTags — runs will fail until one is assigned`);
        }
        break;
      case 'skill_task':
        if (!node.config.skillId) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (skill_task) missing skillId`);
        }
        break;
      case 'integration':
        if (!node.config.integrationId) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (integration) missing integrationId`);
        }
        if (!node.config.operationId) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (integration) missing operationId`);
        }
        break;
      case 'http_request':
        if (!node.config.url) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (http_request) missing url`);
        }
        if (!node.config.method) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (http_request) missing method`);
        }
        break;
      case 'transform':
        if (!node.config.expression) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (transform) missing expression`);
        }
        break;
      case 'filter':
        if (!node.config.condition) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (filter) missing condition`);
        }
        break;
      case 'wait':
        if (typeof node.config.delayMs !== 'number' || node.config.delayMs < 0) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (wait) requires non-negative delayMs`);
        }
        break;
      case 'workflow_store':
        if (!Array.isArray(node.config.operations) || node.config.operations.length === 0) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (workflow_store) must declare at least one operation`);
        }
        break;
      case 'evaluator':
        if (!node.config.targetPath) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (evaluator) missing targetPath`);
        }
        if (!node.config.criteria) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (evaluator) missing criteria`);
        }
        break;
      case 'guardrails':
        if (!Array.isArray(node.config.rules) || node.config.rules.length === 0) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (guardrails) must declare at least one rule`);
        }
        break;
      case 'loop':
        if (!node.config.bodyWorkflowId) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (loop) missing bodyWorkflowId`);
        }
        if (!node.config.itemsExpression) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (loop) missing itemsExpression`);
        }
        if (!node.config.outputArrayKey) {
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} (loop) missing outputArrayKey`);
        }
        break;
      default:
        break;
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
