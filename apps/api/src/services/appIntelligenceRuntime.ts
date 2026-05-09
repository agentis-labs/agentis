/**
 * AppIntelligenceRuntime — composed retrieval for the four wedge classes.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §10.
 *
 * One service that any agent / evaluator / planner can ask:
 *
 *   "Given this query and this app, what should I know right now?"
 *
 * Returns an `AppIntelligenceContext` shaped by:
 *   1. Knowledge retrieval — seeds + imports, lexical TF-IDF (KnowledgeStore).
 *   2. Memory recall — trust × importance × recency (AppMemoryStore).
 *   3. Evaluator examples — most recent calibration set per evaluator key.
 *   4. Baseline hints — latest snapshot per workflow.
 *   5. Promoted patterns — top by confidence × evidence × recency.
 *
 * The runtime enforces a single token budget across all five sources,
 * trimming the lowest-priority entries when over budget. Priority order
 * (highest to lowest) when trimming:
 *
 *   memoryPatterns (rules/preferences first)
 *   promotedPatterns (highest-confidence first)
 *   importedKnowledge (TF-IDF top hits)
 *   seedKnowledge
 *   evaluatorExamples
 *   baselineHints (cheap anyway)
 */

import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type {
  AppIntelligenceContext,
  EvaluatorExample,
  KnowledgeHit,
  MemoryEpisode,
  PromotedPattern,
  WorkflowBaselineSnapshot,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { KnowledgeStore } from './knowledgeStore.js';
import type { AppMemoryStore } from './appMemoryStore.js';
import type { EvaluatorExampleStore } from './evaluatorExampleStore.js';
import type { WorkflowBaselineStore } from './workflowBaselineStore.js';

export interface ComposeArgs {
  workspaceId: string;
  appId: string;
  query: string;
  /** Hard cap on combined token estimate. Default 4000 tokens (~16k chars). */
  tokenBudget?: number;
  /** Maximum knowledge hits before trimming. Default 8. */
  knowledgeLimit?: number;
  /** Maximum memory episodes. Default 12. */
  memoryLimit?: number;
  /** Maximum promoted patterns. Default 8. */
  promotedLimit?: number;
  /** Restrict knowledge to certain sources. */
  knowledgeSources?: KnowledgeHit['source'][];
  /** Restrict memory to certain kinds (e.g. only 'rule'+'preference'). */
  memoryKinds?: MemoryEpisode['kind'][];
  /** Evaluator keys to load examples for. */
  evaluatorKeys?: string[];
  /** Workflow ids to load baselines for. */
  workflowIds?: string[];
}

const DEFAULT_TOKEN_BUDGET = 4000;
const APPROX_CHARS_PER_TOKEN = 4;

export class AppIntelligenceRuntime {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly knowledge: KnowledgeStore,
    private readonly memory: AppMemoryStore,
    private readonly evaluators: EvaluatorExampleStore,
    private readonly baselines: WorkflowBaselineStore,
    private readonly logger: Logger,
  ) {}

  /** Compose the full context for a query. */
  compose(args: ComposeArgs): AppIntelligenceContext {
    const knowledgeLimit = args.knowledgeLimit ?? 8;
    const memoryLimit = args.memoryLimit ?? 12;
    const promotedLimit = args.promotedLimit ?? 8;
    const tokenBudget = args.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

    // 1. Knowledge — split into seed vs import for the response shape.
    const allHits = this.knowledge.search({
      workspaceId: args.workspaceId,
      appId: args.appId,
      query: args.query,
      limit: knowledgeLimit * 2,
      sources: args.knowledgeSources,
    });
    const seedKnowledge: KnowledgeHit[] = [];
    const importedKnowledge: KnowledgeHit[] = [];
    for (const hit of allHits) {
      if (hit.source === 'seed') seedKnowledge.push(hit);
      else importedKnowledge.push(hit);
    }
    // Cap each side to half the limit, but allow the larger side to use the
    // remaining budget if the smaller side is empty.
    const half = Math.ceil(knowledgeLimit / 2);
    const seedTrimmed = seedKnowledge.slice(0, half);
    const importTrimmed = importedKnowledge.slice(
      0,
      knowledgeLimit - seedTrimmed.length,
    );

    // 2. Memory — recall biased toward rules/preferences for prompt prelude.
    const memoryPatterns = this.memory.recall({
      workspaceId: args.workspaceId,
      appId: args.appId,
      hint: args.query,
      limit: memoryLimit,
      kinds: args.memoryKinds,
    });

    // 3. Evaluator examples — most recent N per requested key (or all keys).
    const evaluatorExamples = this.#loadEvaluatorExamples(
      args.workspaceId,
      args.appId,
      args.evaluatorKeys,
    );

    // 4. Baseline hints — latest per workflow id.
    const baselineHints = args.workflowIds
      ? args.workflowIds
          .map((id) => this.baselines.latest(args.workspaceId, args.appId, id))
          .filter((b): b is WorkflowBaselineSnapshot => b !== null)
      : this.baselines.latestForApp(args.workspaceId, args.appId);

    // 5. Promoted patterns — top by composite score.
    const promotedPatterns = this.#loadPromotedPatterns(
      args.workspaceId,
      args.appId,
      args.query,
      promotedLimit,
    );

    // Build the context, then trim if over budget.
    const context: AppIntelligenceContext = {
      appId: args.appId,
      query: args.query,
      seedKnowledge: seedTrimmed,
      importedKnowledge: importTrimmed,
      memoryPatterns,
      evaluatorExamples,
      baselineHints,
      promotedPatterns,
      tokenEstimate: 0,
      composedAt: new Date().toISOString(),
    };
    context.tokenEstimate = estimateTokens(context);

    if (context.tokenEstimate > tokenBudget) {
      this.#trimToBudget(context, tokenBudget);
    }

    this.logger.info('app.intelligence.composed', {
      workspaceId: args.workspaceId,
      appId: args.appId,
      tokenEstimate: context.tokenEstimate,
      seedHits: context.seedKnowledge.length,
      importHits: context.importedKnowledge.length,
      memory: context.memoryPatterns.length,
      promoted: context.promotedPatterns.length,
    });

    return context;
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  #loadEvaluatorExamples(
    workspaceId: string,
    appId: string,
    keys?: string[],
  ): EvaluatorExample[] {
    if (!keys || keys.length === 0) {
      // Without a specific key, surface the most recent 8 examples across the app.
      return this.evaluators.list({ workspaceId, appId, limit: 8 });
    }
    const out: EvaluatorExample[] = [];
    for (const k of keys) {
      out.push(
        ...this.evaluators.list({ workspaceId, appId, evaluatorKey: k, limit: 4 }),
      );
    }
    return out;
  }

  #loadPromotedPatterns(
    workspaceId: string,
    appId: string,
    query: string,
    limit: number,
  ): PromotedPattern[] {
    const rows = this.db
      .select()
      .from(schema.appPromotedPatterns)
      .where(
        and(
          eq(schema.appPromotedPatterns.workspaceId, workspaceId),
          eq(schema.appPromotedPatterns.appId, appId),
        ),
      )
      .orderBy(desc(schema.appPromotedPatterns.reinforcedAt))
      .all();
    if (rows.length === 0) return [];

    const queryLower = query.toLowerCase();
    const scored = rows.map((row) => {
      const pattern = rowToPattern(row);
      const text = `${pattern.title}\n${pattern.summary}`.toLowerCase();
      let queryHit = 1;
      if (queryLower) {
        for (const tok of queryLower.split(/\s+/)) {
          if (tok.length >= 3 && text.includes(tok)) {
            queryHit = 1.4;
            break;
          }
        }
      }
      const evidenceBoost = 1 + Math.log10(1 + pattern.evidenceCount);
      const score = pattern.confidence * pattern.trust * evidenceBoost * queryHit;
      return { pattern, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ pattern }) => pattern);
  }

  /**
   * Trim the context to fit a token budget. Strategy:
   *   - Drop tail entries from the lowest-priority lists first.
   *   - Recompute on each iteration so the estimator stays honest.
   *   - Hard floor: keep at least 1 entry per list when possible.
   */
  #trimToBudget(ctx: AppIntelligenceContext, budget: number): void {
    const order: Array<keyof AppIntelligenceContext> = [
      'baselineHints',
      'evaluatorExamples',
      'seedKnowledge',
      'importedKnowledge',
      'promotedPatterns',
      'memoryPatterns',
    ];
    let safety = 200;
    while (ctx.tokenEstimate > budget && safety > 0) {
      let trimmed = false;
      for (const key of order) {
        const arr = ctx[key] as unknown as unknown[];
        if (Array.isArray(arr) && arr.length > 1) {
          arr.pop();
          trimmed = true;
          break;
        }
      }
      if (!trimmed) break;
      ctx.tokenEstimate = estimateTokens(ctx);
      safety -= 1;
    }
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function estimateTokens(ctx: AppIntelligenceContext): number {
  let chars = 0;
  for (const h of ctx.seedKnowledge) chars += h.title.length + h.content.length;
  for (const h of ctx.importedKnowledge) chars += h.title.length + h.content.length;
  for (const m of ctx.memoryPatterns) chars += m.title.length + m.content.length;
  for (const e of ctx.evaluatorExamples) {
    chars += JSON.stringify(e.input).length + JSON.stringify(e.expected).length + 32;
  }
  for (const b of ctx.baselineHints) chars += 80; // ~ small fixed
  for (const p of ctx.promotedPatterns) chars += p.title.length + p.summary.length;
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

function rowToPattern(row: typeof schema.appPromotedPatterns.$inferSelect): PromotedPattern {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    appId: row.appId,
    kind: row.kind as PromotedPattern['kind'],
    title: row.title,
    summary: row.summary,
    payload: parseJsonRecord(row.payload),
    confidence: Number(row.confidence),
    trust: Number(row.trust),
    evidenceCount: row.evidenceCount,
    provenance: parseJsonRecord(row.provenance),
    reinforcedAt: row.reinforcedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
