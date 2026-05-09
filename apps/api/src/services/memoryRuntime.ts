/**
 * MemoryRuntime — the unified `IMemoryRuntime` facade.
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md §15.
 *
 * One service. One contract. The agent runtime, the policy engine, the
 * evaluator runtime, and the routes all consume Memory through this facade
 * — they never reach into individual layer stores directly.
 *
 * The facade is intentionally thin: most logic lives in the layer stores
 * (KnowledgeStore, EpisodicMemoryStore, …) and in `MemoryRetrieval` for
 * cross-layer composition. This file is the front door.
 */

import {
  type CreateRuntimeEpisodeInput,
  type EvaluatorExample,
  type InjectedMemoryContext,
  type KnowledgeHit,
  type PromotionCandidate,
  type RetrievalParams,
  type RuntimeEpisode,
  type WorkflowBaselineSnapshot,
  type WorkingMemoryNamespace,
  type WorkingMemoryKind,
  type WorkingMemorySummary,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { KnowledgeStore } from './knowledgeStore.js';
import type { EpisodicMemoryStore } from './episodicMemoryStore.js';
import type { EvaluatorExampleStore } from './evaluatorExampleStore.js';
import type { WorkflowBaselineStore } from './workflowBaselineStore.js';
import type { RollingBaselineStore } from './rollingBaselineStore.js';
import type { WorkingMemoryCompactor } from './workingMemoryCompactor.js';
import type { MemoryRetrieval } from './memoryRetrieval.js';
import type { MemoryPromotion } from './memoryPromotion.js';
import {
  computeConfidence,
  computeImportance,
  computeTrust,
} from './memoryTrust.js';

/**
 * Input for `writeEvaluatorExample()` — operator/system/agent flag affects trust.
 */
export interface CreateEvaluatorExampleInput {
  workspaceId: string;
  appId: string;
  evaluatorKey: string;
  input: unknown;
  expected: unknown;
  verdict: 'pass' | 'fail';
  reason?: string;
  /** 0..1. Defaults vary by source. */
  confidence?: number;
  /** Originating run, if any. */
  sourceRunId?: string;
  source?: 'seed' | 'import' | 'operator' | 'promotion';
  metadata?: Record<string, unknown>;
}

/**
 * The unified memory runtime. Every consumer should depend on this interface
 * rather than on individual layer stores.
 */
export interface IMemoryRuntime {
  // ── Layer 1: Working memory ─────────────────────────────
  readWorking<T = unknown>(runId: string, namespace: WorkingMemoryNamespace, kind: WorkingMemoryKind, key: string): T | null;
  writeWorking<T = unknown>(runId: string, namespace: WorkingMemoryNamespace, kind: WorkingMemoryKind, key: string, payload: T): void;
  summarizeWorking(runId: string): WorkingMemorySummary;
  compactWorking(runId: string): WorkingMemorySummary;
  disposeWorking(runId: string, opts?: { durable?: boolean }): void;

  // ── Layer 2: Knowledge ──────────────────────────────────
  searchKnowledge(params: {
    workspaceId: string;
    appId: string;
    query: string;
    topK?: number;
    mode?: 'lexical' | 'semantic' | 'hybrid';
  }): KnowledgeHit[];

  // ── Layer 3: Episodes ───────────────────────────────────
  writeEpisode(input: CreateRuntimeEpisodeInput): RuntimeEpisode;
  searchEpisodes(params: {
    workspaceId: string;
    appId?: string;
    query: string;
    topK?: number;
  }): RuntimeEpisode[];

  // ── Layer 4: Evaluator + Baselines ──────────────────────
  writeEvaluatorExample(input: CreateEvaluatorExampleInput): EvaluatorExample;
  getBaselines(workspaceId: string, workflowId: string, appId?: string): WorkflowBaselineSnapshot[];

  // ── Layer 5: Composed retrieval ─────────────────────────
  buildContext(params: RetrievalParams): InjectedMemoryContext;

  // ── Promotion ───────────────────────────────────────────
  promoteFromRun(args: {
    workspaceId: string;
    runId: string;
    appId?: string | null;
    workflowId?: string | null;
    candidates: PromotionCandidate[];
  }): { promoted: number; merged: number; superseded: number; rejected: number };
}

export class MemoryRuntime implements IMemoryRuntime {
  constructor(
    private readonly knowledge: KnowledgeStore,
    private readonly episodes: EpisodicMemoryStore,
    private readonly evaluators: EvaluatorExampleStore,
    private readonly baselines: WorkflowBaselineStore,
    private readonly rollingBaselines: RollingBaselineStore,
    private readonly compactor: WorkingMemoryCompactor,
    private readonly retrieval: MemoryRetrieval,
    private readonly promotion: MemoryPromotion,
    private readonly logger: Logger,
  ) {
    void this.rollingBaselines;
    void this.logger;
  }

  // ── Layer 1: Working memory ─────────────────────────────
  readWorking<T = unknown>(runId: string, namespace: WorkingMemoryNamespace, kind: WorkingMemoryKind, key: string): T | null {
    return this.compactor.read<T>(runId, namespace, kind, key);
  }

  writeWorking<T = unknown>(runId: string, namespace: WorkingMemoryNamespace, kind: WorkingMemoryKind, key: string, payload: T): void {
    this.compactor.write<T>(runId, namespace, kind, key, payload);
  }

  summarizeWorking(runId: string): WorkingMemorySummary {
    return this.compactor.summarize(runId);
  }

  compactWorking(runId: string): WorkingMemorySummary {
    return this.compactor.compact(runId);
  }

  disposeWorking(runId: string, opts?: { durable?: boolean }): void {
    this.compactor.dispose(runId, opts);
  }

  // ── Layer 2: Knowledge ──────────────────────────────────
  searchKnowledge(params: {
    workspaceId: string;
    appId: string;
    query: string;
    topK?: number;
    mode?: 'lexical' | 'semantic' | 'hybrid';
  }): KnowledgeHit[] {
    return this.retrieval.searchKnowledge(params);
  }

  // ── Layer 3: Episodes ───────────────────────────────────
  writeEpisode(input: CreateRuntimeEpisodeInput): RuntimeEpisode {
    return this.episodes.write(input);
  }

  searchEpisodes(params: {
    workspaceId: string;
    appId?: string;
    query: string;
    topK?: number;
  }): RuntimeEpisode[] {
    return this.retrieval.searchEpisodes(params);
  }

  // ── Layer 4: Evaluator + Baselines ──────────────────────
  /**
   * Write an evaluator example with trust scoring.
   *
   * Trust is derived from `source` per the rules in MemoryTrust:
   *   operator → 0.95, evaluator-validated → 0.85, repeated → 0.7+, agent → 0.4
   *
   * `confidence` here is also normalised (clamp + default).
   */
  writeEvaluatorExample(input: CreateEvaluatorExampleInput): EvaluatorExample {
    const source = input.source ?? 'operator';
    const trust = computeTrust(
      source === 'operator' ? 'operator_write'
      : source === 'promotion' ? 'evaluator_write'
      : source === 'seed' ? 'system_write'
      : 'system_write',
      {},
    );
    const confidence = input.confidence !== undefined
      ? clamp01(input.confidence)
      : computeConfidence(source === 'operator' ? 'operator_write' : 'evaluator_write', {});

    void computeImportance;

    const writeArgs: Parameters<typeof this.evaluators.write>[0] = {
      workspaceId: input.workspaceId,
      appId: input.appId,
      evaluatorKey: input.evaluatorKey,
      source,
      input: input.input,
      expected: input.expected,
      verdict: input.verdict,
      score: confidence,
    };
    if (input.reason !== undefined) writeArgs.reason = input.reason;
    if (input.sourceRunId !== undefined) writeArgs.originRunId = input.sourceRunId;
    const id = this.evaluators.write(writeArgs);

    void trust; // trust is reserved for future fields on evaluator examples

    // Re-fetch the persisted example.
    const examples = this.evaluators.list({
      workspaceId: input.workspaceId,
      appId: input.appId,
      evaluatorKey: input.evaluatorKey,
      limit: 1,
    });
    const persisted = examples.find((e) => e.id === id) ?? examples[0];
    if (!persisted) {
      // Synthesise — should never happen, but the type forces a return.
      return {
        id,
        workspaceId: input.workspaceId,
        appId: input.appId,
        evaluatorKey: input.evaluatorKey,
        source,
        input: input.input,
        expected: input.expected,
        verdict: input.verdict,
        score: confidence,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.sourceRunId !== undefined ? { originRunId: input.sourceRunId } : {}),
        createdAt: new Date().toISOString(),
      };
    }
    return persisted;
  }

  getBaselines(workspaceId: string, workflowId: string, appId?: string): WorkflowBaselineSnapshot[] {
    if (appId) {
      const single = this.baselines.latest(workspaceId, appId, workflowId);
      return single ? [single] : [];
    }
    // No appId — fall back to scanning all app baselines that match this workflow.
    // This is a coarse scan; baselines are workspace-scoped via app_id, so we
    // can't query workflow_id in isolation. Return empty for now and let the
    // caller scope by app.
    return [];
  }

  // ── Layer 5: Composed retrieval ─────────────────────────
  buildContext(params: RetrievalParams): InjectedMemoryContext {
    return this.retrieval.buildContext(params);
  }

  // ── Promotion ───────────────────────────────────────────
  promoteFromRun(args: {
    workspaceId: string;
    runId: string;
    appId?: string | null;
    workflowId?: string | null;
    candidates: PromotionCandidate[];
  }): { promoted: number; merged: number; superseded: number; rejected: number } {
    const result = this.promotion.promoteFromRun(args);
    return {
      promoted: result.promoted,
      merged: result.merged,
      superseded: result.superseded,
      rejected: result.rejected,
    };
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
