/**
 * Memory Architecture types â€” Agentis Memory OS.
 *
 *
 * The Memory Architecture defines five layers:
 *
 *   1. Run Working Memory     â€” scratchpad + compact turn state for active runs
 *   2. Workspace Knowledge          â€” seeds + imported datasets (Workspace Knowledge)
 *   3. Episodic Memory        â€” durable lessons distilled from execution
 *   4. Evaluator + Baselines  â€” what "good" looks like
 *   5. Retrieval Memory       â€” semantic + lexical selection across the layers
 *
 * This file defines:
 *   - Layer 1 working-memory entry types (typed scratchpad shapes)
 *   - Layer 3 episodic memory (richer than the wedge's `MemoryEpisode`)
 *   - Promotion pipeline events (audit trail for how memory was created)
 *
 * Layer 2 types live in `appIntelligence.ts` (KnowledgeChunk, KnowledgeHit).
 * Layer 4 types live in `appIntelligence.ts` (EvaluatorExample) +
 * `baseline.ts` (rolling baseline windows).
 * Layer 5 types live in `retrieval.ts` (InjectedMemoryContext, budget classes).
 *
 * Naming distinction with the Workspace Knowledge:
 *   - Wedge `MemoryEpisode`  â€” typed knowledge (fact|preference|pattern|rule|lesson)
 *   - Memory `RuntimeEpisode` â€” durable execution lesson (decision|failure|recovery|...)
 *
 * These coexist because they answer different questions:
 *   - "What does the workspace know?"           â†’ wedge MemoryEpisode (`workspace_memory`)
 *   - "What happened during execution?"    â†’ RuntimeEpisode (`memory_episodes`)
 */

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Layer 1 â€” Run Working Memory (typed scratchpad entries)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Working-memory entry kind. Replaces the old "untyped blob" scratchpad.
 *
 * Each kind has a structured shape (see WorkingMemoryEntry below). The
 * runtime can compact, summarize, and prioritise based on kind.
 */
export type WorkingMemoryKind =
  | 'working_plan'
  | 'working_summary'
  | 'pending_questions'
  | 'tool_result_cache'
  | 'artifact_draft'
  | 'evaluation_state'
  | 'turn_history'
  | 'blocker'
  | 'note';

/**
 * Working-memory namespace. Splits scratchpad entries by ownership so the
 * compactor can act on coherent slices.
 */
export type WorkingMemoryNamespace =
  | 'run'      // run-level state (overall plan, run-wide notes)
  | 'agent'    // per-agent working state
  | 'subflow'  // subflow-local state
  | 'turn'     // current turn / multi-turn loop
  | 'eval'     // evaluator-related state
  | 'artifact' // draft artifacts being produced
  | 'system';  // runtime housekeeping

/**
 * One typed entry in run working memory. The combination
 * `(runId, namespace, kind, key)` is unique within a run.
 */
export interface WorkingMemoryEntry<TPayload = unknown> {
  runId: string;
  namespace: WorkingMemoryNamespace;
  kind: WorkingMemoryKind;
  /** Stable identifier within (namespace, kind). E.g. agentId, taskId, slot. */
  key: string;
  /**
   * The structured payload. Shape depends on `kind`:
   *   working_plan       â†’ { steps: Array<{ title, status, owner? }> }
   *   working_summary    â†’ { summary: string, tokenCount: number }
   *   pending_questions  â†’ { questions: string[] }
   *   tool_result_cache  â†’ { toolId, args, result, atIso }
   *   artifact_draft     â†’ { mime, content, version }
   *   evaluation_state   â†’ { evaluatorKey, lastVerdict, lastScore? }
   *   turn_history       â†’ { turns: Array<{ summary, costCents, atIso }> }
   *   blocker            â†’ { reason: string, since: string }
   *   note               â†’ { text: string }
   */
  payload: TPayload;
  /** Approximate token cost â€” used by the compactor. */
  tokenEstimate?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Working-memory summary produced by `summarizeWorking()`.
 *
 * The compactor distills the live scratchpad into a compact paragraph that
 * Layer 5 can inject into prompts without dragging in the full state.
 */
export interface WorkingMemorySummary {
  runId: string;
  summary: string;
  /** Total tokens estimated to be in the live scratchpad before compaction. */
  rawTokens: number;
  /** Tokens in the produced summary. */
  summaryTokens: number;
  /** Namespaces compacted (some may be skipped if irrelevant). */
  compactedNamespaces: WorkingMemoryNamespace[];
  generatedAt: string;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Layer 3 â€” Runtime Episodic Memory
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Type of a runtime episode. These are execution-derived; they answer the
 * question "what happened and why does it matter?".
 *
 * Distinct from the wedge's `MemoryEpisode.kind` (fact|rule|pattern|...) which
 * answers "what does the workspace know?".
 */
export type RuntimeEpisodeType =
  | 'decision'           // a deliberate choice that changed the run's path
  | 'failure'            // something went wrong; root cause may be set
  | 'recovery'           // a strategy that successfully recovered from failure
  | 'success_pattern'    // a recurring pattern that consistently works
  | 'approval'           // an approval that was granted/denied with rationale
  | 'evaluator_outcome'  // an evaluator verdict that's worth remembering
  | 'incident'           // a runtime anomaly with explanation
  | 'artifact_outcome'   // validation result of a produced artifact
  | 'distilled_lesson'
  | 'observation';       // staged, unconsolidated episodic trace (decays unless graduated)

/**
 * Where the episode was created. Trust defaults vary by source (Â§11.2).
 */
export type RuntimeEpisodeSource =
  | 'seed'             // shipped with the package
  | 'run_promotion'    // automatic from a completed run
  | 'agent_write'      // an agent proposed it (capped trust)
  | 'operator_write'   // a human wrote it (high trust)
  | 'evaluator_write'  // an evaluator wrote it (high confidence)
  | 'system_write'     // the runtime wrote it
  | 'harness_ingest';  // distilled from a connected harness's own memory (CLAUDE.md, AGENTS.md, â€¦) when an agent transitions into Agentis

/**
 * Outcome polarity. Used by the retrieval ranker (Â§9.6) and the dashboard.
 */
export type RuntimeEpisodeOutcome = 'good' | 'bad' | 'mixed';

/**
 * One durable runtime episode.
 *
 * Stored in `memory_episodes`. Searchable lexically and (when embeddings
 * are wired) semantically.
 */
export interface RuntimeEpisode {
  id: string;
  workspaceId: string;
  /** Intelligence scope - null for workspace-global episodes. */
  scopeId?: string | null;
  /** Workflow scope â€” null when not workflow-specific. */
  workflowId?: string | null;
  
