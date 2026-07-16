import { canonicalizeWorkflowGraphContracts, type HttpRequestNodeConfig, type WorkflowGraph, type WorkflowNode } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { repairIntegrationOperations, type OperationRepair } from '../integrationOperationRepair.js';
import { listIntegrationManifests } from '../integrationRegistry.js';

export interface GraphShapeRepair {
  kind:
    | 'filter_promoted_to_transform'
    | 'http_response_mapping_normalized'
    | 'router_branch_shape_normalized'
    | 'router_condition_normalized'
    | 'workflow_contract_normalized';
  nodeId: string;
  message: string;
}

export interface WorkflowGraphNormalizationResult {
  graph: WorkflowGraph;
  repairs: Array<OperationRepair | GraphShapeRepair>;
}

export function normalizeWorkflowGraph(
  db: AgentisSqliteDb,
  workspaceId: string,
  graph: WorkflowGraph,
): WorkflowGraphNormalizationResult {
  const contractNormalized = canonicalizeWorkflowGraphContracts(graph);
  const contractRepairs: GraphShapeRepair[] = contractNormalized.changed ? [{
    kind: 'workflow_contract_normalized',
    nodeId: '__graph__',
    message: 'Normalized legacy JSON-Schema input/output contracts to the canonical Agentis fields DSL.',
  }] : [];
  const shapeNormalized = normalizeLegacyNodeContracts(contractNormalized.graph);
  const operationCatalog = Object.fromEntries(
    listIntegrationManifests(db, workspaceId).map((manifest) => [
      manifest.service.toLowerCase(),
      manifest.operations,
    ]),
  );
  const operationNormalized = repairIntegrationOperations(shapeNormalized.graph, operationCatalog);
  return {
    graph: operationNormalized.graph,
    repairs: [...contractRepairs, ...shapeNormalized.repairs, ...operationNormalized.repairs],
  };
}

function normalizeLegacyNodeContracts(
  graph: WorkflowGraph,
): { graph: WorkflowGraph; repairs: GraphShapeRepair[] } {
  const repairs: GraphShapeRepair[] = [];
  let nodesChanged = false;
  const nodes = graph.nodes.map((node) => {
    const filterRepaired = repairLegacyStructuredFilter(node);
    if (filterRepaired) {
      nodesChanged = true;
      repairs.push(filterRepaired.repair);
      return filterRepaired.node;
    }
    const routerRepaired = repairLegacyRouterConfig(node);
    if (routerRepaired) {
      nodesChanged = true;
      repairs.push(...routerRepaired.repairs);
      return routerRepaired.node;
    }
    const httpRepaired = repairLegacyHttpResponseMapping(node);
    if (httpRepaired) {
      nodesChanged = true;
      repairs.push(httpRepaired.repair);
      return httpRepaired.node;
    }
    return node;
  });
  return {
    graph: nodesChanged ? { ...graph, nodes } : graph,
    repairs,
  };
}

function repairLegacyRouterConfig(
  node: WorkflowNode,
): { node: WorkflowNode; repairs: GraphShapeRepair[] } | null {
  const cfg = node.config as Record<string, unknown> & {
    kind?: string;
    branches?: unknown;
  };
  if (cfg.kind !== 'router' || !Array.isArray(cfg.branches) || cfg.branches.length === 0) return null;

  let changed = false;
  const repairs: GraphShapeRepair[] = [];
  const branches = cfg.branches.map((branch, index) => {
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return branch;
    const current = branch as Record<string, unknown>;
    const rawBranchId = typeof current.branchId === 'string' && current.branchId.trim()
      ? current.branchId.trim()
      : typeof current.id === 'string' && current.id.trim()
        ? current.id.trim()
        : `branch-${index + 1}`;
    const rawLabel = typeof current.label === 'string' && current.label.trim()
      ? current.label.trim()
      : rawBranchId;
    const rawCondition = typeof current.condition === 'string' ? current.condition : '';
    const normalizedCondition = normalizeRouterCondition(rawCondition);

    if (current.branchId !== rawBranchId || current.label !== rawLabel || normalizedCondition !== rawCondition) {
      changed = true;
    }
    if (current.branchId !== rawBranchId || current.label !== rawLabel) {
      repairs.push({
        kind: 'router_branch_shape_normalized',
        nodeId: node.id,
        message: `Normalized router branch metadata on '${node.id}' to canonical { branchId, label, condition } entries.`,
      });
    }
    if (normalizedCondition !== rawCondition) {
      repairs.push({
        kind: 'router_condition_normalized',
        nodeId: node.id,
        message: `Normalized router condition syntax on '${node.id}' from template/JS form to the engine-safe condition grammar.`,
      });
    }
    return {
      branchId: rawBranchId,
      label: rawLabel,
      condition: normalizedCondition,
    };
  });

  if (!changed) return null;
  return {
    node: {
      ...node,
      config: {
        ...cfg,
        branches,
      },
    } as WorkflowNode,
    repairs: dedupeRepairs(repairs),
  };
}

