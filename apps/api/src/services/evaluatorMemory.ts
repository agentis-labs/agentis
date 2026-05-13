/**
 * EvaluatorMemory — evaluator-linked memory bridge.
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md §8 + §13.3.
 *
 * The spec lists `evaluatorMemory.ts` as a required new service (§13.3). In
 * the V1 implementation, evaluator-linked memory is provided by two existing
 * services:
 *
 *   - `EvaluatorExampleStore`  — stores rubrics, example pairs, and verdicts
 *                                 (Class 3 intelligence in the App Knowledge Wedge)
 *   - `MemoryRuntime.writeEvaluatorExample()` — trust-scored write path
 *
 * This file provides a focused facade for the evaluator→memory feedback loop:
 * after an evaluator produces a verdict, `EvaluatorMemory.recordVerdict()`
 * persists the outcome both as an evaluator example (for future calibration)
 * and as a runtime episode (so the lesson survives package upgrades).
 *
 * Consumers: EvaluatorRuntime, RunPromotionExtractor, agent tools.
 */

import type { EvaluatorExample, RuntimeEpisode } from '@agentis/core';
import type { Logger } from '../logger.js';
import type { EvaluatorExampleStore } from './evaluatorExampleStore.js';
import type { EpisodicMemoryStore } from './episodicMemoryStore.js';

export interface RecordVerdictArgs {
  workspaceId: string;
  appId: string;
  evaluatorKey: string;
  /** The input that was evaluated. */
  input: unknown;
  /** The expected / reference value. */
  expected: unknown;
  /** Evaluator verdict. */
  verdict: 'pass' | 'fail';
  /** Confidence score 0..1, returned by the evaluator. */
  score?: number;
  reason?: string;
  /** Originating run, for attribution. */
  runId?: string;
  /**
   * Whether to also write a runtime episode to Layer 3.
   *
   * Set to `true` for high-signal verdicts (e.g. rubric-fail with clear reason)
   * that are worth remembering beyond the example calibration set.
   */
  writeEpisode?: boolean;
}

export interface VerdictRecord {
  example: EvaluatorExample;
  episode?: RuntimeEpisode;
}

export class EvaluatorMemory {
  constructor(
    private readonly examples: EvaluatorExampleStore,
    private readonly episodes: EpisodicMemoryStore,
    private readonly logger: Logger,
  ) {}

  /**
   * Record an evaluator verdict.
   *
   * Always writes to `app_evaluator_examples`. When `writeEpisode` is true and
   * the verdict has a meaningful reason, also writes a `memory_episodes` row
   * so the lesson is durably indexed for Layer 5 retrieval.
   */
  recordVerdict(args: RecordVerdictArgs): VerdictRecord {
    // 1. Write evaluator example (Layer 4 calibration set).
    const exampleId = this.examples.write({
      workspaceId: args.workspaceId,
      appId: args.appId,
      evaluatorKey: args.evaluatorKey,
      source: 'operator',
      input: args.input,
      expected: args.expected,
      verdict: args.verdict,
      score: args.score,
      reason: args.reason,
      originRunId: args.runId,
    });

    // Re-fetch so we return the full persisted shape.
    const allExamples = this.examples.list({
      workspaceId: args.workspaceId,
      appId: args.appId,
      evaluatorKey: args.evaluatorKey,
      limit: 1,
    });
    const example = allExamples.find((e) => e.id === exampleId) ?? allExamples[0]!;

    // 2. Optionally write a runtime episode (Layer 3 lesson).
    let episode: RuntimeEpisode | undefined;
    if (args.writeEpisode && args.reason && args.reason.length >= 20) {
      try {
        episode = this.episodes.write({
          workspaceId: args.workspaceId,
          appId: args.appId,
          runId: args.runId ?? null,
          type: args.verdict === 'fail' ? 'evaluator_outcome' : 'evaluator_outcome',
          title: `${args.evaluatorKey}: ${args.verdict}${args.score !== undefined ? ` (score ${args.score.toFixed(2)})` : ''}`,
          summary: args.reason,
          source: 'evaluator_write',
          confidence: args.score ?? (args.verdict === 'pass' ? 0.8 : 0.6),
          importance: args.verdict === 'fail' ? 0.75 : 0.5,
          trust: 0.85, // evaluator verdicts are high-trust (§11.2)
          outcomeStatus: args.verdict === 'pass' ? 'good' : 'bad',
          tags: ['evaluator', args.evaluatorKey, args.verdict],
          entities: [args.evaluatorKey],
          metadata: {
            evaluatorKey: args.evaluatorKey,
            verdict: args.verdict,
            score: args.score,
          },
        });
      } catch (err) {
        this.logger.warn('evaluator_memory.episode_write_failed', {
          evaluatorKey: args.evaluatorKey,
          error: (err as Error).message,
        });
      }
    }

    return { example, episode };
  }

  /**
   * List recent examples for an evaluator key.
   *
   * Thin delegation to `EvaluatorExampleStore.list()` for callers that only
   * need the example calibration set and don't need the full store interface.
   */
  list(args: {
    workspaceId: string;
    appId: string;
    evaluatorKey: string;
    limit?: number;
  }): EvaluatorExample[] {
    return this.examples.list(args);
  }
}