  runId?: string | null;
  /** Origin agent â€” null when no specific agent owned the lesson. */
  agentId?: string | null;

  type: RuntimeEpisodeType;
  title: string;
  summary: string;
  /** Optional long-form details. Kept separate from `summary` for compact retrieval. */
  details?: string | null;

  source: RuntimeEpisodeSource;

  /** 0..1 â€” how likely this is factually correct. */
  confidence: number;
  /** 0..1 â€” how consequential. */
  importance: number;
  /** 0..1 â€” how much the runtime should rely on this in future execution. */
  trust: number;

  tags: string[];
  /** Named entities (customer ids, product names, evaluator keys, etc.). */
  entities: string[];

  outcomeStatus?: RuntimeEpisodeOutcome | null;

  /** Reserved for vector retrieval â€” null when only lexical is active. */
  embedding?: number[] | null;

  metadata: Record<string, unknown>;

  /** When the episode was last reinforced (re-promoted or re-confirmed). */
  reinforcedAt?: string | null;
  /** Set when archived; archived episodes don't appear in default retrieval. */
  archivedAt?: string | null;
  /** Set when superseded by a newer/contradictory episode; points at it. */
  supersededBy?: string | null;

  createdAt: string;
  updatedAt: string;
}

/** Input to `writeEpisode()`. Fields the caller must provide; runtime fills the rest. */
export interface CreateRuntimeEpisodeInput {
  workspaceId: string;
  scopeId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  type: RuntimeEpisodeType;
  title: string;
  summary: string;
  details?: string | null;
  source: RuntimeEpisodeSource;
  confidence?: number;
  importance?: number;
  trust?: number;
  tags?: string[];
  entities?: string[];
  outcomeStatus?: RuntimeEpisodeOutcome | null;
  metadata?: Record<string, unknown>;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Promotion pipeline (Â§10) â€” audit trail
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Reasons an episode was promoted (Â§10.4 promotion rules). Multiple may
 * apply; the strongest is stored as the primary reason on the event row.
 */
export type PromotionReason =
  | 'human_approved'
  | 'evaluator_validated'
  | 'repeated_pattern'
  | 'major_failure'
  | 'major_success'
  | 'importance_threshold'
  | 'operator_written';

/** Source materials a promotion candidate was extracted from. */
export type PromotionCandidateSource =
  | 'evaluator_failure_summary'
  | 'approval_rationale'
  | 'replay_root_cause'
  | 'tool_failure_pattern'
  | 'winning_output_pattern'
  | 'final_artifact_validation'
  | 'operator_distillation'
  | 'agent_proposal';


export interface MemoryPromotionEvent {
  id: string;
  workspaceId: string;
  scopeId?: string | null;
  runId?: string | null;
  /** The candidate's text, before any normalisation/dedupe. */
  candidateTitle: string;
  candidatePayload: Record<string, unknown>;
  candidateSource: PromotionCandidateSource;
  /** Verdict: 'promoted' (written), 'rejected' (didn't meet rules), 'merged' (deduped into existing), 'superseded' (replaced existing). */
  decision: 'promoted' | 'rejected' | 'merged' | 'superseded';
  /** Primary reason for the decision. */
  reason: PromotionReason | 'duplicate' | 'low_importance' | 'low_confidence';
  /** Episode that was created or updated as a result (null on rejection). */
  episodeId?: string | null;
  /** Computed score (0..1) at decision time. */
  score: number;
  notes?: string | null;
  createdAt: string;
}

/** Promotion candidate before it's written or rejected. */
export interface PromotionCandidate {
  source: PromotionCandidateSource;
  title: string;
  summary: string;
  details?: string | null;
  type: RuntimeEpisodeType;
  outcomeStatus?: RuntimeEpisodeOutcome | null;
  /** Pre-computed signals â€” the scorer uses these. */
  signals: {
    /** Did a human approve? */
    humanApproved?: boolean;
    /** Did an evaluator validate this? */
    evaluatorValidated?: boolean;
    /** How many runs have shown this pattern? */
    repeatedCount?: number;
    /** Caller-provided importance hint (0..1). */
    importanceHint?: number;
    /** Caller-provided confidence hint (0..1). */
    confidenceHint?: number;
  };
  tags?: string[];
  entities?: string[];
  metadata?: Record<string, unknown>;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Memory seeds (Layer 1+3 build-time inputs from a package)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Seed for a runtime episode shipped with a package.
 *
 * Distinct from the wedge's `MemorySeed` (which is for the typed knowledge
 * `workspace_memory` store). This one seeds the `memory_episodes` table.
 */
export interface RuntimeEpisodeSeed {
  type: RuntimeEpisodeType;
  title: string;
  summary: string;
  details?: string;
  outcomeStatus?: RuntimeEpisodeOutcome;
  importance?: number;
  trust?: number;
  tags?: string[];
  entities?: string[];
}



