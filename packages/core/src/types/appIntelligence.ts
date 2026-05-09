/**
 * App Knowledge Wedge — Agentis 1.1.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md.
 *
 * The four intelligence classes and the runtime contract that makes them
 * compose into one coherent system:
 *
 *   1. Seeds                  — builder-authored, packaged with the app
 *   2. Imported datasets      — operator-provided business data, ingested per app
 *   3. Evaluator examples     — pass/fail references and rubric calibration
 *   4. Promoted intelligence  — distilled patterns earned from real execution
 *
 * Every type here is shared by:
 *   - the AGENTIS-APP-FORMAT package model (build-time, what ships)
 *   - the runtime stores (read/write surfaces)
 *   - the AppIntelligenceRuntime composition (retrieval API)
 *   - the /v1/apps/:appId/intelligence response (UI surface)
 *
 * Naming conventions:
 *   - "Seed" types are static and travel with the package.
 *   - "Spec" types describe a contract (datasets the app can absorb).
 *   - Plain entity types (e.g. `KnowledgeChunk`) describe what's persisted at runtime.
 *   - "Hit" / "Episode" / "Example" are retrieval results.
 */

// ────────────────────────────────────────────────────────────
// Enums (small, exhaustive, exported as union-of-strings)
// ────────────────────────────────────────────────────────────

/**
 * Where ingested data lands. Mirrors the four classes but is restricted to
 * places ingestion can write (promotion is a separate runtime concern).
 */
export type IngestionTargetStore =
  | 'knowledge'
  | 'memory'
  | 'evaluator_examples'
  | 'baseline_inputs';

/**
 * How the ingestion pipeline splits a source. Each strategy is a deterministic
 * function `bytes -> chunks[]` documented in `datasetIngestion.ts`.
 */
export type ChunkingStrategy =
  | 'per-row'
  | 'per-document'
  | 'per-function'
  | 'sliding-window'
  | 'semantic';

/**
 * The role this dataset plays in the app's competitive moat.
 *
 * Setup wizards, the App Canvas, and the intelligence response all use this
 * to surface "what really matters" vs "nice to have".
 */
export type WedgeRole =
  | 'primary_specialization'
  | 'performance_booster'
  | 'compliance_guardrail'
  | 'historical_context'
  | 'quality_calibration';

/**
 * Areas a dataset is expected to influence. Used by the impact-preview
 * generator and by ranking ("which wedge inputs touch retrieval?").
 */
export type ExpectedImpactArea =
  | 'retrieval'
  | 'routing'
  | 'evaluation'
  | 'output_quality'
  | 'cost_efficiency';

/**
 * How fresh the operator should keep this dataset.
 *
 * Drives reminders ("CRM export is 2 months old; re-import?") and ranking
 * (older = decayed weight on retrieval).
 */
export type FreshnessExpectation =
  | 'static'
  | 'monthly'
  | 'weekly'
  | 'daily'
  | 'live';

/** Status of a dataset ingestion job — V1 in-process worker. */
export type DatasetIngestionStatus =
  | 'pending'
  | 'parsing'
  | 'chunking'
  | 'indexing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Trust scale used everywhere a piece of intelligence carries authority. */
export type TrustLevel = number; // 0..1

// ────────────────────────────────────────────────────────────
// Class 1 — Seeds (build-time, packaged with the app)
// ────────────────────────────────────────────────────────────

/**
 * Knowledge seed: domain taxonomies, heuristics, business rules, references.
 *
 * Shipped as part of `AgentisPackageContents` and copied verbatim into the
 * runtime knowledge store on activation. Compact, portable, high-signal —
 * not raw business history.
 */
export interface KnowledgeSeed {
  title: string;
  /** Human-readable text. The store may chunk by paragraph at activation. */
  content: string;
  /** Optional tags; used for retrieval-time filtering and UI grouping. */
  tags?: string[];
  /** Free-form metadata. Reserved keys: `source`, `version`, `embeddingHint`. */
  metadata?: Record<string, unknown>;
}

/**
 * Memory seed: compact facts the app should "already know" — preferences,
 * recurring rules, named patterns. Distinguished from knowledge by intent:
 * memory is recalled, knowledge is retrieved.
 */
