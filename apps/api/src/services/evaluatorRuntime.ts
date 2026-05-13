/**
 * evaluatorRuntime — AGENT-FIRST-ARCHITECTURE.md Plane 6.
 *
 * Enforces evaluator cost discipline: tries cheap tiers first, escalates to
 * LLM only when cheaper tiers cannot resolve the verdict.
 *
 *   1. schema   — JSON-shape validation
 *   2. rule     — SafeConditionParser expressions, no eval
 *   3. rubric   — example-based comparison, no LLM call
 *   4. llm      — last resort, costs real money
 *
 * Every evaluation is recorded in run_evaluations so the operator can audit
 * which tier ran and how much it cost.
 *
 * Spec: docs/AGENTIS-APP-FORMAT.md §5.
 */

import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  type AppEvaluatorBinding,
  type EvaluatorTier,
} from '@agentis/core';
import { evalCondition } from '../engine/SafeConditionParser.js';
import type { Logger } from '../logger.js';

export type EvaluatorVerdict = 'pass' | 'fail' | 'partial';

export interface EvaluatorEvaluation {
  evaluatorId: string;
  tier: EvaluatorTier;
  verdict: EvaluatorVerdict;
  score: number | null;
  details: Record<string, unknown>;
  costCents: number;
}

export interface EvaluateArgs {
  workspaceId: string;
  runId: string;
  nodeId?: string;
  binding: AppEvaluatorBinding;
  /** The output the evaluator is judging (agent_task result, terminal, etc.). */
  output: unknown;
  /** Optional inputs that produced the output, used by rule expressions. */
  inputs?: Record<string, unknown>;
  /** Optional LLM caller; if absent, llm-tier evaluators return 'partial'. */
  llmCaller?: LlmEvaluatorCaller;
}

export interface LlmEvaluatorCaller {
  evaluate(args: {
    promptTemplate: string;
    output: unknown;
    inputs?: Record<string, unknown>;
    modelClass: 'small' | 'medium' | 'large';
  }): Promise<{ verdict: EvaluatorVerdict; score: number | null; costCents: number; raw?: unknown }>;
}

export class EvaluatorRuntime {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  /**
   * Run the evaluator. The tier ordering is enforced — if a binding declares
   * tier='llm' the runtime warns once and proceeds, but composite bindings
   * always start at the cheapest available tier.
   */
  async evaluate(args: EvaluateArgs): Promise<EvaluatorEvaluation> {
    const tiers = this.#tiersFor(args.binding);
    let lastEval: EvaluatorEvaluation | null = null;
    for (const tier of tiers) {
      const result = await this.#runTier(tier, args);
      lastEval = result;
      if (result.verdict !== 'partial') {
        // First conclusive verdict wins.
        await this.#record(args, result);
        return result;
      }
    }
    // No conclusive verdict — record what we tried.
    const fallback: EvaluatorEvaluation = lastEval ?? {
      evaluatorId: args.binding.id,
      tier: 'schema',
      verdict: 'partial',
      score: null,
      details: { reason: 'no tier could resolve verdict' },
      costCents: 0,
    };
    await this.#record(args, fallback);
    return fallback;
  }

  // ── tier dispatch ─────────────────────────────────────────

