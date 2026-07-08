import type { WorkflowGraph, WorkflowNode, WorkflowPhase } from './types/workflow.js';

export const WORKFLOW_PHASE_COLORS = [
  '#2563eb',
  '#0891b2',
  '#059669',
  '#ca8a04',
  '#dc6b3f',
  '#db2777',
] as const;

export interface PhaseLane {
  id: string;
  name: string;
  nodeIds: string[];
  x: number;
  width: number;
  y: number;
  height: number;
}

export interface PhaseLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  lanes: PhaseLane[];
}

export interface PhaseLayoutOptions {
  originX?: number;
  originY?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  nodeGapX?: number;
  nodeGapY?: number;
  laneGap?: number;
  lanePaddingX?: number;
  lanePaddingTop?: number;
  lanePaddingBottom?: number;
}

/**
 * Suggest a compact ordered phase model without mutating the graph.
 * Nodes are topologically ordered, then split into balanced contiguous groups.
 * This keeps dependencies readable and avoids pretending arbitrary node kinds
 * imply stronger product semantics than the graph actually declares.
 */
export function suggestWorkflowPhases(graph: Pick<WorkflowGraph, 'nodes' | 'edges'>): WorkflowPhase[] {
  if (graph.nodes.length < 4) return [];
  const ordered = topologicalNodes(graph.nodes, graph.edges);
  const desiredCount = Math.min(7, Math.max(2, Math.ceil(ordered.length / 3)));
  const groups = balancedGroups(ordered, desiredCount);

  return groups.map((nodes, index) => {
    const purpose = describePhase(nodes, index, groups.length);
    return {
      id: uniquePhaseId(purpose.name, index),
      name: purpose.name,
      description: purpose.description,
      color: WORKFLOW_PHASE_COLORS[index % WORKFLOW_PHASE_COLORS.length]!,
      nodeIds: nodes.map((node) => node.id),
    };
  });
}

/**
 * Lay out ordered phases as LEFT-TO-RIGHT lanes (phase 1, then phase 2 to its
 * right, …) — the natural reading direction of a workflow and the shape of the
 * reference builder. Within a lane, dependencies determine local columns and
 * siblings stack vertically. Cards are compact with generous gutters so the
 * orthogonal edges have room to route cleanly between them.
 */
export function computePhaseAwareLayout(
  graph: Pick<WorkflowGraph, 'nodes' | 'edges' | 'phases'>,
  options: PhaseLayoutOptions = {},
): PhaseLayoutResult {
  const nodeWidth = options.nodeWidth ?? 220;
  const nodeHeight = options.nodeHeight ?? 54;
  const nodeGapX = options.nodeGapX ?? 72;
  const nodeGapY = options.nodeGapY ?? 56;
  const laneGap = options.laneGap ?? 56;
  const lanePaddingX = options.lanePaddingX ?? 32;
  const lanePaddingTop = options.lanePaddingTop ?? 56;
  const lanePaddingBottom = options.lanePaddingBottom ?? 28;
  const originX = options.originX ?? 0;
  const originY = options.originY ?? 0;

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const assigned = new Set<string>();
  const groups = (graph.phases ?? []).map((phase) => {
    const ids = phase.nodeIds.filter((id) => nodeIds.has(id) && !assigned.has(id));
    ids.forEach((id) => assigned.add(id));
    return { id: phase.id, name: phase.name, nodeIds: ids };
  }).filter((group) => group.nodeIds.length > 0);
  const unassigned = graph.nodes.filter((node) => !assigned.has(node.id)).map((node) => node.id);
  if (unassigned.length > 0) groups.push({ id: '__unassigned__', name: 'Unassigned', nodeIds: unassigned });
  if (groups.length === 0 && graph.nodes.length > 0) {
    groups.push({ id: '__unassigned__', name: 'Unassigned', nodeIds: graph.nodes.map((node) => node.id) });
  }

  const positions = new Map<string, { x: number; y: number }>();
  const lanes: PhaseLane[] = [];
  let laneX = originX;

  for (const group of groups) {
    const localNodes = graph.nodes.filter((node) => group.nodeIds.includes(node.id));
    const localIds = new Set(group.nodeIds);
    const localEdges = graph.edges.filter((edge) => localIds.has(edge.source) && localIds.has(edge.target));
    const columns = localLayers(localNodes, localEdges);
    const maxRows = Math.max(1, ...columns.map((column) => column.length));
    const laneWidth = lanePaddingX * 2
      + columns.length * nodeWidth
      + Math.max(0, columns.length - 1) * nodeGapX;
    const laneHeight = lanePaddingTop + maxRows * nodeHeight + Math.max(0, maxRows - 1) * nodeGapY + lanePaddingBottom;
    const innerHeight = laneHeight - lanePaddingTop - lanePaddingBottom;

    columns.forEach((column, columnIndex) => {
      const contentHeight = column.length * nodeHeight + Math.max(0, column.length - 1) * nodeGapY;
      const startY = originY + lanePaddingTop + Math.max(0, (innerHeight - contentHeight) / 2);
      column.forEach((node, rowIndex) => {
        positions.set(node.id, {
          x: laneX + lanePaddingX + columnIndex * (nodeWidth + nodeGapX),
          y: startY + rowIndex * (nodeHeight + nodeGapY),
        });
      });
    });
    lanes.push({ id: group.id, name: group.name, nodeIds: group.nodeIds, x: laneX, width: laneWidth, y: originY, height: laneHeight });
    laneX += laneWidth + laneGap;
  }

  return { positions, lanes };
}

