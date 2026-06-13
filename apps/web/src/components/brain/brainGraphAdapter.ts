import type {
  BrainEdge,
  BrainEdgeKind,
  BrainGraph,
  BrainGraphLink,
  BrainGraphNode,
  BrainLayer,
  BrainNode,
  BrainNodeType,
} from '@agentis/core';

/**
 * Adapters that convert the backend BrainGraph schema into the visual
 * BrainNode / BrainEdge shape consumed by the canvas renderer.
 *
 * Note: layout is intentionally NOT computed here. The canvas runs a live
 * d3-force simulation (see BrainStage.tsx) — baking a one-off layout would
 * just be wasted work. Each node only gets a cheap deterministic *seed*
 * position so the simulation has a sensible starting point.
 */

export function graphToBrainNodes(graph: BrainGraph): BrainNode[] {
  const total = Math.max(1, graph.nodes.length - 1);
  return graph.nodes.map((node, index) => graphNodeToBrainNode(node, undefined, index, total));
}

export function graphToBrainEdges(graph: BrainGraph): BrainEdge[] {
  return graph.links.map(graphLinkToBrainEdge);
}

export function graphNodeToBrainNode(
  node: BrainGraphNode,
  position?: { x: number; y: number },
  index = 0,
  total = 1,
): BrainNode {
  const type = nodeTypeForAtom(node.atomKind);
  const layer = layerForAtom(node.atomKind);
  const resolvedPosition = position ?? seedPositionFor(node, index, total, layer);
  return {
    id: node.id,
    type,
    layer,
    label: node.label,
    description: node.summary,
    confidence: node.confidence,
    trust: node.trust ?? null,
    freshness: node.isStale ? 'stale' : null,
    status: node.isDisputed ? 'warning' : node.isStale ? 'warning' : 'ok',
    weight: weightFor(node),
    x: resolvedPosition.x,
    y: resolvedPosition.y,
    metadata: {
      ...node.metadata,
      atomId: node.atomId,
      atomKind: node.atomKind,
      adapterType: node.adapterType ?? null,
      agentId: node.agentId ?? null,
      scopeId: node.scopeId ?? null,
      runId: node.runId ?? null,
      reinforceCount: node.reinforceCount,
      isDisputed: node.isDisputed ?? false,
      workspaceGlobal: !node.scopeId,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    },
  };
}

export function graphLinkToBrainEdge(link: BrainGraphLink): BrainEdge {
  return {
    id: link.id,
    source: link.source,
    target: link.target,
    kind: relationToEdgeKind(link.relation),
    weight: Math.max(0.15, Math.min(1, link.confidence)),
    label: link.relation.replace(/_/g, ' '),
  };
}

function nodeTypeForAtom(atomKind: BrainGraphNode['atomKind']): BrainNodeType {
  switch (atomKind) {
    case 'core': return 'core';
    case 'kb_chunk':
    case 'knowledge_chunk': return 'knowledge_cluster';
    case 'episode': return 'memory_episode';
    case 'memory':
    case 'pattern': return 'memory_pattern';
    case 'warning': return 'warning';
    case 'gap': return 'gap';
    // Organizational overlay (Workspace Brain / CORA engine).
    case 'cora_source': return 'dataset';
    case 'cora_entity': return 'artifact';
    case 'cora_claim': return 'decision';
  }
}

function layerForAtom(atomKind: BrainGraphNode['atomKind']): BrainLayer {
  switch (atomKind) {
    case 'core': return 'core';
    case 'kb_chunk':
    case 'knowledge_chunk': return 'knowledge';
    case 'episode':
    case 'memory':
    case 'pattern': return 'memory';
    case 'warning':
    case 'gap': return 'judgment';
    // Sources + entities sit with knowledge; claims are judged truth.
    case 'cora_source':
    case 'cora_entity': return 'knowledge';
    case 'cora_claim': return 'judgment';
  }
}

function relationToEdgeKind(relation: BrainGraphLink['relation']): BrainEdgeKind {
  switch (relation) {
    case 'supports': return 'supports';
    case 'contradicts': return 'contradicts';
    case 'refines': return 'refines';
    case 'derived_from': return 'derived_from';
    case 'co_observed': return 'co_observed';
  }
}

function weightFor(node: BrainGraphNode): number {
  if (node.atomKind === 'core') return 1;
  const reinforcement = Math.min(0.35, Math.log1p(node.reinforceCount) / 8);
  return Math.max(0.32, Math.min(0.95, node.confidence * 0.65 + reinforcement));
}

function seedPositionFor(node: BrainGraphNode, index: number, total: number, layer: BrainLayer): { x: number; y: number } {
  if (node.atomKind === 'core') return { x: 0, y: 0 };
  const radius = layer === 'knowledge' ? 190 : layer === 'memory' ? 300 : 400;
  const adapterOffset = adapterPhase(node.adapterType ?? node.atomKind);
  const theta = adapterOffset + index * 2.399963229728653 + (1 / total) * Math.PI;
  const jitter = hashUnit(node.id) * 72 - 36;
  const linkGravity = Math.min(40, Math.log1p(node.reinforceCount) * 10);
  const r = Math.max(130, radius + jitter - linkGravity);
  return { x: Math.cos(theta) * r, y: Math.sin(theta) * r };
}

function adapterPhase(key: string): number {
  const value = hashUnit(key);
  return -Math.PI / 2 + value * Math.PI * 0.9;
}

function hashUnit(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}
