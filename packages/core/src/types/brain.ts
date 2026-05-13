/**
 * Brain UX types — the high-level intelligence surface contract.
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §16.
 *
 * The Brain is a *composed* product surface. The backend assembles a single
 * BrainResponse from many sources (knowledge, memory, evaluators, baselines,
 * dataset jobs); the frontend never reaches into the lower-level stores
 * directly to assemble it (§16.3).
 *
 * Visual model = four strata (§7.2):
 *   - core      → app identity + health
 *   - knowledge → seeds, datasets, indexed clusters
 *   - memory    → promoted episodes + patterns
 *   - judgment  → evaluators + baselines
 *
 * Three view modes (§8):
 *   - Map     → spatial knowledge map
 *   - Flow    → directional intelligence-flow graph
 *   - Ledger  → temporal table of memories / evaluators / baselines
 */

export type BrainNodeType =
  | 'core'
  | 'dataset'
  | 'knowledge_cluster'
  | 'memory_episode'
  | 'memory_pattern'
  | 'evaluator'
  | 'baseline'
  | 'artifact'
  | 'decision'
  | 'warning'
  | 'gap';

export type BrainLayer = 'core' | 'knowledge' | 'memory' | 'judgment';

export type BrainFreshness = 'fresh' | 'aging' | 'stale';

export type BrainStatus = 'ok' | 'warning' | 'error' | 'inactive';

export interface BrainNode {
  id: string;
  type: BrainNodeType;
  label: string;
  description?: string;
  layer: BrainLayer;
  /** Suggested layout positions (server-side hint, optional). */
  x?: number;
  y?: number;
  /** Visual emphasis weight 0..1 — drives node size + glow. */
  weight?: number;
  /** 0..1 evaluator/baseline confidence; null when unknown. */
  confidence?: number | null;
  /** 0..1 trust score for memory items; null when not applicable. */
  trust?: number | null;
  /** Freshness bucket for datasets / sources. */
  freshness?: BrainFreshness | null;
  /** Lightweight health bucket. */
  status?: BrainStatus | null;
  /**
   * Free-form metadata used by the inspector (sample counts, last-used,
   * provenance, sparkline points, etc). The shape is intentionally open —
   * the rail component switches on `type` to render it.
   */
  metadata: Record<string, unknown>;
}

export type BrainEdgeKind =
  | 'feeds'
  | 'evaluates'
  | 'derived_from'
  | 'used_in'
  | 'supersedes'
  | 'supports'
  | 'contradicts'
  | 'refines'
  | 'co_observed'
  | 'measures';

export interface BrainEdge {
  id: string;
  source: string;
  target: string;
  kind: BrainEdgeKind;
  /** Edge strength 0..1 — used for line opacity and selection priority. */
  weight?: number;
  label?: string;
}

export interface BrainWarning {
  code: string;
  message: string;
  nodeId?: string;
  severity: 'info' | 'warning' | 'error';
}

export interface BrainGap {
  id: string;
  label: string;
  reason: string;
  /** Suggested action key (e.g. dataset key to ingest). */
  fillSuggestion?: string;
}

export interface BrainStats {
  knowledgeNodes: number;
  memoryNodes: number;
  evaluatorNodes: number;
  baselineConfidence: number | null;
  staleSources: number;
}

export interface BrainResponse {
  scope: 'app' | 'workspace';
  app?: {
    id: string;
    slug: string;
    name: string;
    status: string;
  };
  workspace?: {
    id: string;
    appCount: number;
  };
  stats: BrainStats;
  layers: {
    core: BrainNode[];
    knowledge: BrainNode[];
    memory: BrainNode[];
    judgment: BrainNode[];
  };
  edges: BrainEdge[];
  warnings: BrainWarning[];
  gaps: BrainGap[];
}

export type KnowledgeAtomKind = 'kb_chunk' | 'knowledge_chunk' | 'episode' | 'memory' | 'pattern';

export type KnowledgeLinkRelation = 'supports' | 'contradicts' | 'refines' | 'derived_from' | 'co_observed';

export type BrainGraphScope = 'workspace' | 'app';

export interface BrainGraphNode {
  id: string;
  atomId: string;
  atomKind: KnowledgeAtomKind | 'core' | 'warning' | 'gap';
  label: string;
  summary?: string;
  confidence: number;
  trust?: number | null;
  reinforceCount: number;
  agentId?: string | null;
  adapterType?: string | null;
  appId?: string | null;
  runId?: string | null;
  isDisputed?: boolean;
  isStale?: boolean;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface BrainGraphLink {
  id: string;
  source: string;
  target: string;
  sourceAtomId: string;
  sourceKind: KnowledgeAtomKind;
  targetAtomId: string;
  targetKind: KnowledgeAtomKind;
  relation: KnowledgeLinkRelation;
  confidence: number;
  reinforceCount: number;
  agentId?: string | null;
  adapterType?: string | null;
  appId?: string | null;
  runId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrainGraph {
  nodes: BrainGraphNode[];
  links: BrainGraphLink[];
  meta: {
    workspaceId: string;
    scope: BrainGraphScope;
    appId?: string | null;
    atomCount: number;
    linkCount: number;
    lastActivityAt: string | null;
    adapterTypes: string[];
  };
}

export interface BrainGraphEventPayload {
  workspaceId: string;
  appId?: string | null;
  node?: BrainGraphNode;
  link?: BrainGraphLink;
  graph?: Pick<BrainGraph['meta'], 'atomCount' | 'linkCount' | 'lastActivityAt'>;
}

/**
 * Default polar layout — `core` at center, three concentric rings for each
 * remaining stratum. Used by both server hints and the client fallback when
 * a node has no explicit (x, y).
 */
export const BRAIN_RING_RADIUS: Record<BrainLayer, number> = {
  core: 0,
  knowledge: 220,
  memory: 360,
  judgment: 480,
};

export const BRAIN_NODE_TYPES: ReadonlyArray<BrainNodeType> = [
  'core',
  'dataset',
  'knowledge_cluster',
  'memory_episode',
  'memory_pattern',
  'evaluator',
  'baseline',
  'artifact',
  'decision',
  'warning',
  'gap',
];
