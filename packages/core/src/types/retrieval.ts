/**
 * Retrieval Memory types — Layer 5 of the Memory Architecture.
 *
 *
 * Layer 5 is not a store. It's the selection and injection layer that
 * composes results from layers 1–4 under a token budget. This file defines:
 *
 *   - Budget classes (cheap | balanced | power) with their token caps
 *   - Injection modes (strict | normal | exploratory) controlling scope
 *   - The composed `InjectedMemoryContext` returned to callers
 *   - The retrieval ranking weights used by the scorer
 */

import type { KnowledgeHit } from './intelligence.js';
import type { EvaluatorExample, WorkflowBaselineSnapshot } from './intelligence.js';
import type { RuntimeEpisode } from './memory.js';

// ────────────────────────────────────────────────────────────
// Budget classes — §9.4
// ────────────────────────────────────────────────────────────

/**
 * How aggressively to retrieve. Maps to a token budget for the entire
 * injected context (knowledge + episodes + examples + summaries).
 */
export type RetrievalBudgetClass = 'cheap' | 'balanced' | 'power';

/**
 * Token budgets for each class. The retrieval runtime trims results until
 * the composed context fits under the budget.
 */
export const MEMORY_BUDGETS = {
  cheap: 1200,
  balanced: 2500,
  power: 5000,
} as const satisfies Record<RetrievalBudgetClass, number>;

// ────────────────────────────────────────────────────────────
// Injection modes — §9.7
// ────────────────────────────────────────────────────────────

/**
 * Controls retrieval scope:
 *   - strict       → only high-trust scoped memory
 *   - normal       → scoped + limited workspace memory (default)
 *   - exploratory  → wider retrieval when ambiguity is high
 */
export type RetrievalMode = 'strict' | 'normal' | 'exploratory';

// ────────────────────────────────────────────────────────────
// Retrieval scope — §6.7
// ────────────────────────────────────────────────────────────

/** Where to search (precedence order: run → workspace). */
export type RetrievalScope = 'run' | 'scoped' | 'workspace' | 'cross_workspace';

// ────────────────────────────────────────────────────────────
// Ranking weights — §9.6
// ────────────────────────────────────────────────────────────

/**
 * Default weights for the multi-signal ranker. Each candidate's final score
 * is a weighted sum of the signals below; weights sum to 1.0.
 *
 * Weights can be overridden per-call via `RetrievalParams.weights`.
 */
export const RETRIEVAL_WEIGHTS = {
  semantic: 0.35,
  lexical: 0.15,
  trust: 0.20,
  freshness: 0.10,
  scope: 0.10,
  outcome: 0.10,
} as const;

export type RetrievalWeights = {
  semantic: number;
  lexical: number;
  trust: number;
  freshness: number;
  scope: number;
  outcome: number;
};

// ────────────────────────────────────────────────────────────
// Request — `IMemoryRuntime.buildContext()` arguments
// ────────────────────────────────────────────────────────────

/**
 * Parameters for composing a memory context. Most fields are optional;
 * only `workspaceId` and `taskDescription` are required.
 */
export interface RetrievalParams {
  workspaceId: string;
  /** Optional intelligence scope. When set, scoped results are ranked higher. */
  scopeId?: string;
  workflowId?: string;
  runId?: string;
  agentId?: string;
  /** The query — typically the current task description or agent prompt. */
  taskDescription: string;
  /** Override default budget. */
  budgetClass?: RetrievalBudgetClass;
  /** Explicit token cap (overrides budgetClass). */
  tokenBudget?: number;
  /** Scope width. */
  mode?: RetrievalMode;
  /** Override default ranker weights. */
  weights?: Partial<RetrievalWeights>;
  /** Optional per-layer caps (defaults: balanced). */
  caps?: {
    knowledge?: number;
    episodes?: number;
    evaluatorExamples?: number;
    baselineHints?: number;
  };
  /** When false, omit the working summary (some callers don't need it). */
  includeWorkingSummary?: boolean;
}

// ────────────────────────────────────────────────────────────
// Response — composed context
// ────────────────────────────────────────────────────────────

/**
 * One baseline hint surfaced to callers. Compact (just the numbers that
 * influence reasoning).
 */
export interface BaselineHint {
  workflowId: string;
  expectedSuccessRate?: number;
  avgCostMicros?: number;
  p95LatencyMs?: number;
  /** Free-form note (e.g. "elevated latency last 24h"). */
  note?: string;
}

/**
 * The composed retrieval result returned by `buildContext()`.
 *
 * Token-budgeted: the runtime trims layers in priority order (§9.5) so the
 * total fits under the budget. Empty arrays mean "nothing relevant" — never
 * inject fabricated context (§12.4).
 */
export interface InjectedMemoryContext {
  /** Compact summary of run working memory (§9.5 priority 1). */
  workingSummary?: string;
  /** Knowledge chunks (Layer 2). */
  knowledgeHits: KnowledgeHit[];
  /** Durable execution lessons (Layer 3). */
  episodicHits: RuntimeEpisode[];
  /** Evaluator calibration examples (Layer 4). */
  evaluatorExamples: EvaluatorExample[];
  /** Compact baseline hints (Layer 4). */
  baselineHints: BaselineHint[];
  /** Estimated total tokens in this context. */
  tokenEstimate: number;
  /** Diagnostic metadata — useful for debugging retrieval. */
  diagnostics: {
    budgetUsed: RetrievalBudgetClass | 'custom';
    tokenBudget: number;
    mode: RetrievalMode;
    /** True if the runtime hit the budget and trimmed lower-priority layers. */
    trimmed: boolean;
    /** Layers that were dropped or capped due to budget pressure. */
    droppedLayers: Array<'knowledge' | 'episodes' | 'evaluatorExamples' | 'baselineHints' | 'workingSummary'>;
    /** Latency in ms to compose the context. */
    composedInMs: number;
  };
  composedAt: string;
}

// ────────────────────────────────────────────────────────────
// Per-candidate scoring breakdown (for debugging / explainability)
// ────────────────────────────────────────────────────────────

/**
 * Per-candidate score breakdown. Useful for the dashboard's "why was this
 * retrieved?" panel and for tuning the weights.
 */
export interface RetrievalScoreBreakdown {
  candidateId: string;
  layer: 'knowledge' | 'episode' | 'evaluator' | 'baseline';
  finalScore: number;
  signals: {
    semantic: number;
    lexical: number;
    trust: number;
    freshness: number;
    scope: number;
    outcome: number;
  };
}
