import type { WorkflowGraph } from '@agentis/core';

export type WorkflowGraphMutationOperation =
  | { op: 'add_node'; node: WorkflowGraph['nodes'][number] }
  | { op: 'patch_node'; nodeId: string; patch: Record<string, unknown> }
  | { op: 'remove_node'; nodeId: string }
  | { op: 'add_edge'; edge: WorkflowGraph['edges'][number] }
  | { op: 'patch_edge'; edgeId: string; patch: Record<string, unknown> }
  | { op: 'remove_edge'; edgeId: string }
  | { op: 'patch_viewport'; patch: Record<string, unknown> };

export interface WorkflowGraphMutationDiff {
  nodes: { added: string[]; removed: string[]; updated: Array<{ id: string; paths: string[] }> };
  edges: { added: string[]; removed: string[]; updated: Array<{ id: string; paths: string[] }> };
  graphPaths: string[];
}

export class WorkflowGraphMutationError extends Error {
  constructor(message: string, readonly operationIndex?: number) {
    super(operationIndex === undefined ? message : `operation ${operationIndex}: ${message}`);
    this.name = 'WorkflowGraphMutationError';
  }
}

/**
 * Apply explicit, field-level operations to a stored graph. Patches are recursive
 * object merges: omitted fields survive, arrays replace, and identity fields may
 * not be changed. The input graph is never mutated.
 */
export function applyWorkflowGraphOperations(
  base: WorkflowGraph,
  value: unknown,
): { graph: WorkflowGraph; diff: WorkflowGraphMutationDiff } {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkflowGraphMutationError('operations must be a non-empty array');
  }

  let graph = cloneJson(base);
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isRecord(raw) || typeof raw.op !== 'string') {
      throw new WorkflowGraphMutationError('must be an object with an op', index);
    }
    try {
      graph = applyOne(graph, raw as Record<string, unknown> & { op: string });
    } catch (error) {
      if (error instanceof WorkflowGraphMutationError && error.operationIndex !== undefined) throw error;
      throw new WorkflowGraphMutationError((error as Error).message, index);
    }
  }
  return { graph, diff: diffWorkflowGraphs(base, graph) };
}

/** Back-compatible patchDraft application with safe partial update semantics. */
export function applyLegacyWorkflowPatchDraft(base: WorkflowGraph, value: unknown): WorkflowGraph {
  if (!isRecord(value)) throw new WorkflowGraphMutationError('patchDraft must be an object');
  const addNodes = objectArray(value.addNodes, 'addNodes');
  const updateNodes = objectArray(value.updateNodes, 'updateNodes');
  const removeNodeIds = stringArray(value.removeNodeIds, 'removeNodeIds');
  const addEdges = objectArray(value.addEdges, 'addEdges');
  const removeEdgeIds = stringArray(value.removeEdgeIds, 'removeEdgeIds');
  const operations: WorkflowGraphMutationOperation[] = [];

  for (const node of addNodes) operations.push({ op: 'add_node', node: node as unknown as WorkflowGraph['nodes'][number] });
  for (const node of updateNodes) {
    if (typeof node.id !== 'string' || !node.id) throw new WorkflowGraphMutationError('updateNodes entries require id');
    const { id, ...patch } = node;
    operations.push({ op: 'patch_node', nodeId: id, patch });
  }
  for (const nodeId of removeNodeIds) operations.push({ op: 'remove_node', nodeId });
  for (const edge of addEdges) operations.push({ op: 'add_edge', edge: edge as unknown as WorkflowGraph['edges'][number] });
  for (const edgeId of removeEdgeIds) operations.push({ op: 'remove_edge', edgeId });
  if (operations.length === 0) return cloneJson(base);
  return applyWorkflowGraphOperations(base, operations).graph;
}

export function diffWorkflowGraphs(before: WorkflowGraph, after: WorkflowGraph): WorkflowGraphMutationDiff {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  return {
    nodes: diffEntities(beforeNodes, afterNodes),
    edges: diffEntities(beforeEdges, afterEdges),
    graphPaths: changedPaths(
      omitKeys(before as unknown as Record<string, unknown>, ['nodes', 'edges']),
      omitKeys(after as unknown as Record<string, unknown>, ['nodes', 'edges']),
    ),
  };
}

