import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export interface BrainHealthSnapshot {
  healthScore: number;
  metrics: {
    atomCoverageScore: number;
    qualityTrend: 'rising' | 'flat' | 'falling';
    averageConfidenceDelta: number;
    evaluatorSignalRate: number;
    abilityAdoptionRate: number;
    staleAtomCount: number;
    disputedAtomCount: number;
  };
  /** §P4 — memory-formation quality. */
  formation: {
    consolidatedAtoms: number;
    unconsolidatedAtoms: number;
    /** consolidated / (consolidated + unconsolidated); 1 = no raw backlog. */
    formationPrecision: number;
  };
  topAtoms: Array<{ id: string; title: string; content: string; confidence: number; updatedAt: string }>;
  staleAtoms: Array<{ id: string; title: string; content: string; confidence: number; updatedAt: string }>;
  evaluatorSignalsThisWeek: number;
  compressionStatus: { lastRunAt: string | null; atomsArchived: number; nextTriggerAt: string | null };
  intelligence: {
    embeddingProviderType: string;
    degraded: boolean;
    migration: unknown;
  };
  recentActivity: Array<{ id: string; eventType: string; atomId: string | null; abilityId: string | null; delta: number | null; createdAt: string; metadata: unknown }>;
}

export class BrainHealthService {
  constructor(private readonly db: AgentisSqliteDb) {}

