/**
 * BrainComposer — composes a `BrainResponse` from the wedge + memory stores.
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §16.
 *
 * The Brain is a *composed* product surface. The frontend never reaches into
 * lower-level endpoints to build it (§16.3). Instead this service stitches
 * together knowledge / memory / evaluators / baselines / promoted patterns /
 * dataset jobs, organizes them into the four visible strata
 * (core / knowledge / memory / judgment, §7.2), derives suggested edges, and
 * surfaces warnings + gaps so the UI can be honest about absence (§9 `gap`,
 * §13.1 "do not fake").
 *
 * Phase A constraints (§13.1):
 *   - knowledgeSeeds + datasets + workflowBaselines + evaluatorRubrics +
 *     promoted memories are always shown when present
 *   - dense semantic relationships are NOT invented; edges are derived from
 *     concrete facts (dataset feeds knowledge cluster, evaluator measures
 *     baseline workflow, etc.)
 *   - Gaps surface when recommended datasets are not yet ingested
 */

import { and, eq } from 'drizzle-orm';
import {
  BRAIN_RING_RADIUS,
  type BrainEdge,
  type BrainGap,
  type BrainNode,
  type BrainResponse,
  type BrainStats,
  type BrainWarning,
  type DatasetSpec,
} from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { KnowledgeStore } from './knowledgeStore.js';
import type { AppMemoryStore } from './appMemoryStore.js';
import type { EvaluatorExampleStore } from './evaluatorExampleStore.js';
import type { WorkflowBaselineStore } from './workflowBaselineStore.js';
import type { IntelligencePromotion } from './intelligencePromotion.js';
import type { DatasetIngestion } from './datasetIngestion.js';
import type { EpisodicMemoryStore } from './episodicMemoryStore.js';

export class BrainComposer {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly knowledge: KnowledgeStore,
    private readonly appMemory: AppMemoryStore,
    private readonly evaluators: EvaluatorExampleStore,
    private readonly baselines: WorkflowBaselineStore,
    private readonly promotion: IntelligencePromotion,
    private readonly ingestion: DatasetIngestion,
    private readonly episodes: EpisodicMemoryStore,
    private readonly logger: Logger,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  // App-scoped Brain
  // ──────────────────────────────────────────────────────────────────────