function applyOne(graph: WorkflowGraph, operation: Record<string, unknown> & { op: string }): WorkflowGraph {
  switch (operation.op) {
    case 'add_node': {
      if (!isRecord(operation.node) || typeof operation.node.id !== 'string' || !operation.node.id) {
        throw new WorkflowGraphMutationError('add_node requires node with id');
      }
      const nodeRecord = operation.node;
      if (graph.nodes.some((node) => node.id === nodeRecord.id)) {
        throw new WorkflowGraphMutationError(`node "${nodeRecord.id}" already exists`);
      }
      return { ...graph, nodes: [...graph.nodes, cloneJson(nodeRecord) as unknown as WorkflowGraph['nodes'][number]] };
    }
    case 'patch_node': {
      const nodeId = requiredString(operation.nodeId, 'patch_node.nodeId');
      if (!isRecord(operation.patch)) throw new WorkflowGraphMutationError('patch_node.patch must be an object');
      if ('id' in operation.patch && operation.patch.id !== nodeId) {
        throw new WorkflowGraphMutationError('patch_node cannot change node identity');
      }
      let found = false;
      const nodes = graph.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        found = true;
        return deepMerge(node as unknown as Record<string, unknown>, operation.patch as Record<string, unknown>) as unknown as WorkflowGraph['nodes'][number];
      });
      if (!found) throw new WorkflowGraphMutationError(`node "${nodeId}" not found`);
      return { ...graph, nodes };
    }
    case 'remove_node': {
      const nodeId = requiredString(operation.nodeId, 'remove_node.nodeId');
      if (!graph.nodes.some((node) => node.id === nodeId)) throw new WorkflowGraphMutationError(`node "${nodeId}" not found`);
      return {
        ...graph,
        nodes: graph.nodes.filter((node) => node.id !== nodeId),
        edges: graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
        ...(graph.phases ? { phases: graph.phases.map((phase) => ({ ...phase, nodeIds: phase.nodeIds.filter((id) => id !== nodeId) })) } : {}),
      };
    }
    case 'add_edge': {
      if (!isRecord(operation.edge) || typeof operation.edge.id !== 'string' || !operation.edge.id) {
        throw new WorkflowGraphMutationError('add_edge requires edge with id');
      }
      const edge = operation.edge as unknown as WorkflowGraph['edges'][number];
      if (graph.edges.some((current) => current.id === edge.id)) throw new WorkflowGraphMutationError(`edge "${edge.id}" already exists`);
      const nodeIds = new Set(graph.nodes.map((node) => node.id));
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new WorkflowGraphMutationError('add_edge source and target must reference existing nodes');
      return { ...graph, edges: [...graph.edges, cloneJson(edge)] };
    }
    case 'patch_edge': {
      const edgeId = requiredString(operation.edgeId, 'patch_edge.edgeId');
      if (!isRecord(operation.patch)) throw new WorkflowGraphMutationError('patch_edge.patch must be an object');
      if ('id' in operation.patch && operation.patch.id !== edgeId) throw new WorkflowGraphMutationError('patch_edge cannot change edge identity');
      let found = false;
      const edges = graph.edges.map((edge) => {
        if (edge.id !== edgeId) return edge;
        found = true;
        return deepMerge(edge as unknown as Record<string, unknown>, operation.patch as Record<string, unknown>) as unknown as WorkflowGraph['edges'][number];
      });
      if (!found) throw new WorkflowGraphMutationError(`edge "${edgeId}" not found`);
      const nodeIds = new Set(graph.nodes.map((node) => node.id));
      const revised = edges.find((edge) => edge.id === edgeId)!;
      if (!nodeIds.has(revised.source) || !nodeIds.has(revised.target)) throw new WorkflowGraphMutationError('patch_edge source and target must reference existing nodes');
      return { ...graph, edges };
    }
    case 'remove_edge': {
      const edgeId = requiredString(operation.edgeId, 'remove_edge.edgeId');
      if (!graph.edges.some((edge) => edge.id === edgeId)) throw new WorkflowGraphMutationError(`edge "${edgeId}" not found`);
      return { ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) };
    }
    case 'patch_viewport': {
      if (!isRecord(operation.patch)) throw new WorkflowGraphMutationError('patch_viewport.patch must be an object');
      return { ...graph, viewport: deepMerge(graph.viewport as unknown as Record<string, unknown>, operation.patch) as WorkflowGraph['viewport'] };
    }
    default:
      throw new WorkflowGraphMutationError(`unsupported op "${operation.op}"`);
  }
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = cloneJson(base);
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : cloneJson(value);
  }
  return result;
}

function diffEntities<T extends object>(
  before: Map<string, T>,
  after: Map<string, T>,
): { added: string[]; removed: string[]; updated: Array<{ id: string; paths: string[] }> } {
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const updated = [...after.keys()].filter((id) => before.has(id)).sort().flatMap((id) => {
    const paths = changedPaths(before.get(id), after.get(id));
    return paths.length > 0 ? [{ id, paths }] : [];
  });
  return { added, removed, updated };
}

function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (Object.is(before, after)) return [];
  if (!isRecord(before) || !isRecord(after)) {
    if (Array.isArray(before) && Array.isArray(after) && JSON.stringify(before) === JSON.stringify(after)) return [];
    return [prefix || '$'];
  }
  const paths: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    paths.push(...changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  return paths.sort();
}

function omitKeys(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new WorkflowGraphMutationError(`${name} is required`);
  return value;
}

function objectArray(value: unknown, name: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) throw new WorkflowGraphMutationError(`${name} must be an array of objects`);
  return value as Record<string, unknown>[];
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new WorkflowGraphMutationError(`${name} must be an array of strings`);
  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