export interface MemorySeed {
  title: string;
  content: string;
  /**
   * 0..1. Trust the seed carries from the package author. Operator review
   * may raise or lower this; promotion can pin trust to 1.0.
   */
  trust?: TrustLevel;
  /** 0..1. Bias toward keeping this in the budgeted retrieval window. */
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** A single labelled example shipped with an app for evaluator calibration. */
export interface EvaluatorExampleSeed {
  /** Which evaluator binding this example is meant to calibrate. */
  evaluatorKey: string;
  /** Input shown to the evaluator. */
  input: unknown;
  /** Expected output — exact, schema-shaped, or paraphrase reference. */
  expected: unknown;
  verdict: 'pass' | 'fail';
  /** Optional human-readable rationale (why pass/fail). */
  reason?: string;
  /** Optional 0..1 score for rubric tiers that score rather than verdict. */
  score?: number;
}

/**
 * Rubric (collection of evaluator examples for a node kind).
 *
 * Mirrors `AppEvaluatorBinding` from `appContract.ts` but is the build-time
 * declaration shipped with the package, not the runtime binding.
 */
export interface EvaluatorRubric {
  /** Node kind this rubric applies to (e.g. `agent_task`, `terminal_output`). */
  nodeKind: string;
  /** Human-readable context describing what's being judged. */
  context: string;
  /** Calibration examples. */
  examples: EvaluatorExampleSeed[];
}

/** Build-time baseline — what the package author claims is normal. */
export interface WorkflowBaselineSeed {
  /** Workflow slug inside the package — resolved to a workflow id at activation. */
  workflowSlug: string;
  p50DurationMs?: number;
  p95DurationMs?: number;
  /** 0..1. */
  expectedSuccessRate?: number;
  costCentsPerRun?: number;
  /** How many runs the package author observed to derive this baseline. */
  derivedFromRuns?: number;
}

// ────────────────────────────────────────────────────────────
// Class 2 — DatasetSpec (build-time contract for what the app can absorb)
// ────────────────────────────────────────────────────────────

/**
 * Dataset spec — the app declares what kinds of operator data it can absorb,
 * how that data should be chunked, where it lands, and what role it plays.
 *
 * Deliberately stronger than the spec in `AGENTIS-APP-FORMAT.md` — adds
 * `wedgeRole`, `expectedImpact`, and `freshnessExpectation` so the runtime
 * and UI can rank, prompt, and explain imports.
 */
export interface DatasetSpec {
  key: string;
  label: string;
  description: string;
  icon?: string;
  /** Free-form format identifiers (e.g. `csv`, `hubspot-export`, `pdf`). */
  acceptedFormats: string[];
  targetStore: IngestionTargetStore;
  chunkingStrategy: ChunkingStrategy;
  /** Fields the parser must find before ingestion can start. */
  requiredFields?: string[];
  optional: boolean;
  /** True when the app wants the operator to import this. UI should nudge. */
  recommended?: boolean;
  wedgeRole: WedgeRole;
  /**
   * What the import is expected to change about the app's behaviour.
   * Used to render the impact preview after ingestion completes.
   */
  expectedImpact?: {
    affects: ExpectedImpactArea[];
    note?: string;
  };
  /** Hint passed to the embedding/encoding step (when models support it). */
  embeddingHint?: string;
  freshnessExpectation?: FreshnessExpectation;
  sizeWarningAboveRows?: number;
  example?: {
    sampleColumns?: string[];
    exportInstructions?: string;
  };
}

// ────────────────────────────────────────────────────────────
// Package contents (the wedge-aware extension of AGENTIS-APP-FORMAT §4)
// ────────────────────────────────────────────────────────────

/**
 * Wedge-aware contents shipped inside an Agentis package. This is the
 * source-of-truth for what gets installed and seeded into runtime stores.
 *
 * The schema lives in `packages/core/src/schema/package.ts` and `apps/api/src/routes/packages.ts`
 * (the parser); this type is the structural shape the rest of the system
 * consumes.
 */
export interface AgentisPackageContents {
  /** Imported datasets the app expects the operator to bring. */
  datasetSpecs: DatasetSpec[];
  /** Class 1: seeds. */
  knowledgeSeeds: KnowledgeSeed[];
  memorySeeds: MemorySeed[];
  evaluatorRubrics: EvaluatorRubric[];
  evaluatorExampleSeeds?: EvaluatorExampleSeed[];
  workflowBaselines: WorkflowBaselineSeed[];
}

// ────────────────────────────────────────────────────────────
// Runtime entities (what's stored, what gets returned by retrieval)
// ────────────────────────────────────────────────────────────

/**
 * One indexed slice of knowledge. A `KnowledgeSeed` may produce 1+ chunks
 * depending on its size; an imported document may produce many.
 */
export interface KnowledgeChunk {
  id: string;
  workspaceId: string;
  appId: string;
  title: string;
  content: string;
  /** Tokenised text used by the V1 lexical retriever. */
  contentTokens?: string[];
  source: 'seed' | 'import' | 'promotion';
  /** Free-form provenance: package version, dataset key, ingestion job id, etc. */
  provenance: Record<string, unknown>;
  tags: string[];
  /** Reserved for vector retrieval — null on the V1 lexical path. */
  embedding?: number[] | null;
  /** Author-declared trust at write time; retrieval may decay this. */
  trust: TrustLevel;
  createdAt: string;
  updatedAt: string;
}

/**
 * One memory episode. App memory stores typed, compact facts and patterns
 * — not raw run output. Promotion writes here; the operator can edit.
 */
export interface MemoryEpisode {
  id: string;
  workspaceId: string;
  appId: string;
  /** What kind of memory this is — narrows retrieval and UI grouping. */
  kind: 'fact' | 'preference' | 'pattern' | 'rule' | 'lesson';
  source: 'seed' | 'promotion' | 'operator';
  title: string;
  content: string;
  trust: TrustLevel;
  importance: number;
  tags: string[];
  /** Provenance: which run/approval/evaluator promoted this, if applicable. */
  provenance: Record<string, unknown>;
  /** When the episode was last reinforced (re-promoted or re-confirmed). */
  reinforcedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A persisted evaluator example, sourced from seed, import, or run feedback. */
export interface EvaluatorExample {
  id: string;
  workspaceId: string;
  appId: string;
  evaluatorKey: string;
  source: 'seed' | 'import' | 'operator' | 'promotion';
  input: unknown;
  expected: unknown;
  verdict: 'pass' | 'fail';
  score?: number;
  reason?: string;
  /** Optional run that produced this example (operator-confirmed verdicts). */
  originRunId?: string | null;
  createdAt: string;
}

/**
 * A rolling baseline snapshot for one workflow. Distinct from
 * `app_baseline_snapshots` (Plane 8 aggregate); these are the per-workflow
 * versioned records the wedge UI surfaces.
 */
export interface WorkflowBaselineSnapshot {
  id: string;
  workspaceId: string;
  appId: string;
  workflowId: string;
  source: 'seed' | 'derived';
  p50DurationMs?: number;
  p95DurationMs?: number;
  successRate?: number;
  costCentsPerRun?: number;
  /** Sample window meta. */
  sampleSize: number;
  windowStart: string;
  windowEnd: string;
  capturedAt: string;
}

/**
 * A Class 4 promoted pattern — distilled, durable, attributed to its source.
 *
 * Promotion writes here only when:
 *   - confidence threshold met
 *   - operator-approved (depending on policy)
 *   - evaluator-confirmed
 */
export interface PromotedPattern {
  id: string;
  workspaceId: string;
  appId: string;
  /** What kind of pattern — narrows the surfaces it can flow back into. */
  kind:
    | 'successful_playbook'
    | 'failure_with_fix'
    | 'approved_output_pattern'
    | 'business_rule'
    | 'recurring_exception';
  title: string;
  summary: string;
  /** Structured payload — schema depends on kind. */
  payload: Record<string, unknown>;
  /** 0..1 — confidence in the promotion. Decays on counter-evidence. */
  confidence: number;
  trust: TrustLevel;
  /** Number of independent occurrences that contributed to this pattern. */
  evidenceCount: number;
  /** Provenance: source run ids, evaluator ids, approvals. */
  provenance: Record<string, unknown>;
  /** When the pattern was last reinforced. */
  reinforcedAt: string;
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────
// Retrieval results
// ────────────────────────────────────────────────────────────

export interface KnowledgeHit {
  chunkId: string;
  appId: string;
  title: string;
  content: string;
  /** 0..1 retrieval score (lexical TF-IDF in V1; cosine sim or hybrid when vector path is active). */
  score: number;
  source: KnowledgeChunk['source'];
  tags: string[];
  trust: TrustLevel;
  provenance: Record<string, unknown>;
  /**
   * How this hit was retrieved. Absent on legacy hits; present when the
   * vector path is active (HashingEmbeddingProvider or external model).
   */
  retrievalMethod?: 'lexical' | 'vector' | 'hybrid';
}

// ────────────────────────────────────────────────────────────
// Composed runtime context (what AppIntelligenceRuntime returns)
// ────────────────────────────────────────────────────────────

/**
 * Composed view used by agents, evaluators, and planners. Token budgets are
 * enforced by the runtime; consumers read this as already-shaped.
 */
export interface AppIntelligenceContext {
  appId: string;
  query: string;
  /** Knowledge results — seeds first, then imports, then promotion. */
  seedKnowledge: KnowledgeHit[];
  importedKnowledge: KnowledgeHit[];
  /** Memory episodes ranked by trust × importance × recency. */
  memoryPatterns: MemoryEpisode[];
  /** Evaluator examples relevant to the run's evaluator bindings. */
  evaluatorExamples: EvaluatorExample[];
  /** Latest baseline per workflow involved. */
  baselineHints: WorkflowBaselineSnapshot[];
  /** Promoted patterns that may apply (Class 4). */
  promotedPatterns: PromotedPattern[];
  /** Estimated token weight of everything in this context. */
  tokenEstimate: number;
  /** Composed-at timestamp. */
  composedAt: string;
}

// ────────────────────────────────────────────────────────────
// Dataset ingestion (runtime job lifecycle)
// ────────────────────────────────────────────────────────────

/**
 * One ingestion job. Tracked end-to-end so the UI can show progress, the
 * operator can resume, and the impact preview can be generated.
 */
export interface DatasetIngestionJob {
  id: string;
  workspaceId: string;
  appId: string;
  /** Matches a `DatasetSpec.key` from the app's manifest. */
  datasetKey: string;
  status: DatasetIngestionStatus;
  /** Inputs as parsed from the upload — never the raw bytes. */
  sourceMeta: {
    format: string;
    fileName?: string;
    sizeBytes?: number;
    rowCount?: number;
  };
  totalItems: number;
  processedItems: number;
  /** Items routed into the target store after chunking. */
  storedItems: number;
  errors: Array<{ at: string; code: string; message: string; itemIndex?: number }>;
  /** Filled in once status === 'completed'. */
  impact?: DatasetImpactPreview;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Per-item status for granular resume tracking (Agentis 1.1.1). */
export type DatasetImportItemStatus = 'pending' | 'completed' | 'failed' | 'skipped';

/**
 * One row-level item tracked inside a dataset ingestion job.
 *
 * Added to enable granular recovery: failed items can be retried when the
 * operator re-uploads the same file. Items are identified by their content
 * hash so the pipeline can skip already-completed rows.
 */
export interface DatasetImportItem {
  id: string;
  workspaceId: string;
  /** Parent job. */
  importJobId: string;
  /** Position of this item in the parsed payload (0-indexed). */
  itemIndex: number;
  status: DatasetImportItemStatus;
  /** SHA-256 hex of the item's content — dedup key on resume. */
  contentHash: string;
  /** ID in the target store (knowledge chunk, memory episode, etc.). */
  storedId?: string | null;
  /** Error message if status === 'failed'. */
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Impact preview generated after ingestion completes.
 *
 * The wedge-doc rule: "X records imported" is not enough. We also surface
 * which clusters formed, which evaluators got more confident, and which
 * memory regions strengthened.
 */
export interface DatasetImpactPreview {
  newKnowledgeClusters: number;
  evaluatorConfidenceDelta: Array<{ evaluatorKey: string; delta: number }>;
  memoryRegionsStrengthened: string[];
  workflowBaselinesAffected: string[];
  /** Free-form notes — human-readable summary of the impact. */
  notes: string[];
}

// ────────────────────────────────────────────────────────────
// API response shape — /v1/apps/:appId/intelligence
// ────────────────────────────────────────────────────────────

export interface AppIntelligenceResponse {
  app: {
    id: string;
    slug: string;
    name: string;
    status: string;
  };
  summary: {
    seedCount: number;
    importedDatasetCount: number;
    knowledgeClusterCount: number;
    promotedMemoryCount: number;
    evaluatorExampleCount: number;
    baselineConfidence: number | null;
  };
  seeds: {
    knowledge: Array<{ title: string; source: string }>;
    memory: Array<{ title: string; trust: number }>;
    evaluatorExamples: Array<{ evaluatorKey: string; count: number }>;
  };
  imports: Array<{
    datasetKey: string;
    label: string;
    wedgeRole: WedgeRole;
    status: DatasetIngestionStatus;
    freshness: FreshnessExpectation | null;
    targetStore: IngestionTargetStore;
    counts: {
      sourceItems: number;
      storedItems: number;
      promotedItems?: number;
    };
  }>;
  memory: {
    patterns: Array<{ id: string; title: string; trust: number; confidence: number }>;
    /** Areas the wedge wants imports for but hasn't received them. */
    gaps: Array<{ key: string; label: string; reason: string }>;
  };
  evaluators: Array<{
    key: string;
    confidence: number;
    exampleCount: number;
  }>;
  baselines: Array<{
    workflowId: string;
    successRate: number;
    avgCostMicros: number;
    sampleSize: number;
  }>;
}

// ────────────────────────────────────────────────────────────
// Activation / promotion contracts (small but explicit)
// ────────────────────────────────────────────────────────────

/** Result of seeding an app's intelligence on package install. */
export interface AppActivationResult {
  appId: string;
  knowledgeChunksCreated: number;
  memoryEpisodesCreated: number;
  evaluatorExamplesCreated: number;
  workflowBaselinesCreated: number;
}

/** Promotion request — what the runtime hands to IntelligencePromotion. */
export interface PromotionInput {
  appId: string;
  workspaceId: string;
  kind: PromotedPattern['kind'];
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  /** Source evidence (run ids, approval ids, evaluator verdicts). */
  provenance: Record<string, unknown>;
  /** Optional 0..1 confidence supplied by the caller — runtime may override. */
  confidenceHint?: number;
}
