/**
 * AppActivation — orchestrates "seeds → runtime stores" on package install.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §5 + §11.
 *
 * When an app package is installed (`/v1/packages/install-local` or
 * `/v1/skills/registry/install/:slug`), this service is the single entry
 * point that:
 *
 *   1. Wipes the previous seeded intelligence for that app id
 *      (re-install replaces seeds, but never operator/promotion data).
 *   2. Writes knowledge seeds   → `knowledge_chunks`  (source: 'seed')
 *   3. Writes memory seeds      → `app_memory`        (source: 'seed')
 *   4. Writes evaluator rubrics → `app_evaluator_examples` (source: 'seed')
 *   5. Writes evaluator example seeds (top-level) → same table
 *   6. Writes baseline seeds    → `workflow_baselines` (source: 'seed')
 *   7. Returns an `AppActivationResult` summarising what was created.
 *
 * Invariants:
 *   - Operator-edited memory and promoted patterns are NEVER deleted by
 *     activation. They survive package upgrades.
 *   - Imported dataset chunks (`source: 'import'`) are NEVER deleted by
 *     activation. They survive package upgrades.
 *   - Activation is idempotent: running it twice with the same package
 *     content yields the same store state.
 */

import type {
  AppActivationResult,
  AgentisPackageContents,
  KnowledgeSeed,
  MemorySeed,
  EvaluatorRubric,
  EvaluatorExampleSeed,
  WorkflowBaselineSeed,
  RuntimeEpisodeSeed,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { KnowledgeStore } from './knowledgeStore.js';
import type { AppMemoryStore } from './appMemoryStore.js';
import type { EvaluatorExampleStore } from './evaluatorExampleStore.js';
import type { WorkflowBaselineStore } from './workflowBaselineStore.js';
import type { EpisodicMemoryStore } from './episodicMemoryStore.js';

export interface ActivateAppArgs {
  workspaceId: string;
  appId: string;
  packageVersion?: string;
  contents: Partial<AgentisPackageContents> & { runtimeEpisodeSeeds?: RuntimeEpisodeSeed[] };
  /**
   * Map of `workflowSlug` → workflow id (resolved by the install path before
   * calling activation). Without this, baselines cannot be tied to a real
   * workflow row, so we skip those entries.
   */
  workflowSlugToId?: Record<string, string>;
}

export interface AppActivationResultWithEpisodes extends AppActivationResult {
  /** Number of runtime episodes seeded (Memory OS §13.2). 0 if memory not wired. */
  runtimeEpisodesCreated: number;
}

export class AppActivation {
  constructor(
    private readonly knowledge: KnowledgeStore,
    private readonly memory: AppMemoryStore,
    private readonly evaluators: EvaluatorExampleStore,
    private readonly baselines: WorkflowBaselineStore,
    private readonly logger: Logger,
    /** Optional — when wired, runtime episode seeds are also activated. */
    private readonly episodes?: EpisodicMemoryStore,
  ) {}

  /**
   * Activate (or re-activate) an app. Returns counts of created intelligence.
   *
   * The wipe step targets ONLY the `seed` source so operator and promoted
   * intelligence is preserved. This makes activation safe to re-run on
   * package upgrades.
   */
  activate(args: ActivateAppArgs): AppActivationResultWithEpisodes {
    const { workspaceId, appId } = args;
    const c = args.contents ?? {};

    this.knowledge.deleteForApp(workspaceId, appId, 'seed');
    this.memory.deleteForApp(workspaceId, appId, 'seed');
    this.evaluators.deleteForApp(workspaceId, appId, 'seed');
    this.baselines.deleteForApp(workspaceId, appId, 'seed');

    const knowledgeChunksCreated = this.#seedKnowledge(
      workspaceId,
      appId,
      c.knowledgeSeeds ?? [],
      args.packageVersion,
    );
    const memoryEpisodesCreated = this.#seedMemory(
      workspaceId,
      appId,
      c.memorySeeds ?? [],
      args.packageVersion,
    );
    const evaluatorExamplesCreated =
      this.#seedRubrics(workspaceId, appId, c.evaluatorRubrics ?? [], args.packageVersion) +
      this.#seedExampleSeeds(
        workspaceId,
        appId,
        c.evaluatorExampleSeeds ?? [],
        args.packageVersion,
      );
    const workflowBaselinesCreated = this.#seedBaselines(
      workspaceId,
      appId,
      c.workflowBaselines ?? [],
      args.workflowSlugToId ?? {},
      args.packageVersion,
    );

    // Memory Architecture episode seeds (Memory OS §13.2).
    let runtimeEpisodesCreated = 0;
    if (this.episodes && c.runtimeEpisodeSeeds && c.runtimeEpisodeSeeds.length > 0) {
      runtimeEpisodesCreated = this.#seedRuntimeEpisodes(
        workspaceId,
        appId,
        c.runtimeEpisodeSeeds,
        args.packageVersion,
      );
    }

    this.logger.info('app.activation.complete', {
      workspaceId,
      appId,
      packageVersion: args.packageVersion ?? null,
      knowledgeChunksCreated,
      memoryEpisodesCreated,
      evaluatorExamplesCreated,
      workflowBaselinesCreated,
      runtimeEpisodesCreated,
    });

    return {
      appId,
      knowledgeChunksCreated,
      memoryEpisodesCreated,
      evaluatorExamplesCreated,
      workflowBaselinesCreated,
      runtimeEpisodesCreated,
    };
  }

  /**
   * Detach all seeded intelligence for an app — used on uninstall. Operator
   * edits and promoted patterns are NOT touched (they get cleaned up on
   * explicit app delete).
   */
  detachSeeds(workspaceId: string, appId: string): void {
    this.knowledge.deleteForApp(workspaceId, appId, 'seed');
    this.memory.deleteForApp(workspaceId, appId, 'seed');
    this.evaluators.deleteForApp(workspaceId, appId, 'seed');
    this.baselines.deleteForApp(workspaceId, appId, 'seed');
    // Also wipe seeded runtime episodes; promoted/operator/agent-written
    // episodes survive package upgrades (§7.7 retention rule).
    if (this.episodes) {
      this.episodes.deleteForApp(workspaceId, appId, 'seed');
    }
  }

  // ────────────────────────────────────────────────────────────
  // Internals — one method per intelligence class
  // ────────────────────────────────────────────────────────────

  #seedKnowledge(
    workspaceId: string,
    appId: string,
    seeds: KnowledgeSeed[],
    packageVersion?: string,
  ): number {
    let count = 0;
    for (const s of seeds) {
      // Long seeds are split into paragraphs so retrieval can score them
      // individually. Short seeds stay as one chunk. The author's `title`
      // is preserved as a prefix so chunks remain attributable.
      const paragraphs = splitIntoParagraphs(s.content);
      if (paragraphs.length <= 1) {
        this.knowledge.write({
          workspaceId,
          appId,
          title: s.title,
          content: s.content,
          source: 'seed',
          tags: s.tags,
          provenance: {
            kind: 'knowledge_seed',
            packageVersion: packageVersion ?? null,
            ...(s.metadata ?? {}),
          },
        });
        count += 1;
      } else {
        for (let i = 0; i < paragraphs.length; i++) {
          this.knowledge.write({
            workspaceId,
            appId,
            title: paragraphs.length > 1 ? `${s.title} (part ${i + 1})` : s.title,
            content: paragraphs[i]!,
            source: 'seed',
            tags: s.tags,
            provenance: {
              kind: 'knowledge_seed',
              packageVersion: packageVersion ?? null,
              chunkIndex: i,
              chunkCount: paragraphs.length,
              ...(s.metadata ?? {}),
            },
          });
          count += 1;
        }
      }
    }
    return count;
  }

  #seedMemory(
    workspaceId: string,
    appId: string,
    seeds: MemorySeed[],
    packageVersion?: string,
  ): number {
    let count = 0;
    for (const s of seeds) {
      // Memory seeds default to kind:'fact' unless metadata.kind overrides.
      // The provenance field carries the package version so the UI can group
      // "memory loaded by app vX" cleanly.
      const kind = (s.metadata?.kind as MemorySeed['title']) ?? 'fact';
      this.memory.write({
        workspaceId,
        appId,
        kind: ['fact', 'preference', 'pattern', 'rule', 'lesson'].includes(kind as string)
          ? (kind as 'fact')
          : 'fact',
        source: 'seed',
        title: s.title,
        content: s.content,
        trust: s.trust,
        importance: s.importance,
        tags: s.tags,
        provenance: {
          kind: 'memory_seed',
          packageVersion: packageVersion ?? null,
          ...(s.metadata ?? {}),
        },
      });
      count += 1;
    }
    return count;
  }

  #seedRubrics(
    workspaceId: string,
    appId: string,
    rubrics: EvaluatorRubric[],
    packageVersion?: string,
  ): number {
    let count = 0;
    for (const rubric of rubrics) {
      // Rubric.evaluatorKey is taken from `nodeKind` for V1 — the rubric
      // applies to a node kind, and that's the evaluator key used at runtime.
      const evaluatorKey = rubric.nodeKind;
      for (const ex of rubric.examples) {
        this.evaluators.write({
          workspaceId,
          appId,
          evaluatorKey,
          source: 'seed',
          input: ex.input,
          expected: ex.expected,
          verdict: ex.verdict,
          score: ex.score,
          reason: ex.reason,
        });
        count += 1;
      }
    }
    void packageVersion; // logged via parent, individual examples don't carry version
    return count;
  }

  #seedExampleSeeds(
    workspaceId: string,
    appId: string,
    seeds: EvaluatorExampleSeed[],
    packageVersion?: string,
  ): number {
    let count = 0;
    for (const s of seeds) {
      this.evaluators.write({
        workspaceId,
        appId,
        evaluatorKey: s.evaluatorKey,
        source: 'seed',
        input: s.input,
        expected: s.expected,
        verdict: s.verdict,
        score: s.score,
        reason: s.reason,
      });
      count += 1;
    }
    void packageVersion;
    return count;
  }

  #seedBaselines(
    workspaceId: string,
    appId: string,
    seeds: WorkflowBaselineSeed[],
    slugToId: Record<string, string>,
    packageVersion?: string,
  ): number {
    let count = 0;
    for (const s of seeds) {
      const workflowId = slugToId[s.workflowSlug];
      if (!workflowId) {
        this.logger.warn('app.activation.baseline_slug_unresolved', {
          workspaceId,
          appId,
          slug: s.workflowSlug,
        });
        continue;
      }
      this.baselines.write({
        workspaceId,
        appId,
        workflowId,
        source: 'seed',
        p50DurationMs: s.p50DurationMs,
        p95DurationMs: s.p95DurationMs,
        successRate: s.expectedSuccessRate,
        costCentsPerRun: s.costCentsPerRun,
        sampleSize: s.derivedFromRuns ?? 0,
      });
      count += 1;
    }
    void packageVersion;
    return count;
  }

  /**
   * Seed runtime episodes (Memory OS §13.2).
   *
   * These go into `memory_episodes` (not `app_memory`). Episodes are richer
   * than typed knowledge — they capture lessons, decisions, and patterns
   * derived from execution.
   */
  #seedRuntimeEpisodes(
    workspaceId: string,
    appId: string,
    seeds: RuntimeEpisodeSeed[],
    packageVersion?: string,
  ): number {
    if (!this.episodes) return 0;
    let count = 0;
    for (const s of seeds) {
      this.episodes.write({
        workspaceId,
        appId,
        type: s.type,
        title: s.title,
        summary: s.summary,
        ...(s.details !== undefined ? { details: s.details } : {}),
        source: 'seed',
        ...(s.outcomeStatus !== undefined ? { outcomeStatus: s.outcomeStatus } : {}),
        importance: s.importance ?? 0.6,
        trust: s.trust ?? 0.8,
        confidence: 0.8,
        ...(s.tags !== undefined ? { tags: s.tags } : {}),
        ...(s.entities !== undefined ? { entities: s.entities } : {}),
        metadata: {
          kind: 'runtime_episode_seed',
          packageVersion: packageVersion ?? null,
        },
      });
      count += 1;
    }
    return count;
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Split a long knowledge seed into paragraphs. Paragraphs are double-newline
 * separated; we don't try to be clever — operators can pre-shape their seeds
 * by inserting blank lines between distinct ideas.
 *
 * Single short seeds (≤ 600 chars) stay as one chunk regardless of their
 * paragraph layout.
 */
function splitIntoParagraphs(content: string): string[] {
  if (!content) return [];
  if (content.length <= 600) return [content];
  const parts = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : [content];
}