export function layoutWorkflowGraphByPhases<G extends WorkflowGraph>(
  graph: G,
  options?: PhaseLayoutOptions,
): G {
  const { positions } = computePhaseAwareLayout(graph, options);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    })),
  };
}

function topologicalNodes(
  nodes: readonly WorkflowNode[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): WorkflowNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target) || edge.source === edge.target) continue;
    outgoing.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = nodes.filter((node) => indegree.get(node.id) === 0);
  const out: WorkflowNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    out.push(node);
    for (const target of outgoing.get(node.id) ?? []) {
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
      if (indegree.get(target) === 0) queue.push(byId.get(target)!);
    }
  }
  for (const node of nodes) if (!out.some((item) => item.id === node.id)) out.push(node);
  return out;
}

function balancedGroups<T>(items: readonly T[], count: number): T[][] {
  const groups: T[][] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const remainingItems = items.length - cursor;
    const remainingGroups = count - index;
    const size = Math.ceil(remainingItems / remainingGroups);
    groups.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups.filter((group) => group.length > 0);
}

function localLayers(
  nodes: readonly WorkflowNode[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): WorkflowNode[][] {
  const ordered = topologicalNodes(nodes, edges);
  const parents = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) parents.get(edge.target)?.push(edge.source);
  const layer = new Map<string, number>();
  for (const node of ordered) {
    const parentLayers = (parents.get(node.id) ?? []).map((id) => layer.get(id) ?? 0);
    layer.set(node.id, parentLayers.length ? Math.max(...parentLayers) + 1 : 0);
  }
  const result: WorkflowNode[][] = [];
  for (const node of ordered) {
    const index = layer.get(node.id) ?? 0;
    (result[index] ??= []).push(node);
  }
  return result.filter(Boolean);
}

function describePhase(nodes: readonly WorkflowNode[], index: number, total: number) {
  const kinds = new Set(nodes.map((node) => node.config.kind));
  const titles = nodes.map((node) => node.title?.toLowerCase() ?? '');
  const hasTitle = (pattern: RegExp) => titles.some((title) => pattern.test(title));

  if (index === 0 && kinds.has('trigger')) {
    return { name: 'Intake', description: 'Receive the trigger and prepare the workflow inputs.' };
  }
  if (index === total - 1 && (
    kinds.has('return_output')
    || kinds.has('artifact_save')
    || kinds.has('artifact_collect')
    || titles.some((title) => /send|deliver|publish|notify|return|save/.test(title))
  )) {
    return { name: 'Final Output', description: 'Package and deliver the workflow outcome.' };
  }
  if (hasTitle(/persist|progress|memory|workflow store|workspace store/)) {
    return { name: 'Persist Progress', description: 'Save intermediate state so the workflow can resume or report progress.' };
  }
  if (hasTitle(/deploy|deployment|production|live/)) {
    return { name: 'Deployment', description: 'Release the finished work and validate the live result.' };
  }
  if (hasTitle(/qualif|candidate|reject/)) {
    return { name: 'Qualification', description: 'Assess whether the workflow should continue and route early exits.' };
  }
  if (hasTitle(/curat|brand|asset|config/)) {
    return { name: 'Curation', description: 'Gather and shape the assets or configuration needed for production work.' };
  }
  if (hasTitle(/seed|validate|build|local|test/)) {
    return { name: 'Seed & Validate', description: 'Create the working state and verify it before release.' };
  }
  if ([...kinds].some((kind) => ['knowledge', 'http_request', 'browser', 'integration'].includes(kind))) {
    return { name: 'Gather Context', description: 'Collect the information required by downstream work.' };
  }
  if ([...kinds].some((kind) => ['agent_task', 'agent_session', 'agent_swarm', 'dynamic_swarm', 'planner'].includes(kind))) {
    return { name: 'Analyze & Create', description: 'Use agents to reason over the available context and produce the result.' };
  }
  if ([...kinds].some((kind) => ['evaluator', 'guardrails', 'checkpoint'].includes(kind))) {
    return { name: 'Review & Approve', description: 'Validate the result and enforce required review gates.' };
  }
  return {
    name: index === total - 1 ? 'Finalize' : `Process ${index + 1}`,
    description: 'Transform and route data through this part of the workflow.',
  };
}

function uniquePhaseId(name: string, index: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `phase-${index + 1}-${slug || 'workflow'}`;
}



