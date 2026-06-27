/**
 * Brain UX types — the high-level intelligence surface contract.
 *
 * The Brain is a *composed* surface. The backend assembles a single
 * BrainResponse from many sources (knowledge, memory, evaluators, baselines,
 * dataset jobs); the frontend never reaches into the lower-level stores
 * directly to assemble it.
 *
 * Visual model = four strata:
 *   - core      → workspace identity + health
 *   - knowledge → seeds, datasets, indexed clusters
 *   - memory    → promoted episodes + patterns
 *   - judgment  → evaluators + baselines
 *
 * Three view modes:
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
  | 'gap'
  | 'scope_owner';

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
  | 'measures'
  | 'owned_by';

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
  scope: 'scoped' | 'workspace';
  workspace?: {
    id: string;
    packageCount: number;
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

export type KnowledgeLinkRelation = 'supports' | 'contradicts' | 'refines' | 'derived_from' | 'co_observed' | 'owned_by';

/** Which kind of scope owns a scoped atom (for Workspace Brain provenance). */
export type BrainScopeKind = 'app' | 'agent' | 'workflow';

export type BrainGraphScope = 'workspace' | 'scoped';

export interface BrainGraphNode {
  id: string;
  atomId: string;
  /** `grounding_*` kinds are the Workspace Brain's organizational overlay (sources, entities, claims). */
  atomKind: KnowledgeAtomKind | 'core' | 'warning' | 'gap' | 'grounding_source' | 'grounding_entity' | 'grounding_claim' | 'scope_owner';
  label: string;
  summary?: string;
  /** Provenance for a scoped atom: which App/Agent/Workflow owns it + its name. */
  scopeKind?: BrainScopeKind | null;
  scopeLabel?: string | null;
  confidence: number;
  trust?: number | null;
  reinforceCount: number;
  agentId?: string | null;
  adapterType?: string | null;
  scopeId?: string | null;
  runId?: string | null;
  isDisputed?: boolean;
  isStale?: boolean;
  status?: 'active' | 'stale' | 'archived' | string | null;
  managed?: boolean | null;
  pinnedAt?: string | null;
  lastAccessedAt?: string | null;
  disputeReason?: string | null;
  disputeResolvedAt?: string | null;
  disputeSnoozedUntil?: string | null;
  contextCondition?: string | null;
  compressedFrom?: string[] | null;
  compressionTier?: number | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface BrainGraphLink {
  id: string;
  source: string;
  target: string;
  sourceAtomId: string;
  sourceKind: KnowledgeAtomKind | 'grounding_source' | 'grounding_entity' | 'grounding_claim' | 'scope_owner';
  targetAtomId: string;
  targetKind: KnowledgeAtomKind | 'grounding_source' | 'grounding_entity' | 'grounding_claim' | 'scope_owner';
  relation: KnowledgeLinkRelation;
  confidence: number;
  reinforceCount: number;
  agentId?: string | null;
  adapterType?: string | null;
  scopeId?: string | null;
  runId?: string | null;
  contextSplit?: boolean;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrainGraph {
  nodes: BrainGraphNode[];
  links: BrainGraphLink[];
  meta: {
    workspaceId: string;
    scope: BrainGraphScope;
    scopeId?: string | null;
    atomCount: number;
    linkCount: number;
    lastActivityAt: string | null;
    adapterTypes: string[];
  };
}

export interface BrainGraphEventPayload {
  workspaceId: string;
  scopeId?: string | null;
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
