/**
 * Memory Architecture types — Agentis Memory OS.
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md
 *
 * The Memory Architecture defines five layers:
 *
 *   1. Run Working Memory     — scratchpad + compact turn state for active runs
 *   2. App Knowledge          — seeds + imported datasets (App Knowledge Wedge)
 *   3. Episodic Memory        — durable lessons distilled from execution
 *   4. Evaluator + Baselines  — what "good" looks like
 *   5. Retrieval Memory       — semantic + lexical selection across the layers
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
 * Naming distinction with the App Knowledge Wedge:
 *   - Wedge `MemoryEpisode`  — typed knowledge (fact|preference|pattern|rule|lesson)
 *   - Memory `RuntimeEpisode` — durable execution lesson (decision|failure|recovery|...)
 *
 * These coexist because they answer different questions:
 *   - "What does this app know?"           → wedge MemoryEpisode (`app_memory`)
 *   - "What happened during execution?"    → RuntimeEpisode (`memory_episodes`)
 */

// ────────────────────────────────────────────────────────────
// Layer 1 — Run Working Memory (typed scratchpad entries)
// ────────────────────────────────────────────────────────────

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
   *   working_plan       → { steps: Array<{ title, status, owner? }> }
   *   working_summary    → { summary: string, tokenCount: number }
   *   pending_questions  → { questions: string[] }
   *   tool_result_cache  → { toolId, args, result, atIso }
   *   artifact_draft     → { mime, content, version }
   *   evaluation_state   → { evaluatorKey, lastVerdict, lastScore? }
   *   turn_history       → { turns: Array<{ summary, costCents, atIso }> }
   *   blocker            → { reason: string, since: string }
   *   note               → { text: string }
   */
  payload: TPayload;
  /** Approximate token cost — used by the compactor. */
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

// ────────────────────────────────────────────────────────────
// Layer 3 — Runtime Episodic Memory
// ────────────────────────────────────────────────────────────

/**
 * Type of a runtime episode. These are execution-derived; they answer the
 * question "what happened and why does it matter?".
 *
 * Distinct from the wedge's `MemoryEpisode.kind` (fact|rule|pattern|...) which
 * answers "what does the app know?".
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
  | 'distilled_lesson';  // operator- or agent-distilled lesson

/**
 * Where the episode was created. Trust defaults vary by source (§11.2).
 */
export type RuntimeEpisodeSource =
  | 'seed'             // shipped with the app package
  | 'run_promotion'    // automatic from a completed run
  | 'agent_write'      // an agent proposed it (capped trust)
  | 'operator_write'   // a human wrote it (high trust)
  | 'evaluator_write'  // an evaluator wrote it (high confidence)
  | 'system_write';    // the runtime wrote it

/**
 * Outcome polarity. Used by the retrieval ranker (§9.6) and the dashboard.
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
  /** App scope — null for workspace-global episodes. */
  appId?: string | null;
  /** Workflow scope — null when not workflow-specific. */
  workflowId?: string | null;
  /** Origin run — null for operator-written or seed episodes. */
  runId?: string | null;
  /** Origin agent — null when no specific agent owned the lesson. */
  agentId?: string | null;

  type: RuntimeEpisodeType;
  title: string;
  summary: string;
  /** Optional long-form details. Kept separate from `summary` for compact retrieval. */
  details?: string | null;

  source: RuntimeEpisodeSource;

  /** 0..1 — how likely this is factually correct. */
  confidence: number;
  /** 0..1 — how consequential. */
  importance: number;
  /** 0..1 — how much the runtime should rely on this in future execution. */
  trust: number;

  tags: string[];
  /** Named entities (customer ids, product names, evaluator keys, etc.). */
  entities: string[];

  outcomeStatus?: RuntimeEpisodeOutcome | null;

  /** Reserved for vector retrieval — null when only lexical is active. */
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
  appId?: string | null;
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

// ────────────────────────────────────────────────────────────
// Promotion pipeline (§10) — audit trail
// ────────────────────────────────────────────────────────────

/**
 * Reasons an episode was promoted (§10.4 promotion rules). Multiple may
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

/**
 * One audit-trail event for the memory promotion pipeline.
 *
 * Stored in `memory_promotion_events`. Lets operators see exactly why a
 * given episode landed in durable memory (and what was rejected).
 */
export interface MemoryPromotionEvent {
  id: string;
  workspaceId: string;
  appId?: string | null;
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
  /** Pre-computed signals — the scorer uses these. */
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

// ────────────────────────────────────────────────────────────
// Memory seeds (Layer 1+3 build-time inputs from a package)
// ────────────────────────────────────────────────────────────

/**
 * Seed for a runtime episode shipped with a package.
 *
 * Distinct from the wedge's `MemorySeed` (which is for the typed knowledge
 * `app_memory` store). This one seeds the `memory_episodes` table.
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
