/**
 * Brain — the workspace intelligence surface contract.
 *
 * The Brain is the layer that lets agents compound what they know over time. It
 * has three strata, all workspace-scoped:
 *
 *   1. Workspace context — WORKSPACE.md / WORKFLOW.md / DECISIONS.md (durable
 *      facts + conventions) and the MEMORY.md learning log.
 *   2. Knowledge bases   — documents chunked + indexed for retrieval.
 *   3. Workflow memory   — per-workflow key/value state that survives across runs.
 *
 * `BrainOverview` is a *composed* read model: the backend assembles it from the
 * underlying stores so the frontend renders one honest picture (including gaps,
 * so absence is visible rather than faked).
 */

export type BrainContextFileName = 'WORKSPACE.md' | 'WORKFLOW.md' | 'DECISIONS.md';

export interface BrainContextFileStatus {
  name: BrainContextFileName;
  /** True when the file holds real content beyond the seeded placeholders. */
  filled: boolean;
  /** Byte length of the non-placeholder content. */
  bytes: number;
}

export interface BrainMemoryEntryView {
  section: string;
  text: string;
  confidence: 'low' | 'medium' | 'high';
  /** ms epoch, or null when the entry is undated. */
  timestamp: number | null;
  uses: number;
}

export interface BrainMemoryStat {
  totalEntries: number;
  bySection: Array<{ section: string; count: number }>;
  /** A few most-recent entries for the surface; not the whole log. */
  recent: BrainMemoryEntryView[];
}

export interface BrainKnowledgeBaseStat {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  chunkCount: number;
  /** ISO timestamp of the most recently indexed chunk, or null when empty. */
  lastIndexedAt: string | null;
}

export interface BrainWorkflowMemoryStat {
  workflowId: string;
  workflowTitle: string | null;
  keyCount: number;
  /** ISO timestamp of the most recently updated entry, or null. */
  updatedAt: string | null;
}

export interface BrainGap {
  code:
    | 'no_knowledge_bases'
    | 'empty_knowledge_base'
    | 'blank_workspace_context'
    | 'no_memory';
  message: string;
  /** Optional id of the entity the gap concerns (e.g. an empty KB). */
  refId?: string;
}

export interface BrainStats {
  knowledgeBases: number;
  documents: number;
  chunks: number;
  memoryEntries: number;
  workflowMemoryKeys: number;
  /** How many of the three context files hold real content (0–3). */
  contextFilesFilled: number;
}

/** The full workspace Brain read model returned by `GET /v1/brain`. */
export interface BrainOverview {
  workspaceId: string;
  stats: BrainStats;
  context: {
    files: BrainContextFileStatus[];
    memory: BrainMemoryStat;
  };
  knowledge: {
    bases: BrainKnowledgeBaseStat[];
  };
  workflowMemory: {
    workflows: BrainWorkflowMemoryStat[];
  };
  /** Honest nudges surfaced when the Brain is under-filled. */
  gaps: BrainGap[];
}
