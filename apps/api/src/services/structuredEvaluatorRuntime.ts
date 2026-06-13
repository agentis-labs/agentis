import type { Logger } from '../logger.js';
import type {
  EvaluateArgs,
  EvaluatorVerdict,
  RouteBranchArgs,
} from './evaluatorRuntime.js';
import type { StructuredCompleter } from './structuredCompleter.js';

/**
 * The workflow engine only needs these two evaluator operations. Keeping the
 * contract structural lets a dedicated HTTP evaluator and a live agent adapter
 * provide the same behavior.
 */
export interface EvaluationRuntime extends StructuredCompleter {
  evaluate(args: EvaluateArgs): Promise<EvaluatorVerdict>;
  routeBranch(args: RouteBranchArgs): Promise<string | null>;
}

/**
 * LLM-as-judge behavior backed by any structured completion source, including
 * an agent's already configured chat adapter.
 */
export class StructuredEvaluatorRuntime implements EvaluationRuntime {
  constructor(
    private readonly completer: StructuredCompleter,
    private readonly logger: Logger,
  ) {}

  get label(): string | undefined {
    return this.completer.label;
  }

  get lastError(): string | null | undefined {
    return this.completer.lastError;
  }

  completeStructured<T extends Record<string, unknown>>(args: {
    system: string;
    user: string;
    maxTokens?: number;
    maxAttempts?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<T | null> {
    return this.completer.completeStructured<T>(args);
  }

  async evaluate(args: EvaluateArgs): Promise<EvaluatorVerdict> {
    const passThreshold = args.passThreshold ?? 7;
    const rubricBlock = args.rubric && args.rubric.length > 0
      ? `\n\nRUBRIC DIMENSIONS (assign a score 0-10 per dimension, weights guide your overall judgement):\n${
        args.rubric.map((dimension) => `- ${dimension.dimension} (weight ${dimension.weight})`).join('\n')
      }`
      : '';
    const system =
      'You are a strict, fair quality evaluator. Score the OUTPUT against the CRITERIA. '
      + 'Respond with a single JSON object only - no prose, markdown, or code fences. '
      + 'Schema: { "score": number 0-10, "passed": boolean, "critique": string'
      + (args.rubric && args.rubric.length > 0
        ? ', "dimensionScores": [{"dimension": string, "score": number}]'
        : '')
      + ' }';
    const user =
      `CRITERIA:\n${args.criteria}\n\nOUTPUT TO EVALUATE:\n${stringifyTarget(args.target)}${rubricBlock}`;

    const raw = await this.completer.completeStructured<Record<string, unknown>>({
      system,
      user,
      maxTokens: 600,
      maxAttempts: 3,
    });
    const verdict = parseVerdict(raw);
    if (!verdict) {
      const reason = this.completer.lastError
        ? `: ${this.completer.lastError}`
        : '';
      this.logger.warn('evaluator.adapter_parse_failed', {
        source: this.completer.label,
        error: this.completer.lastError ?? null,
      });
      return {
        score: 0,
        passed: false,
        critique: `evaluator response was not valid JSON${reason}; treating as failure`,
      };
    }
    return {
      score: verdict.score,
      passed: verdict.passed ?? verdict.score >= passThreshold,
      critique: verdict.critique ?? '',
      dimensionScores: verdict.dimensionScores,
    };
  }

  async routeBranch(args: RouteBranchArgs): Promise<string | null> {
    const branchList = args.branches
      .map((branch) => `- ${branch.branchId}: ${branch.label}${
        branch.condition ? ` (condition hint: ${branch.condition})` : ''
      }`)
      .join('\n');
    const result = await this.completer.completeStructured<{ branchId?: unknown }>({
      system:
        'You are a workflow router. Given an INPUT and a list of branches, pick the single best '
        + 'branchId to follow. Respond with one JSON object only: { "branchId": string }',
      user: `INPUT:\n${stringifyTarget(args.input)}\n\nBRANCHES:\n${branchList}`,
      maxTokens: 80,
      maxAttempts: 3,
    });
    return typeof result?.branchId === 'string' ? result.branchId : null;
  }
}

function stringifyTarget(target: unknown): string {
  if (typeof target === 'string') return target;
  try {
    return JSON.stringify(target, null, 2);
  } catch {
    return String(target);
  }
}

function parseVerdict(raw: Record<string, unknown> | null): {
  score: number;
  passed?: boolean;
  critique?: string;
  dimensionScores?: Array<{ dimension: string; score: number }>;
} | null {
  if (!raw) return null;
  const score = Number(raw.score);
  if (!Number.isFinite(score)) return null;
  const verdict: {
    score: number;
    passed?: boolean;
    critique?: string;
    dimensionScores?: Array<{ dimension: string; score: number }>;
  } = {
    score: Math.max(0, Math.min(10, score)),
  };
  if (typeof raw.passed === 'boolean') verdict.passed = raw.passed;
  if (typeof raw.critique === 'string') verdict.critique = raw.critique;
  if (Array.isArray(raw.dimensionScores)) {
    verdict.dimensionScores = raw.dimensionScores
      .filter((item): item is { dimension: string; score: number } => {
        return Boolean(
          item
          && typeof item === 'object'
          && typeof (item as { dimension?: unknown }).dimension === 'string'
          && Number.isFinite(Number((item as { score?: unknown }).score)),
        );
      })
      .map((item) => ({
        dimension: item.dimension,
        score: Math.max(0, Math.min(10, Number(item.score))),
      }));
  }
  return verdict;
}