function normalizeRouterCondition(condition: string): string {
  const trimmed = condition.trim();
  if (!trimmed) return trimmed;
  return trimmed
    .replace(/!==/g, '!=')
    .replace(/===/g, '==')
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, inner: string) => normalizeConditionReference(inner.trim()));
}

function normalizeConditionReference(reference: string): string {
  if (!reference) return reference;
  if (reference.startsWith('=')) return reference.slice(1).trim();
  if (reference.startsWith('nodes.')) {
    const [, nodeId, ...rest] = reference.split('.');
    if (!nodeId) return reference;
    return ['inputs', `[${JSON.stringify(nodeId)}]`, ...rest.map((segment) => `.${segment}`)].join('');
  }
  if (reference.startsWith('trigger.')) {
    return `trigger.${reference.slice('trigger.'.length)}`;
  }
  if (reference.startsWith('inputs.')) {
    return `inputs.${reference.slice('inputs.'.length)}`;
  }
  return reference;
}

function dedupeRepairs(repairs: GraphShapeRepair[]): GraphShapeRepair[] {
  const seen = new Set<string>();
  return repairs.filter((repair) => {
    const key = `${repair.kind}:${repair.nodeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function repairLegacyStructuredFilter(
  node: WorkflowNode,
): { node: WorkflowNode; repair: GraphShapeRepair } | null {
  const cfg = node.config as Record<string, unknown> & { kind?: string; condition?: unknown };
  if (cfg.kind !== 'filter' || typeof cfg.condition !== 'string') return null;
  if (!looksLikeStructuredFilterExpression(cfg.condition)) return null;
  return {
    node: {
      ...node,
      type: 'transform',
      config: {
        kind: 'transform',
        expression: cfg.condition,
      },
    } as WorkflowNode,
    repair: {
      kind: 'filter_promoted_to_transform',
      nodeId: node.id,
      message: `Promoted filter '${node.id}' to transform because its condition returns structured data rather than a boolean.`,
    },
  };
}

function looksLikeStructuredFilterExpression(condition: string): boolean {
  const trimmed = condition.trim().replace(/;+\s*$/, '');
  return /\(\s*\{[\s\S]*\}\s*\)$/.test(trimmed)
    || /\(\s*\[[\s\S]*\]\s*\)$/.test(trimmed)
    || /return\s+\{[\s\S]*\}\s*;?\s*$/.test(trimmed)
    || /return\s+\[[\s\S]*\]\s*;?\s*$/.test(trimmed);
}

function repairLegacyHttpResponseMapping(
  node: WorkflowNode,
): { node: WorkflowNode; repair: GraphShapeRepair } | null {
  const cfg = node.config as HttpRequestNodeConfig | (Record<string, unknown> & {
    kind?: string;
    responseMapping?: unknown;
  });
  if (cfg.kind !== 'http_request' || !cfg.responseMapping || typeof cfg.responseMapping !== 'object' || Array.isArray(cfg.responseMapping)) {
    return null;
  }
  const mapping = cfg.responseMapping as Record<string, unknown>;
  if (typeof mapping.outputKey === 'string' && mapping.outputKey.trim()) return null;
  const entries = Object.entries(mapping).filter((e): e is [string, string] => typeof e[1] === 'string');
  if (entries.length !== 1) return null;
  const [outputKey, source] = entries[0]!;
  const bodyPath = source.trim() === 'body' ? undefined : source.trim();
  return {
    node: {
      ...node,
      config: {
        ...cfg,
        responseMapping: {
          outputKey,
          ...(bodyPath ? { bodyPath } : {}),
        },
      },
    } as WorkflowNode,
    repair: {
      kind: 'http_response_mapping_normalized',
      nodeId: node.id,
      message: `Normalized legacy http_request response mapping on '${node.id}' to the canonical { outputKey, bodyPath? } shape.`,
    },
  };
}