  composeForApp(workspaceId: string, appId: string): BrainResponse {
    const pkg = this.loadPackage(workspaceId, appId);
    const manifest = (pkg?.manifest ?? {}) as Record<string, unknown>;

    // ── Source counts (drives stats + status) ──
    const knowledgeCount = this.knowledge.countByApp(workspaceId, appId);
    const memoryCount = this.appMemory.countByApp(workspaceId, appId);
    const evaluatorConfidences = this.evaluators.confidenceForApp(workspaceId, appId);
    const evaluatorTotal = evaluatorConfidences.reduce((s, e) => s + e.exampleCount, 0);
    const promotedCount = this.promotion.countByApp(workspaceId, appId);
    const baselineRows = this.baselines.latestForApp(workspaceId, appId);
    const baselineConfidence = computeBaselineConfidence(baselineRows);

    // ── Datasets (knowledge stratum) ──
    const datasetSpecs = (manifest.datasetSpecs as DatasetSpec[]) ?? [];
    const knowledgeNodes: BrainNode[] = [];
    const memoryNodes: BrainNode[] = [];
    const judgmentNodes: BrainNode[] = [];
    const edges: BrainEdge[] = [];
    const warnings: BrainWarning[] = [];
    const gaps: BrainGap[] = [];

    let datasetIdx = 0;
    let staleSources = 0;
    const datasetIdByKey = new Map<string, string>();
    for (const spec of datasetSpecs) {
      const jobs = this.ingestion.list({
        workspaceId,
        appId,
        datasetKey: spec.key,
        limit: 1,
      });
      const latest = jobs[0];
      const status = latest?.status ?? 'pending';
      const completed = status === 'completed';
      const freshness = computeDatasetFreshness(latest);
      if (freshness === 'stale') staleSources += 1;

      const id = `dataset:${spec.key}`;
      datasetIdByKey.set(spec.key, id);
      knowledgeNodes.push({
        id,
        type: 'dataset',
        layer: 'knowledge',
        label: spec.label,
        description: spec.wedgeRole,
        weight: completed ? 0.7 : 0.3,
        status: completed ? 'ok' : status === 'failed' ? 'error' : 'inactive',
        freshness,
        ...polarHint('knowledge', datasetIdx, datasetSpecs.length),
        metadata: {
          key: spec.key,
          wedgeRole: spec.wedgeRole,
          status,
          totalItems: latest?.totalItems ?? 0,
          storedItems: latest?.storedItems ?? 0,
          targetStore: spec.targetStore,
          freshnessExpectation: spec.freshnessExpectation ?? null,
        },
      });
      datasetIdx += 1;

      // Recommended-but-missing → gap.
      if (spec.recommended && !completed) {
        gaps.push({
          id: `gap:${spec.key}`,
          label: spec.label,
          reason: `Recommended dataset (${spec.wedgeRole}) — not yet imported.`,
          fillSuggestion: spec.key,
        });
      }

      // Stale-source warning.
      if (freshness === 'stale') {
        warnings.push({
          code: 'STALE_DATASET',
          message: `${spec.label} import is stale beyond freshness expectation.`,
          nodeId: id,
          severity: 'warning',
        });
      }
    }

    // ── Knowledge clusters by source bucket ──
    // Group by `source` bucket (seed/import/promotion) — not by tags. Tags are
    // free-form; bucket counts are the structural "what kind of knowledge"
    // breakdown that matches the wedge architecture.
    const knowledgeClusterIds: string[] = [];
    const sources: Array<{ key: 'seed' | 'import' | 'promotion'; label: string }> = [
      { key: 'seed', label: 'Seed knowledge' },
      { key: 'import', label: 'Imported knowledge' },
      { key: 'promotion', label: 'Promoted knowledge' },
    ];
    sources.forEach((s, i) => {
      const count = knowledgeCount.bySource[s.key] ?? 0;
      if (count === 0) return;
      const id = `cluster:${s.key}`;
      knowledgeClusterIds.push(id);
      knowledgeNodes.push({
        id,
        type: 'knowledge_cluster',
        layer: 'knowledge',
        label: s.label,
        description: `${count} chunk${count === 1 ? '' : 's'}`,
        weight: Math.min(0.95, 0.4 + count / 200),
        status: 'ok',
        ...polarHint('knowledge', datasetIdx + i, datasetIdx + sources.length),
        metadata: { source: s.key, count },
      });

      // Datasets feed import + promotion clusters; seeds have no dataset.
      if (s.key !== 'seed') {
        for (const datasetId of datasetIdByKey.values()) {
          edges.push({
            id: `e:${datasetId}->${id}`,
            source: datasetId,
            target: id,
            kind: 'feeds',
            weight: 0.6,
          });
        }
      }
    });

    if (datasetSpecs.length > 0 && knowledgeNodes.length === datasetSpecs.length) {
      // We have datasets declared but no clusters of any kind → empty knowledge.
      warnings.push({
        code: 'NO_KNOWLEDGE',
        message: 'No knowledge ingested yet — start an import to feed this app.',
        severity: 'info',
      });
    }

    // ── Memory stratum ──
    const promotedPatterns = this.promotion.list({
      workspaceId, appId, limit: 12,
    });
    promotedPatterns.forEach((p, i) => {
      const id = `pattern:${p.id}`;
      memoryNodes.push({
        id,
        type: 'memory_pattern',
        layer: 'memory',
        label: p.title,
        description: p.summary,
        weight: Math.max(0.4, p.confidence),
        confidence: p.confidence,
        trust: p.trust,
        status: 'ok',
        ...polarHint('memory', i, promotedPatterns.length),
        metadata: {
          kind: p.kind,
          evidenceCount: p.evidenceCount,
          reinforcedAt: p.reinforcedAt,
        },
      });
      edges.push({
        id: `e:core->${id}`,
        source: 'core',
        target: id,
        kind: 'derived_from',
        weight: 0.4,
      });
    });

    // Recent runtime episodes (Layer 3) — listed desc by createdAt.
    const recentEpisodes = this.episodes.list({
      workspaceId, appId, limit: 8,
    });
    recentEpisodes.forEach((ep, i) => {
      const id = `episode:${ep.id}`;
      memoryNodes.push({
        id,
        type: 'memory_episode',
        layer: 'memory',
        label: ep.title,
        description: ep.summary,
        weight: 0.4 + (ep.importance ?? 0.5) * 0.4,
        confidence: ep.confidence ?? null,
        trust: ep.trust ?? null,
        status: ep.outcomeStatus === 'bad' ? 'warning' : 'ok',
        ...polarHint('memory', promotedPatterns.length + i, promotedPatterns.length + recentEpisodes.length),
        metadata: {
          episodeType: ep.type,
          outcomeStatus: ep.outcomeStatus,
          tags: ep.tags,
          createdAt: ep.createdAt,
          runId: ep.runId ?? null,
        },
      });
    });

    if (memoryNodes.length === 0) {
      gaps.push({
        id: 'gap:no-memory',
        label: 'No promoted memory yet',
        reason: 'This app has not yet promoted any execution lessons. They accumulate as runs complete.',
      });
    }

    // ── Judgment stratum ──
    evaluatorConfidences.forEach((e, i) => {
      const id = `evaluator:${e.evaluatorKey}`;
      judgmentNodes.push({
        id,
        type: 'evaluator',
        layer: 'judgment',
        label: e.evaluatorKey,
        description: `${e.exampleCount} example${e.exampleCount === 1 ? '' : 's'}`,
        weight: Math.min(0.9, 0.4 + e.exampleCount / 30),
        confidence: e.confidence,
        status: e.confidence < 0.4 ? 'warning' : 'ok',
        ...polarHint('judgment', i, evaluatorConfidences.length + baselineRows.length),
        metadata: {
          evaluatorKey: e.evaluatorKey,
          exampleCount: e.exampleCount,
        },
      });
      if (e.confidence < 0.4) {
        warnings.push({
          code: 'LOW_EVALUATOR_CONFIDENCE',
          message: `Evaluator ${e.evaluatorKey} has low confidence (${(e.confidence * 100).toFixed(0)}%).`,
          nodeId: id,
          severity: 'warning',
        });
      }
    });

    baselineRows.forEach((b, i) => {
      const id = `baseline:${b.workflowId}`;
      judgmentNodes.push({
        id,
        type: 'baseline',
        layer: 'judgment',
        label: b.workflowId.slice(0, 12),
        description: `${b.sampleSize} run${b.sampleSize === 1 ? '' : 's'}`,
        weight: Math.min(0.85, 0.3 + b.sampleSize / 50),
        confidence: 1 - Math.exp(-b.sampleSize / 10),
        status: 'ok',
        ...polarHint('judgment', evaluatorConfidences.length + i, evaluatorConfidences.length + baselineRows.length),
        metadata: {
          workflowId: b.workflowId,
          sampleSize: b.sampleSize,
          successRate: b.successRate ?? null,
          p50DurationMs: b.p50DurationMs ?? null,
          p95DurationMs: b.p95DurationMs ?? null,
          costCentsPerRun: b.costCentsPerRun ?? null,
          windowStart: b.windowStart,
          windowEnd: b.windowEnd,
        },
      });
    });

    if (judgmentNodes.length === 0) {
      gaps.push({
        id: 'gap:no-judgment',
        label: 'No evaluators or baselines',
        reason: 'Add evaluator rubrics + examples to calibrate quality, or wait for baselines to build up from runs.',
      });
    }

    // ── Core ──
    const status = deriveAppStatus({
      knowledgeNodes, memoryNodes, judgmentNodes, warnings,
    });
    const coreNode: BrainNode = {
      id: 'core',
      type: 'core',
      layer: 'core',
      label: pkg?.name ?? appId,
      description: deriveCoreDescription({
        knowledge: knowledgeCount.total,
        memory: memoryCount.total + promotedCount,
        evaluators: evaluatorTotal,
        baselineConfidence,
      }),
      weight: 1,
      status,
      x: 0, y: 0,
      metadata: {
        knowledge: knowledgeCount.total,
        memory: memoryCount.total + promotedCount,
        evaluators: evaluatorTotal,
        baselines: baselineRows.length,
        baselineConfidence,
      },
    };

    // Core ↔ knowledge clusters edges (intelligence flow into the core).
    for (const id of knowledgeClusterIds) {
      edges.push({
        id: `e:${id}->core`,
        source: id,
        target: 'core',
        kind: 'feeds',
        weight: 0.7,
      });
    }
    // Evaluators measure the core (judgment evaluates output quality).
    for (const e of evaluatorConfidences) {
      edges.push({
        id: `e:evaluator:${e.evaluatorKey}->core`,
        source: `evaluator:${e.evaluatorKey}`,
        target: 'core',
        kind: 'evaluates',
        weight: e.confidence,
      });
    }
    // Baselines measure workflows (which fold into the core).
    for (const b of baselineRows) {
      edges.push({
        id: `e:baseline:${b.workflowId}->core`,
        source: `baseline:${b.workflowId}`,
        target: 'core',
        kind: 'measures',
        weight: 0.5,
      });
    }

    const stats: BrainStats = {
      knowledgeNodes: knowledgeNodes.length,
      memoryNodes: memoryNodes.length,
      evaluatorNodes: judgmentNodes.length,
      baselineConfidence,
      staleSources,
    };

    return {
      scope: 'app',
      app: {
        id: appId,
        slug: (manifest.slug as string) ?? appId,
        name: pkg?.name ?? appId,
        status: 'active',
      },
      stats,
      layers: {
        core: [coreNode],
        knowledge: knowledgeNodes,
        memory: memoryNodes,
        judgment: judgmentNodes,
      },
      edges,
      warnings,
      gaps,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Workspace-scoped (Global) Brain
  // ──────────────────────────────────────────────────────────────────────

  composeForWorkspace(workspaceId: string): BrainResponse {
    const pkgs = this.db
      .select()
      .from(schema.agentPackages)
      .where(eq(schema.agentPackages.workspaceId, workspaceId))
      .all();

    const knowledgeNodes: BrainNode[] = [];
    const memoryNodes: BrainNode[] = [];
    const judgmentNodes: BrainNode[] = [];
    const edges: BrainEdge[] = [];
    const warnings: BrainWarning[] = [];
    const gaps: BrainGap[] = [];

    let totalKnowledge = 0;
    let totalMemory = 0;
    let totalEvaluators = 0;
    const baselineConfidences: number[] = [];

    pkgs.forEach((pkg, idx) => {
      const k = this.knowledge.countByApp(workspaceId, pkg.id);
      const m = this.appMemory.countByApp(workspaceId, pkg.id);
      const evals = this.evaluators.confidenceForApp(workspaceId, pkg.id);
      const baselines = this.baselines.latestForApp(workspaceId, pkg.id);
      const promoted = this.promotion.countByApp(workspaceId, pkg.id);
      const baselineConfidence = computeBaselineConfidence(baselines);
      if (baselineConfidence !== null) baselineConfidences.push(baselineConfidence);

      totalKnowledge += k.total;
      totalMemory += m.total + promoted;
      totalEvaluators += evals.reduce((s, e) => s + e.exampleCount, 0);

      // One macro-cluster per app, in the knowledge stratum (apps orbit core).
      const id = `app:${pkg.id}`;
      knowledgeNodes.push({
        id,
        type: 'knowledge_cluster',
        layer: 'knowledge',
        label: pkg.name,
        description: `${k.total} knowledge · ${m.total + promoted} memory · ${evals.length} evaluator${evals.length === 1 ? '' : 's'}`,
        weight: Math.min(1, 0.4 + (k.total + m.total) / 500),
        status: evals.some((e) => e.confidence < 0.4) ? 'warning' : 'ok',
        confidence: baselineConfidence,
        ...polarHint('knowledge', idx, pkgs.length),
        metadata: {
          appId: pkg.id,
          slug: ((pkg.manifest as Record<string, unknown>)?.slug as string) ?? pkg.id,
          knowledge: k.total,
          memory: m.total + promoted,
          evaluators: evals.length,
          baselines: baselines.length,
        },
      });
      edges.push({
        id: `e:${id}->core`,
        source: id,
        target: 'core',
        kind: 'feeds',
        weight: 0.6,
      });
    });

    if (pkgs.length === 0) {
      gaps.push({
        id: 'gap:no-apps',
        label: 'No apps installed',
        reason: 'Install an app from the registry to start building intelligence.',
      });
    }

    const overallBaselineConfidence =
      baselineConfidences.length > 0
        ? baselineConfidences.reduce((s, c) => s + c, 0) / baselineConfidences.length
        : null;

    const coreNode: BrainNode = {
      id: 'core',
      type: 'core',
      layer: 'core',
      label: 'Workspace orchestrator',
      description: `${pkgs.length} app${pkgs.length === 1 ? '' : 's'} · ${totalKnowledge} knowledge · ${totalMemory} memory`,
      weight: 1,
      status: 'ok',
      x: 0, y: 0,
      metadata: {
        appCount: pkgs.length,
        totalKnowledge,
        totalMemory,
        totalEvaluators,
        baselineConfidence: overallBaselineConfidence,
      },
    };

    return {
      scope: 'workspace',
      workspace: {
        id: workspaceId,
        appCount: pkgs.length,
      },
      stats: {
        knowledgeNodes: knowledgeNodes.length,
        memoryNodes: memoryNodes.length,
        evaluatorNodes: judgmentNodes.length,
        baselineConfidence: overallBaselineConfidence,
        staleSources: 0,
      },
      layers: {
        core: [coreNode],
        knowledge: knowledgeNodes,
        memory: memoryNodes,
        judgment: judgmentNodes,
      },
      edges,
      warnings,
      gaps,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // helpers
  // ──────────────────────────────────────────────────────────────────────

  private loadPackage(workspaceId: string, appId: string) {
    return (
      this.db
        .select()
        .from(schema.agentPackages)
        .where(
          and(
            eq(schema.agentPackages.id, appId),
            eq(schema.agentPackages.workspaceId, workspaceId),
          ),
        )
        .get() ?? null
    );
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

function polarHint(
  layer: 'knowledge' | 'memory' | 'judgment',
  index: number,
  count: number,
): { x: number; y: number } {
  if (count <= 0) return { x: 0, y: 0 };
  const radius = BRAIN_RING_RADIUS[layer];
  // Slight offset per ring so equally-spaced rings don't collide visually.
  const offsetByLayer = layer === 'knowledge' ? -Math.PI / 2 : layer === 'memory' ? 0 : Math.PI / 2;
  const theta = offsetByLayer + (index / Math.max(1, count)) * Math.PI * 2;
  return { x: radius * Math.cos(theta), y: radius * Math.sin(theta) };
}

function computeBaselineConfidence(
  baselines: Array<{ sampleSize: number }>,
): number | null {
  if (baselines.length === 0) return null;
  let totalWeight = 0;
  let weighted = 0;
  for (const b of baselines) {
    const w = Math.max(1, b.sampleSize);
    const c = 1 - Math.exp(-b.sampleSize / 10);
    totalWeight += w;
    weighted += w * c;
  }
  return totalWeight > 0 ? weighted / totalWeight : null;
}

function computeDatasetFreshness(
  job: { completedAt?: string | null; status?: string } | undefined,
): 'fresh' | 'aging' | 'stale' | null {
  if (!job || !job.completedAt) return null;
  const ageMs = Date.now() - new Date(job.completedAt).getTime();
  const days = ageMs / (1000 * 60 * 60 * 24);
  if (days < 7) return 'fresh';
  if (days < 30) return 'aging';
  return 'stale';
}

function deriveAppStatus(args: {
  knowledgeNodes: BrainNode[];
  memoryNodes: BrainNode[];
  judgmentNodes: BrainNode[];
  warnings: BrainWarning[];
}): BrainNode['status'] {
  if (args.warnings.some((w) => w.severity === 'error')) return 'error';
  if (args.warnings.some((w) => w.severity === 'warning')) return 'warning';
  if (args.knowledgeNodes.length === 0 && args.memoryNodes.length === 0) return 'inactive';
  return 'ok';
}

function deriveCoreDescription(args: {
  knowledge: number;
  memory: number;
  evaluators: number;
  baselineConfidence: number | null;
}): string {
  const parts: string[] = [];
  parts.push(`${args.knowledge} knowledge`);
  parts.push(`${args.memory} memory`);
  parts.push(`${args.evaluators} evaluator${args.evaluators === 1 ? '' : 's'}`);
  if (args.baselineConfidence !== null) {
    parts.push(`${Math.round(args.baselineConfidence * 100)}% baseline confidence`);
  } else {
    parts.push('no baseline yet');
  }
  return parts.join(' · ');
}
