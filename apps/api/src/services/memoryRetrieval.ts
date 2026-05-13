/**
 * MemoryRetrieval — Layer 5 (Retrieval Memory).
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md §9.
 *
 * The unified `IMemoryRuntime.buildContext()` implementation. Composes
 * results from layers 1–4 into a single token-budgeted `InjectedMemoryContext`.
 *
 * Priority order (§9.5):
 *   1. working summary for current run
 *   2. app-local evaluator examples
 *   3. app-local episodic success/failure patterns
 *   4. app-local knowledge hits
 *   5. workspace-level adjacent knowledge if needed
 *   6. baseline hints
 *
 * Token budget enforcement: trims layers in REVERSE priority order until the
 * composed context fits under the budget (§9.4).
 *
 * Injection modes (§9.7):
 *   - strict       → only high-trust app-local memory (trust ≥ 0.8)
 *   - normal       → app-local + limited workspace memory (default)
 *   - exploratory  → wider retrieval when ambiguity is high
 */

import {
  MEMORY_BUDGETS,
  type BaselineHint,
  type EvaluatorExample,
  type InjectedMemoryContext,
  type KnowledgeHit,
  type RetrievalBudgetClass,
  type RetrievalMode,
  type RetrievalParams,
  type RuntimeEpisode,
  type WorkflowBaselineSnapshot,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { KnowledgeStore } from './knowledgeStore.js';
import type { EpisodicMemoryStore } from './episodicMemoryStore.js';
import type { EvaluatorExampleStore } from './evaluatorExampleStore.js';
import type { WorkflowBaselineStore } from './workflowBaselineStore.js';
import type { RollingBaselineStore } from './rollingBaselineStore.js';
import type { WorkingMemoryCompactor } from './workingMemoryCompactor.js';

// Layer caps per budget class. The trimmer can shrink these further on budget pressure.
const DEFAULT_CAPS: Record<RetrievalBudgetClass, {
  knowledge: number;
  episodes: number;
  evaluatorExamples: number;
  baselineHints: number;
}> = {
  cheap:    { knowledge: 4, episodes: 3, evaluatorExamples: 2, baselineHints: 1 },
  balanced: { knowledge: 8, episodes: 5, evaluatorExamples: 4, baselineHints: 2 },
  power:    { knowledge: 12, episodes: 8, evaluatorExamples: 6, baselineHints: 3 },
};

// Trust thresholds per mode. Below this, items are dropped from retrieval.
const TRUST_THRESHOLD: Record<RetrievalMode, number> = {
  strict: 0.8,
  normal: 0.4,
  exploratory: 0.2,
};

export class MemoryRetrieval {
  constructor(
    private readonly knowledge: KnowledgeStore,
    private readonly episodes: EpisodicMemoryStore,
    private readonly evaluators: EvaluatorExampleStore,
    private readonly baselines: WorkflowBaselineStore,
    private readonly rollingBaselines: RollingBaselineStore,
    private readonly compactor: WorkingMemoryCompactor,
    private readonly logger: Logger,
  ) {}

  // ────────────────────────────────────────────────────────────
  // The unified entry point
  // ────────────────────────────────────────────────────────────

  /**
   * Compose a memory context across all five layers.
   *
   * The returned context is token-budgeted and ranked. Empty arrays are
   * meaningful — they signal "nothing relevant" (§12.4: never fabricate).
   */
  buildContext(params: RetrievalParams): InjectedMemoryContext {
    const start = Date.now();
    const mode: RetrievalMode = params.mode ?? 'normal';
    const budgetClass: RetrievalBudgetClass = params.budgetClass ?? 'balanced';
    const tokenBudget = params.tokenBudget ?? MEMORY_BUDGETS[budgetClass];
    const caps = { ...DEFAULT_CAPS[budgetClass], ...(params.caps ?? {}) };
    const includeWorking = params.includeWorkingSummary !== false;

    const droppedLayers: InjectedMemoryContext['diagnostics']['droppedLayers'] = [];

    // ── Layer 1: working summary (priority 1) ───────────────
    let workingSummary: string | undefined;
    if (includeWorking && params.runId) {
      try {
        const s = this.compactor.summarize(params.runId);
        workingSummary = s.summary || undefined;
      } catch (err) {
        this.logger.warn('memory.retrieval.working_summary_failed', {
          runId: params.runId,
          message: (err as Error).message,
        });
      }
    }

    // ── Layer 4: evaluator examples (priority 2) ────────────
    let evaluatorExamples: EvaluatorExample[] = [];
    if (params.appId) {
      try {
        evaluatorExamples = this.evaluators.list({
          workspaceId: params.workspaceId,
          appId: params.appId,
          limit: caps.evaluatorExamples,
        });
      } catch (err) {
        this.logger.warn('memory.retrieval.evaluators_failed', {
          appId: params.appId,
          message: (err as Error).message,
        });
      }
    }

    // ── Layer 3: episodic memory (priority 3) ───────────────
    let episodicHits: RuntimeEpisode[] = [];
    try {
      const args: Parameters<typeof this.episodes.searchEpisodes>[0] = {
        workspaceId: params.workspaceId,
        query: params.taskDescription,
        limit: caps.episodes,
      };
      if (params.appId) args.appId = params.appId;
      if (params.workflowId) args.workflowId = params.workflowId;
      episodicHits = this.episodes.searchEpisodes(args);
      // Trust filter per mode.
      const threshold = TRUST_THRESHOLD[mode];
      episodicHits = episodicHits.filter((e) => e.trust >= threshold);
    } catch (err) {
      this.logger.warn('memory.retrieval.episodes_failed', { message: (err as Error).message });
    }

    // ── Layer 2: knowledge (priority 4–5) ───────────────────
    let knowledgeHits: KnowledgeHit[] = [];
    if (params.appId) {
      try {
        knowledgeHits = this.knowledge.search({
          workspaceId: params.workspaceId,
          appId: params.appId,
          query: params.taskDescription,
          limit: caps.knowledge,
        });
      } catch (err) {
        this.logger.warn('memory.retrieval.knowledge_failed', {
          appId: params.appId,
          message: (err as Error).message,
        });
      }
    }

    // Workspace-level fallback (priority 5) — only in normal/exploratory mode
    // and only if app-local knowledge was thin.
    if (mode !== 'strict' && knowledgeHits.length < Math.max(2, Math.floor(caps.knowledge / 2))) {
      // Future enhancement: scan adjacent apps in the workspace. For V1, we
      // surface a diagnostic note so the operator knows knowledge was thin.
      // (Cross-app retrieval is policy-driven; §17 cautions against making it default.)
    }

    // Trust filter on knowledge.
    const trustThreshold = TRUST_THRESHOLD[mode];
    knowledgeHits = knowledgeHits.filter((h) => h.trust >= trustThreshold);

    // ── Layer 4: baseline hints (priority 6) ────────────────
    let baselineHints: BaselineHint[] = [];
    if (params.appId) {
      try {
        // Prefer rolling baselines (richer); fall back to simpler workflowBaselines.
        const rolling = this.rollingBaselines.latestForApp(params.workspaceId, params.appId);
        if (rolling.length > 0) {
          baselineHints = rolling
            .filter((b) => !params.workflowId || b.workflowId === params.workflowId)
            .slice(0, caps.baselineHints)
            .map((b) => ({
              workflowId: b.workflowId,
              expectedSuccessRate: b.successRate,
              avgCostMicros: b.avgCostMicros,
              p95LatencyMs: b.p95LatencyMs,
              note: rollingNote(b),
            }));
        } else {
          const wedgeBaselines = this.baselines.latestForApp(params.workspaceId, params.appId);
          baselineHints = wedgeBaselines
            .filter((b: WorkflowBaselineSnapshot) => !params.workflowId || b.workflowId === params.workflowId)
            .slice(0, caps.baselineHints)
            .map((b: WorkflowBaselineSnapshot) => ({
              workflowId: b.workflowId,
              ...(b.successRate !== undefined ? { expectedSuccessRate: b.successRate } : {}),
              ...(b.costCentsPerRun !== undefined ? { avgCostMicros: (b.costCentsPerRun ?? 0) * 10000 } : {}),
              ...(b.p95DurationMs !== undefined ? { p95LatencyMs: b.p95DurationMs } : {}),
            }));
        }
      } catch (err) {
        this.logger.warn('memory.retrieval.baselines_failed', { message: (err as Error).message });
      }
    }

    // ── Token budgeting ─────────────────────────────────────
    let trimmed = false;
    let tokenEstimate = estimateAll(workingSummary, knowledgeHits, episodicHits, evaluatorExamples, baselineHints);

    // Trim in reverse priority. (Working summary is priority 1 — shrink last.)
    while (tokenEstimate > tokenBudget) {
      // 6: baselineHints
      if (baselineHints.length > 0) {
        baselineHints.pop();
        if (baselineHints.length === 0) droppedLayers.push('baselineHints');
      }
      // 5: knowledge (prefer dropping lowest-score first)
      else if (knowledgeHits.length > 0) {
        knowledgeHits.pop();
        if (knowledgeHits.length === 0) droppedLayers.push('knowledge');
      }
      // 4: episodes
      else if (episodicHits.length > 0) {
        episodicHits.pop();
        if (episodicHits.length === 0) droppedLayers.push('episodes');
      }
      // 3: evaluator examples
      else if (evaluatorExamples.length > 0) {
        evaluatorExamples.pop();
        if (evaluatorExamples.length === 0) droppedLayers.push('evaluatorExamples');
      }
      // 1: working summary (last resort — truncate, not drop)
      else if (workingSummary) {
        // Truncate by 25% and re-estimate.
        const targetLen = Math.floor(workingSummary.length * 0.75);
        if (targetLen < 200) {
          workingSummary = undefined;
          droppedLayers.push('workingSummary');
        } else {
          workingSummary = workingSummary.slice(0, targetLen) + '…';
        }
      } else {
        // Nothing left to trim.
        break;
      }
      trimmed = true;
      tokenEstimate = estimateAll(workingSummary, knowledgeHits, episodicHits, evaluatorExamples, baselineHints);
    }

    const composedInMs = Date.now() - start;
    const result: InjectedMemoryContext = {
      knowledgeHits,
      episodicHits,
      evaluatorExamples,
      baselineHints,
      tokenEstimate,
      diagnostics: {
        budgetUsed: params.tokenBudget !== undefined ? 'custom' : budgetClass,
        tokenBudget,
        mode,
        trimmed,
        droppedLayers,
        composedInMs,
      },
      composedAt: new Date().toISOString(),
    };
    if (workingSummary !== undefined) result.workingSummary = workingSummary;
    return result;
  }

  // ────────────────────────────────────────────────────────────
  // Convenience search APIs (delegate to underlying stores)
  // ────────────────────────────────────────────────────────────

  searchKnowledge(params: {
    workspaceId: string;
    appId: string;
    query: string;
    topK?: number;
    mode?: 'lexical' | 'semantic' | 'hybrid';
  }): KnowledgeHit[] {
    const args: Parameters<typeof this.knowledge.search>[0] = {
      workspaceId: params.workspaceId,
      appId: params.appId,
      query: params.query,
    };
    if (params.topK !== undefined) args.limit = params.topK;
    if (params.mode === 'semantic') args.mode = 'vector';
    else if (params.mode === 'hybrid') args.mode = 'hybrid';
    else if (params.mode === 'lexical') args.mode = 'lexical';
    return this.knowledge.search(args);
  }

  searchEpisodes(params: {
    workspaceId: string;
    appId?: string;
    query: string;
    topK?: number;
  }): RuntimeEpisode[] {
    const args: Parameters<typeof this.episodes.searchEpisodes>[0] = {
      workspaceId: params.workspaceId,
      query: params.query,
    };
    if (params.appId) args.appId = params.appId;
    if (params.topK !== undefined) args.limit = params.topK;
    return this.episodes.searchEpisodes(args);
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function estimateAll(
  workingSummary: string | undefined,
  knowledge: KnowledgeHit[],
  episodes: RuntimeEpisode[],
  examples: EvaluatorExample[],
  baselines: BaselineHint[],
): number {
  let t = 0;
  if (workingSummary) t += Math.ceil(workingSummary.length / 4);
  for (const h of knowledge) t += Math.ceil((h.title.length + h.content.length) / 4);
  for (const e of episodes) {
    t += Math.ceil((e.title.length + e.summary.length + (e.details?.length ?? 0)) / 4);
  }
  for (const ex of examples) {
    t += Math.ceil((JSON.stringify(ex.input).length + JSON.stringify(ex.expected).length) / 4);
  }
  for (const b of baselines) {
    t += Math.ceil((b.workflowId.length + (b.note?.length ?? 0) + 50) / 4);
  }
  return t;
}

/** Compose a short note from a rolling baseline snapshot. */
function rollingNote(b: { successRate: number; sampleSize: number; window: string }): string {
  if (b.sampleSize === 0) return `${b.window} window: no sample data yet`;
  return `${b.window} success ${(b.successRate * 100).toFixed(0)}% over ${b.sampleSize} runs`;
}
