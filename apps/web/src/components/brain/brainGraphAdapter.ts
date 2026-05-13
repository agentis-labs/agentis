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

export function graphToBrainNodes(graph: BrainGraph): BrainNode[] {
  const nonCore = graph.nodes.filter((node) => node.id !== 'core');
  const total = Math.max(1, nonCore.length);
  return graph.nodes.map((node, index) => graphNodeToBrainNode(node, index, total));
}

export function graphToBrainEdges(graph: BrainGraph): BrainEdge[] {
  return graph.links.map(graphLinkToBrainEdge);
}

export function graphNodeToBrainNode(node: BrainGraphNode, index = 0, total = 1): BrainNode {
  const type = nodeTypeForAtom(node.atomKind);
  const layer = layerForAtom(node.atomKind);
  const position = positionFor(node, index, total, layer);
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
    x: position.x,
    y: position.y,
    metadata: {
      ...node.metadata,
      atomId: node.atomId,
      atomKind: node.atomKind,
      adapterType: node.adapterType ?? null,
      agentId: node.agentId ?? null,
      appId: node.appId ?? null,
      runId: node.runId ?? null,
      reinforceCount: node.reinforceCount,
      isDisputed: node.isDisputed ?? false,
      workspaceGlobal: !node.appId,
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

function positionFor(node: BrainGraphNode, index: number, total: number, layer: BrainLayer): { x: number; y: number } {
  if (node.atomKind === 'core') return { x: 0, y: 0 };
  const radius = layer === 'knowledge' ? 230 : layer === 'memory' ? 380 : 500;
  const adapterOffset = adapterPhase(node.adapterType ?? node.atomKind);
  const theta = adapterOffset + ((index + 0.5) / total) * Math.PI * 2;
  const jitter = hashUnit(node.id) * 36 - 18;
  const linkGravity = Math.min(40, Math.log1p(node.reinforceCount) * 10);
  const r = Math.max(160, radius + jitter - linkGravity);
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