  #tiersFor(binding: AppEvaluatorBinding): EvaluatorTier[] {
    // Always try cheaper tiers first when the binding supplies them, even
    // if the declared tier is 'llm'. This is the cost-discipline rule.
    const order: EvaluatorTier[] = [];
    if (binding.schema) order.push('schema');
    if (binding.rules && binding.rules.length > 0) order.push('rule');
    if (binding.rubric) order.push('rubric');
    if (binding.llm) order.push('llm');
    if (order.length === 0) order.push(binding.tier);
    return order;
  }

  async #runTier(tier: EvaluatorTier, args: EvaluateArgs): Promise<EvaluatorEvaluation> {
    switch (tier) {
      case 'schema': return this.#runSchema(args);
      case 'rule':   return this.#runRule(args);
      case 'rubric': return this.#runRubric(args);
      case 'llm':    return this.#runLlm(args);
    }
  }

  #runSchema(args: EvaluateArgs): EvaluatorEvaluation {
    const schemaSpec = args.binding.schema as { type?: string; required?: string[] } | undefined;
    if (!schemaSpec) {
      return { evaluatorId: args.binding.id, tier: 'schema', verdict: 'partial', score: null, details: {}, costCents: 0 };
    }
    const value = args.output;
    if (schemaSpec.type === 'object') {
      if (!value || typeof value !== 'object') {
        return { evaluatorId: args.binding.id, tier: 'schema', verdict: 'fail', score: 0, details: { reason: 'expected object' }, costCents: 0 };
      }
      const obj = value as Record<string, unknown>;
      const missing = (schemaSpec.required ?? []).filter((k) => !(k in obj));
      if (missing.length > 0) {
        return { evaluatorId: args.binding.id, tier: 'schema', verdict: 'fail', score: 0, details: { missing }, costCents: 0 };
      }
      return { evaluatorId: args.binding.id, tier: 'schema', verdict: 'pass', score: 1, details: {}, costCents: 0 };
    }
    if (schemaSpec.type && typeof value !== schemaSpec.type) {
      return { evaluatorId: args.binding.id, tier: 'schema', verdict: 'fail', score: 0, details: { expected: schemaSpec.type, got: typeof value }, costCents: 0 };
    }
    return { evaluatorId: args.binding.id, tier: 'schema', verdict: 'pass', score: 1, details: {}, costCents: 0 };
  }

  #runRule(args: EvaluateArgs): EvaluatorEvaluation {
    const rules = args.binding.rules ?? [];
    const failed: Array<{ id: string; errorCode: string }> = [];
    for (const rule of rules) {
      const ctx = { output: args.output, inputs: args.inputs ?? {}, scratchpad: {} } as Record<string, unknown>;
      try {
        const passed = evalCondition(rule.condition, ctx);
        if (!passed) {
          failed.push({ id: rule.id, errorCode: rule.errorCode });
        }
      } catch (err) {
        this.logger.warn('evaluator.rule_error', { ruleId: rule.id, error: (err as Error).message });
        failed.push({ id: rule.id, errorCode: 'EVALUATOR_RULE_ERROR' });
      }
    }
    if (failed.length === 0) {
      return { evaluatorId: args.binding.id, tier: 'rule', verdict: 'pass', score: 1, details: {}, costCents: 0 };
    }
    return { evaluatorId: args.binding.id, tier: 'rule', verdict: 'fail', score: 0, details: { failed }, costCents: 0 };
  }

  #runRubric(args: EvaluateArgs): EvaluatorEvaluation {
    const rubric = args.binding.rubric;
    if (!rubric || rubric.examples.length === 0) {
      return { evaluatorId: args.binding.id, tier: 'rubric', verdict: 'partial', score: null, details: {}, costCents: 0 };
    }
    // Lightweight similarity: compare JSON shape of output to each example's
    // output, score by structural overlap. Real implementation would use
    // embeddings — kept simple here so the cost stays at zero.
    const score = rubric.examples.reduce((best, ex) => {
      const sim = jsonShapeSimilarity(args.output, ex.output);
      const adjusted = ex.verdict === 'pass' ? sim : -sim;
      return Math.max(best, adjusted);
    }, -Infinity);
    const minScore = rubric.minScore ?? 0.5;
    if (score >= minScore) {
      return { evaluatorId: args.binding.id, tier: 'rubric', verdict: 'pass', score, details: { strategy: 'shape-similarity' }, costCents: 0 };
    }
    if (score < 0) {
      return { evaluatorId: args.binding.id, tier: 'rubric', verdict: 'fail', score, details: { strategy: 'shape-similarity' }, costCents: 0 };
    }
    return { evaluatorId: args.binding.id, tier: 'rubric', verdict: 'partial', score, details: { strategy: 'shape-similarity' }, costCents: 0 };
  }

  async #runLlm(args: EvaluateArgs): Promise<EvaluatorEvaluation> {
    const llm = args.binding.llm;
    if (!llm) {
      return { evaluatorId: args.binding.id, tier: 'llm', verdict: 'partial', score: null, details: { reason: 'no llm binding' }, costCents: 0 };
    }
    if (!args.llmCaller) {
      // The runtime gracefully degrades to 'partial' when no LLM is wired.
      return { evaluatorId: args.binding.id, tier: 'llm', verdict: 'partial', score: null, details: { reason: 'no llm caller available' }, costCents: 0 };
    }
    this.logger.warn('evaluator.llm_tier_used', { evaluatorId: args.binding.id, modelClass: llm.modelClass });
    const r = await args.llmCaller.evaluate({
      promptTemplate: llm.promptTemplate,
      output: args.output,
      inputs: args.inputs,
      modelClass: llm.modelClass,
    });
    return {
      evaluatorId: args.binding.id,
      tier: 'llm',
      verdict: r.verdict,
      score: r.score,
      details: { raw: r.raw ?? null, modelClass: llm.modelClass },
      costCents: r.costCents,
    };
  }

  async #record(args: EvaluateArgs, result: EvaluatorEvaluation): Promise<void> {
    this.db
      .insert(schema.runEvaluations)
      .values({
        id: randomUUID(),
        workspaceId: args.workspaceId,
        runId: args.runId,
        nodeId: args.nodeId ?? null,
        evaluatorId: result.evaluatorId,
        tier: result.tier,
        verdict: result.verdict,
        score: result.score !== null ? result.score.toString() : null,
        details: result.details,
        costCents: result.costCents,
      })
      .run();
  }
}

// ── helpers ──────────────────────────────────────────────────

function jsonShapeSimilarity(a: unknown, b: unknown): number {
  if (typeof a !== typeof b) return 0;
  if (a === null || b === null) return a === b ? 1 : 0;
  if (typeof a !== 'object') return a === b ? 1 : 0;
  if (Array.isArray(a) !== Array.isArray(b)) return 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === 0 && b.length === 0) return 1;
    const sample = Math.min(a.length, b.length, 5);
    let total = 0;
    for (let i = 0; i < sample; i++) total += jsonShapeSimilarity(a[i], b[i]);
    return total / Math.max(a.length, b.length);
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  if (keys.size === 0) return 1;
  let total = 0;
  for (const k of keys) total += jsonShapeSimilarity(ao[k], bo[k]);
  return total / keys.size;
}
