/**
 * BrainComposer — composes a `BrainResponse` from the wedge + memory stores.
 *
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
import type { Logger } from '../../logger.js';
import type { KnowledgeStore } from '../knowledge/knowledgeStore.js';
import type { MemoryStore } from '../memory/memoryStore.js';
import type { EvaluatorExampleStore } from '../evaluatorExampleStore.js';
import type { WorkflowBaselineStore } from '../workflow/workflowBaselineStore.js';
import type { IntelligencePromotion } from '../intelligencePromotion.js';
import type { DatasetIngestion } from '../datasetIngestion.js';
import type { EpisodicMemoryStore } from '../episodicMemoryStore.js';

export class BrainComposer {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly knowledge: KnowledgeStore,
    private readonly workspaceMemory: MemoryStore,
    private readonly evaluators: EvaluatorExampleStore,
    private readonly baselines: WorkflowBaselineStore,
    private readonly promotion: IntelligencePromotion,
    private readonly ingestion: DatasetIngestion,
    private readonly episodes: EpisodicMemoryStore,
    private readonly logger: Logger,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  // Workspace Brain composition
  // ──────────────────────────────────────────────────────────────────────


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
      const k = this.knowledge.countByScope(workspaceId, pkg.id);
      const m = this.workspaceMemory.countByScope(workspaceId, pkg.id);
      const evals = this.evaluators.confidenceForScope(workspaceId, pkg.id);
      const baselines = this.baselines.latestForScope(workspaceId, pkg.id);
      const promoted = this.promotion.countByScope(workspaceId, pkg.id);
      const baselineConfidence = computeBaselineConfidence(baselines);
      if (baselineConfidence !== null) baselineConfidences.push(baselineConfidence);

      totalKnowledge += k.total;
      totalMemory += m.total + promoted;
      totalEvaluators += evals.reduce((s, e) => s + e.exampleCount, 0);

      // One macro-cluster per installed package, in the knowledge stratum.
      const id = `pkg:${pkg.id}`;
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
          scopeId: pkg.id,
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
        id: 'gap:no-packages',
        label: 'No packages installed',
        reason: 'Install a package from the registry to start building intelligence.',
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
      description: `${pkgs.length} package${pkgs.length === 1 ? '' : 's'} · ${totalKnowledge} knowledge · ${totalMemory} memory`,
      weight: 1,
      status: 'ok',
      x: 0, y: 0,
      metadata: {
        packageCount: pkgs.length,
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
        packageCount: pkgs.length,
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

