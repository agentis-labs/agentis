/**
 * brainEvalHarness — Brain 10x §C8, the memory benchmark harness.
 *
 * The sharpest market observation: the winner is "the only one publishing memory
 * benchmark results." You cannot disrupt a market you don't measure. This makes
 * the brain a MEASURED product: a LoCoMo/BEAM-style suite (single-hop, multi-hop,
 * temporal, knowledge-update, unanswerable/abstention) run against the real
 * retrieval + cited-ask stack, producing a scorecard. The companion CI-gate test
 * (`tests/brain/brainEval.test.ts`) fails a PR if abstention or recall regress —
 * so every phase that claims a number has to keep it.
 *
 * The starter dataset is intentionally small + synthetic + extensible. It is a
 * harness, not a leaderboard — its value is the regression gate + the honest
 * scorecard, which grows as real categories are added.
 */

import type { AgentisToolContext } from '@agentis/core';
import type { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import type { BrainAskService } from '../../src/services/brain/brainAskService.js';
import type { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';

export type EvalCategory =
  | 'single_hop'
  | 'multi_hop'
  | 'temporal'
  | 'knowledge_update'
  | 'unanswerable';

export interface EvalCase {
  id: string;
  category: EvalCategory;
  /** Facts seeded into the brain before the question. */
  facts: string[];
  question: string;
  /** Lowercased substring the grounded answer MUST contain (answerable cases). */
  expectContains?: string;
  /** True when the brain SHOULD abstain (nothing in memory answers it). */
  unanswerable?: boolean;
}

export const BRAIN_EVAL_CASES: EvalCase[] = [
  {
    id: 'sh-1', category: 'single_hop',
    facts: ['The Q3 board meeting is scheduled for September 12 in the main conference room.'],
    question: 'When is the Q3 board meeting scheduled?',
    expectContains: 'september 12',
  },
  {
    id: 'sh-2', category: 'single_hop',
    facts: ['The production database runs on PostgreSQL version 16.'],
    question: 'Which database version does production run on PostgreSQL?',
    expectContains: '16',
  },
  {
    id: 'mh-1', category: 'multi_hop',
    facts: [
      'The Salesforce migration project is owned by the data platform team.',
      'The data platform team is led by Priya Nair.',
    ],
    question: 'Who owns and leads the Salesforce migration data platform team?',
    expectContains: 'priya',
  },
  {
    id: 'tmp-1', category: 'temporal',
    facts: [
      'As of January the API rate limit for partners was 100 requests per minute.',
      'In June the partner API rate limit was raised to 500 requests per minute.',
    ],
    question: 'What is the current partner API rate limit in requests per minute?',
    expectContains: '500',
  },
  {
    id: 'ku-1', category: 'knowledge_update',
    facts: [
      'The project launch deadline was originally Friday.',
      'Update: the project launch deadline moved to next Wednesday after the review.',
    ],
    question: 'When is the project launch deadline now scheduled?',
    expectContains: 'wednesday',
  },
  {
    id: 'un-1', category: 'unanswerable',
    facts: ['The office coffee machine is a Breville Barista Express.'],
    question: 'What is the quarterly revenue target for the EMEA sales region?',
    unanswerable: true,
  },
  {
    id: 'un-2', category: 'unanswerable',
    facts: ['The deploy pipeline requires a green CI run before promotion.'],
    question: 'Who is the primary contact for the legal compliance review?',
    unanswerable: true,
  },
];

/**
 * A "recovery" case: the upfront `buildDispatchContext` pass is expected to
 * MISS (a query worded nothing like the seeded fact), and the agent's own
 * `agentis.brain.search` mid-task tool — not just a raw service call — is
 * expected to recover the answer with a reformulated query. This measures
 * the thing §C8's original cases never did: whether an agent's second look
 * actually finds what its first look missed.
 */
export interface RecoveryEvalCase {
  id: string;
  facts: string[];
  /** Deliberately mismatched — should make the upfront dispatch context abstain. */
  initialQuery: string;
  /** Reformulated/broader terms — should recover the fact via agentis.brain.search. */
  retryQuery: string;
  /** Lowercased substring the recovered search result MUST contain. */
  expectContains: string;
}

export const BRAIN_RECOVERY_CASES: RecoveryEvalCase[] = [
  {
    id: 'rec-1',
    facts: ['The on-call escalation path for payment failures is to page the platform-reliability team via PagerDuty.'],
    // Long and topically unrelated on purpose: with a bag-of-words test embedder,
    // a SHORT query is disproportionately vulnerable to a single incidental hash
    // collision inflating cosine score — spreading the query over many unrelated
    // tokens keeps any stray collision's contribution well below the relevance floor.
    initialQuery: 'Please write a short poem about autumn leaves falling gently in a quiet park during a late October afternoon.',
    retryQuery: 'payment failure escalation on-call',
    expectContains: 'platform-reliability',
  },
];

export interface RecoveryCaseResult {
  id: string;
  /** Did the upfront pass correctly find nothing (the setup this case needs)? */
  initialAbstained: boolean;
  /** Did the mid-task tool call recover the fact the upfront pass missed? */
  recovered: boolean;
}

export interface RecoveryScorecard {
  results: RecoveryCaseResult[];
  /** Of cases where the upfront pass correctly abstained, how many recovered via retry. */
  recoveryRate: number;
}

/**
 * Run the recovery suite against the REAL registered `agentis.brain.search`
 * tool (registry + handler + deps) — not a raw `searchAtoms` call — so this
 * actually exercises the path an agent takes mid-task, not just retrieval
 * quality in isolation (that's what `runBrainEval` already covers).
 */
export async function runRecoveryEval(args: {
  cases: RecoveryEvalCase[];
  seed: (facts: string[]) => Promise<string> | string;
  brain: SharedIntelligenceService;
  registry: AgentisToolRegistry;
  toolCtx: (workspaceId: string) => AgentisToolContext;
}): Promise<RecoveryScorecard> {
  const results: RecoveryCaseResult[] = [];
  for (const c of args.cases) {
    const workspaceId = await args.seed(c.facts);
    const initial = await args.brain.buildDispatchContext({ workspaceId, taskDescription: c.initialQuery, limit: 6 });
    // `atomIds` alone isn't a reliable abstention signal — Tier-0 backfill can
    // pad the quota with weak-threshold filler even when nothing is really
    // relevant (see `relevantCount`, which excludes it).
    const initialAbstained = initial.relevantCount === 0;

    const retry = await args.registry.execute(
      { id: `recovery-${c.id}`, toolId: 'agentis.brain.search', arguments: { query: c.retryQuery } },
      args.toolCtx(workspaceId),
    );
    const output = retry.ok ? (retry.output as { results?: Array<{ title: string; snippet: string }> } | undefined) : undefined;
    const recovered = Boolean(
      output?.results?.some((r) => `${r.title} ${r.snippet}`.toLowerCase().includes(c.expectContains.toLowerCase())),
    );
    results.push({ id: c.id, initialAbstained, recovered });
  }
  const eligible = results.filter((r) => r.initialAbstained);
  const recoveredCount = eligible.filter((r) => r.recovered).length;
  return {
    results,
    recoveryRate: eligible.length > 0 ? Number((recoveredCount / eligible.length).toFixed(3)) : 1,
  };
}

export interface CategoryScore { total: number; correct: number; accuracy: number }
export interface BrainEvalScorecard {
  byCategory: Record<EvalCategory, CategoryScore>;
  overall: CategoryScore;
  /** Abstention correctness: of all unanswerable cases, how many abstained. */
  abstentionRate: number;
  /** Faithfulness: of answered (non-abstained) cases, how many were grounded-correct. */
  faithfulness: number;
}

/**
 * Run the suite against a real brain. The caller provides a per-case fresh
 * workspace seeder so cases don't leak into each other.
 */
export async function runBrainEval(args: {
  cases: EvalCase[];
  /** Seed facts for one case; returns the workspaceId to query. */
  seed: (facts: string[]) => Promise<string> | string;
  ask: BrainAskService;
  brain: SharedIntelligenceService;
}): Promise<BrainEvalScorecard> {
  const cats: EvalCategory[] = ['single_hop', 'multi_hop', 'temporal', 'knowledge_update', 'unanswerable'];
  const byCategory = Object.fromEntries(cats.map((c) => [c, { total: 0, correct: 0, accuracy: 0 }])) as Record<EvalCategory, CategoryScore>;
  let answeredTotal = 0;
  let answeredCorrect = 0;
  let unanswerableTotal = 0;
  let abstained = 0;

  for (const c of args.cases) {
    const workspaceId = await args.seed(c.facts);
    const res = await args.ask.ask({ workspaceId, query: c.question });
    const bucket = byCategory[c.category];
    bucket.total += 1;

    if (c.unanswerable) {
      unanswerableTotal += 1;
      if (res.abstained) { abstained += 1; bucket.correct += 1; }
    } else {
      const ok = !res.abstained && typeof c.expectContains === 'string'
        && res.answer.toLowerCase().includes(c.expectContains);
      if (!res.abstained) {
        answeredTotal += 1;
        if (ok) answeredCorrect += 1;
      }
      if (ok) bucket.correct += 1;
    }
  }

  for (const c of cats) {
    const b = byCategory[c];
    b.accuracy = b.total > 0 ? Number((b.correct / b.total).toFixed(3)) : 1;
  }
  const overallTotal = args.cases.length;
  const overallCorrect = cats.reduce((s, c) => s + byCategory[c].correct, 0);
  return {
    byCategory,
    overall: { total: overallTotal, correct: overallCorrect, accuracy: Number((overallCorrect / Math.max(1, overallTotal)).toFixed(3)) },
    abstentionRate: unanswerableTotal > 0 ? Number((abstained / unanswerableTotal).toFixed(3)) : 1,
    faithfulness: answeredTotal > 0 ? Number((answeredCorrect / answeredTotal).toFixed(3)) : 1,
  };
}