  snapshot(workspaceId: string, scopeId?: string | null): BrainHealthSnapshot {
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const events = this.db.select().from(schema.brainQualityEvents)
      .where(and(
        eq(schema.brainQualityEvents.workspaceId, workspaceId),
        gte(schema.brainQualityEvents.createdAt, since30),
      ))
      .orderBy(desc(schema.brainQualityEvents.createdAt))
      .all()
      .filter((event) => !scopeId || event.scopeId === scopeId);

    const runRows = this.db.select({ id: schema.workflowRuns.id }).from(schema.workflowRuns)
      .where(and(
        eq(schema.workflowRuns.workspaceId, workspaceId),
        gte(schema.workflowRuns.createdAt, since30),
        ...(scopeId ? [eq(schema.workflowRuns.workflowId, scopeId)] : []),
      ))
      .all();
    const runCount = Math.max(1, runRows.length);
    const atomInjectedRuns = new Set(events.filter((e) => e.eventType === 'atom_injected' && e.runId).map((e) => e.runId));
    const abilityUsedRuns = new Set(events.filter((e) => e.eventType === 'ability_used' && e.runId).map((e) => e.runId));
    const evaluatorVerdicts = events.filter((e) => e.eventType === 'evaluator_pass' || e.eventType === 'evaluator_fail');
    const deltaEvents = events.filter((e) => e.eventType === 'atom_confidence_delta');
    const avgDelta = deltaEvents.length === 0 ? 0 : deltaEvents.reduce((sum, e) => sum + (e.delta ?? 0), 0) / deltaEvents.length;
    const activeRows = this.db.select().from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        ...(scopeId ? [eq(schema.memoryEpisodes.scopeId, scopeId)] : []),
      ))
      .all()
      .filter((row) => row.status !== 'archived');
    const staleAtomCount = activeRows.filter((row) => row.status === 'stale' || isOlderThan(row.updatedAt, 90)).length;
    const disputedAtomCount = activeRows.filter((row) => row.isDisputed).length;
    const hasTag = (row: typeof activeRows[number], tag: string) => tagList(row.tags).includes(tag);
    const consolidatedAtoms = activeRows.filter((row) => hasTag(row, 'consolidated')).length;
    const unconsolidatedAtoms = activeRows.filter((row) => hasTag(row, 'unconsolidated')).length;
    const formationDenom = consolidatedAtoms + unconsolidatedAtoms;
    const formationPrecision = formationDenom === 0 ? 1 : consolidatedAtoms / formationDenom;
    const topAtoms = activeRows
      .slice()
      .sort((a, b) => Number(b.confidence) - Number(a.confidence))
      .slice(0, 5)
      .map(atomRow);
    const staleAtoms = activeRows
      .filter((row) => row.status === 'stale' || isOlderThan(row.updatedAt, 90))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, 5)
      .map(atomRow);
    const lastMaintenance = this.db.select().from(schema.brainQualityEvents)
      .where(and(eq(schema.brainQualityEvents.workspaceId, workspaceId), eq(schema.brainQualityEvents.eventType, 'brain_maintenance_completed')))
      .orderBy(desc(schema.brainQualityEvents.createdAt))
      .limit(1)
      .get();
    const maintenanceMeta = record(lastMaintenance?.metadata);
    const workspace = this.db.select({
      embeddingProviderType: schema.workspaces.embeddingProviderType,
      brainSettings: schema.workspaces.brainSettings,
    }).from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const workspaceSettings = record(workspace?.brainSettings);
    const atomCoverageScore = atomInjectedRuns.size / runCount;
    const evaluatorSignalRate = evaluatorVerdicts.length === 0 ? 0 : Math.min(1, deltaEvents.length / evaluatorVerdicts.length);
    const abilityAdoptionRate = abilityUsedRuns.size / runCount;
    const healthScore = scoreHealth({
      atomCoverageScore,
      evaluatorSignalRate,
      abilityAdoptionRate,
      staleRatio: activeRows.length === 0 ? 0 : staleAtomCount / activeRows.length,
      disputedAtomCount,
      avgDelta,
    });

    return {
      healthScore,
      metrics: {
        atomCoverageScore,
        qualityTrend: avgDelta > 0.005 ? 'rising' : avgDelta < -0.005 ? 'falling' : 'flat',
        averageConfidenceDelta: avgDelta,
        evaluatorSignalRate,
        abilityAdoptionRate,
        staleAtomCount,
        disputedAtomCount,
      },
      formation: {
        consolidatedAtoms,
        unconsolidatedAtoms,
        formationPrecision,
      },
      topAtoms,
      staleAtoms,
      evaluatorSignalsThisWeek: events.filter((e) => e.createdAt >= since7 && e.eventType === 'atom_confidence_delta').length,
      compressionStatus: {
        lastRunAt: lastMaintenance?.createdAt ?? null,
        atomsArchived: typeof maintenanceMeta.atomsArchived === 'number' ? maintenanceMeta.atomsArchived : 0,
        nextTriggerAt: typeof maintenanceMeta.nextTriggerAt === 'string' ? maintenanceMeta.nextTriggerAt : null,
      },
      intelligence: {
        embeddingProviderType: workspace?.embeddingProviderType ?? 'local',
        degraded: false,
        migration: workspaceSettings.embeddingMigration ?? null,
      },
      recentActivity: events.slice(0, 20).map((event) => ({
        id: event.id,
        eventType: event.eventType,
        atomId: event.atomId,
        abilityId: event.abilityId,
        delta: event.delta,
        createdAt: event.createdAt,
        metadata: event.metadata,
      })),
    };
  }
}

function atomRow(row: typeof schema.memoryEpisodes.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    content: row.summary,
    confidence: Number(row.confidence),
    updatedAt: row.updatedAt,
  };
}

function scoreHealth(input: {
  atomCoverageScore: number;
  evaluatorSignalRate: number;
  abilityAdoptionRate: number;
  staleRatio: number;
  disputedAtomCount: number;
  avgDelta: number;
}): number {
  const base =
    input.atomCoverageScore * 28 +
    input.evaluatorSignalRate * 24 +
    input.abilityAdoptionRate * 20 +
    Math.max(0, 1 - input.staleRatio) * 18 +
    (input.avgDelta >= 0 ? 10 : 3);
  const disputePenalty = Math.min(20, input.disputedAtomCount * 5);
  return Math.max(0, Math.min(100, Math.round(base - disputePenalty)));
}

function tagList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as string[] : [];
  } catch {
    return [];
  }
}

function isOlderThan(iso: string, days: number): boolean {
  const at = Date.parse(iso);
  return Number.isFinite(at) && Date.now() - at > days * 24 * 60 * 60 * 1000;
}

function record(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
