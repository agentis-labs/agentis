import { randomUUID } from 'node:crypto';
import { and, eq, isNull, like, lt, or, sql } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS, type RuntimeEpisodeType } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { BrainCompressionService, BrainCompressionSettings } from './brainCompressionService.js';
import type { SessionMomentService } from './sessionMomentService.js';
import { coercePacerClass, pacerRouting } from './brainPacer.js';

export interface BrainMaintenanceResult {
  workspaceId: string;
  staleMarked: number;
  archived: number;
  linksPruned: number;
  sessionAtomsExpired: number;
  /**
   * Staged traces that proved useful (retrieved/reinforced) and were promoted to
   * consolidated durable memory before they could expire (§Phase 3).
   */
  stagedGraduated: number;
  /** Unconsolidated episodic traces past their TTL that were archived (§P2). */
  stagedExpired: number;
  compression: ReturnType<BrainCompressionService['run']>;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many times a staged trace must be retrieved into a dispatch context (or be
 * reinforced once) before it graduates to durable memory. This is the practical
 * "lazy summarization" rule: consolidate because it keeps proving useful, not
 * because it was stored.
 */
const GRADUATE_MIN_RETRIEVALS = 2;

export class BrainMaintenanceService {
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly compression: BrainCompressionService,
    private readonly sessionAtoms: SessionMomentService,
    /**
     * §B1.4 — incremental re-embed sweep. Fire-and-forget hook (decoupled from
     * SharedIntelligence to avoid a type cycle): repairs episodes whose stored
     * vector drifted from the workspace provider, so the store converges and
     * STAYS converged instead of re-polluting after a one-shot migration.
     */
    private readonly reembedPending?: (workspaceId: string) => Promise<unknown>,
    /**
     * §C1 — schedule a cross-session memory reflection pass for the workspace
     * (fire-and-forget enqueue). Off the hot path; the maintenance cadence is the
     * "dreaming" trigger.
     */
    private readonly scheduleReflection?: (workspaceId: string) => void,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.runAll(), WEEK_MS);
    this.#timer.unref?.();
    this.logger.info('brain_maintenance.started', { intervalMs: WEEK_MS });
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  runAll(): BrainMaintenanceResult[] {
    return this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).all()
      .map((workspace) => this.runWorkspace(workspace.id));
  }

  runWorkspace(workspaceId: string): BrainMaintenanceResult {
    const settings = this.#settings(workspaceId);
    const now = new Date().toISOString();
    const staleCutoff = new Date(Date.now() - settings.staleAfterDays * 24 * 60 * 60 * 1000).toISOString();
    const archiveCutoff = new Date(Date.now() - settings.archiveAfterDays * 24 * 60 * 60 * 1000).toISOString();

    const staleMarked = this.db.update(schema.memoryEpisodes)
      .set({ status: 'stale', updatedAt: now })
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        eq(schema.memoryEpisodes.status, 'active'),
        eq(schema.memoryEpisodes.managed, true),
        isNull(schema.memoryEpisodes.pinnedAt),
        or(lt(schema.memoryEpisodes.lastAccessedAt, staleCutoff), lt(schema.memoryEpisodes.updatedAt, staleCutoff))!,
      ))
      .run().changes;

    const archived = this.db.update(schema.memoryEpisodes)
      .set({ status: 'archived', archivedAt: now, updatedAt: now })
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        eq(schema.memoryEpisodes.status, 'stale'),
        eq(schema.memoryEpisodes.managed, true),
        isNull(schema.memoryEpisodes.pinnedAt),
        lt(schema.memoryEpisodes.updatedAt, archiveCutoff),
      ))
      .run().changes;

    // Phase 3: graduate proven-useful staged traces BEFORE expiry so a
    // procedural/conceptual lesson that keeps getting retrieved is consolidated
    // instead of forgotten.
    const stagedGraduated = this.#graduateStagedTraces(workspaceId, now);
    const stagedExpired = this.#expireStagedTraces(workspaceId, now);
    const compression = this.compression.run(workspaceId, settings);
    const linksPruned = this.#pruneLinks(workspaceId);
    const sessionAtomsExpired = this.sessionAtoms.sweepExpired(now);

    // §B1.4 — repair drifted vectors off the hot path (fire-and-forget).
    if (this.reembedPending) {
      void this.reembedPending(workspaceId).catch((err) =>
        this.logger.warn('brain_maintenance.reembed_failed', { workspaceId, message: (err as Error).message }),
      );
    }
    // §C1 — schedule the cross-session reflection ("dreaming") pass.
    try { this.scheduleReflection?.(workspaceId); } catch { /* never break maintenance */ }

    const result: BrainMaintenanceResult = {
      workspaceId,
      staleMarked,
      archived,
      linksPruned,
      sessionAtomsExpired,
      stagedGraduated,
      stagedExpired,
      compression,
    };
    this.#record(workspaceId, result);
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_MAINTENANCE_COMPLETED, result);
    return result;
  }

  /**
   * §Phase 3 — usefulness-driven consolidation. A staged (unconsolidated) trace
   * of a DURABLE PACER class (procedural/conceptual/reference) that has been
   * retrieved into dispatch ≥ GRADUATE_MIN_RETRIEVALS times (or reinforced once)
   * is promoted to consolidated memory: its decay-eligible tag is dropped, its
   * type is upgraded, and confidence is bumped. Evidence/analogical traces never
   * graduate this way — they stay cold and expire on TTL.
   */
  #graduateStagedTraces(workspaceId: string, now: string): number {
    const rows = this.db.select()
      .from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        like(schema.memoryEpisodes.tags, '%unconsolidated%'),
      ))
      .all();
    let graduated = 0;
    for (const row of rows) {
      if (row.status === 'archived') continue;
      const meta = parseRecord(row.metadata);
      const pacerClass = coercePacerClass(meta.pacerClass);
      const routing = pacerClass ? pacerRouting(pacerClass) : null;
      // Only durable classes graduate. Evidence/analogical stay cold.
      if (!routing?.decayResistant) continue;

      const retrievals = this.#retrievalCount(workspaceId, row.id);
      const reused = Boolean(row.reinforcedAt) || retrievals >= GRADUATE_MIN_RETRIEVALS;
      if (!reused) continue;

      const tags = parseArray<string>(row.tags)
        .filter((t) => t !== 'unconsolidated')
        .concat('consolidated', 'graduated');
      const nextType: RuntimeEpisodeType = pacerClass === 'procedural'
        ? 'success_pattern'
        : pacerClass === 'conceptual'
          ? 'distilled_lesson'
          : (row.type as RuntimeEpisodeType);
      const nextConfidence = Math.min(0.9, (Number(row.confidence) || 0.3) + 0.25);
      const nextMeta = { ...meta, formationMode: 'graduated', graduatedAt: now, retrievalsAtGraduation: retrievals };
      delete (nextMeta as Record<string, unknown>).ttlExpiresAt;

      this.db.update(schema.memoryEpisodes)
        .set({
          type: nextType,
          tags,
          confidence: String(nextConfidence),
          importance: String(Math.min(0.9, (Number(row.importance) || 0.45) + 0.15)),
          reinforcedAt: now,
          metadata: nextMeta,
          updatedAt: now,
        })
        .where(eq(schema.memoryEpisodes.id, row.id))
        .run();
      this.#recordEvent(workspaceId, row.scopeId ?? null, row.agentId ?? null, 'atom_graduated', row.id, {
        pacerClass,
        retrievals,
        fromType: row.type,
        toType: nextType,
      });
      graduated += 1;
    }
    return graduated;
  }

  /** Count how many times an atom was injected into a dispatch context. */
  #retrievalCount(workspaceId: string, atomId: string): number {
    const row = this.db.select({ count: sql<number>`count(*)` })
      .from(schema.brainQualityEvents)
      .where(and(
        eq(schema.brainQualityEvents.workspaceId, workspaceId),
        eq(schema.brainQualityEvents.atomId, atomId),
        eq(schema.brainQualityEvents.eventType, 'atom_injected'),
      ))
      .get();
    return Number(row?.count) || 0;
  }

  /**
   * Archive unconsolidated episodic traces (staged run output + outcome markers)
   * whose TTL has elapsed without ever being reinforced or graduated. This is
   * "forgetting is a feature" — staged noise must not accumulate forever.
   */
  #expireStagedTraces(workspaceId: string, now: string): number {
    const rows = this.db.select({ id: schema.memoryEpisodes.id, metadata: schema.memoryEpisodes.metadata })
      .from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        isNull(schema.memoryEpisodes.reinforcedAt),
        like(schema.memoryEpisodes.tags, '%unconsolidated%'),
      ))
      .all();
    let expired = 0;
    for (const row of rows) {
      const meta = parseRecord(row.metadata);
      const ttl = typeof meta.ttlExpiresAt === 'string' ? Date.parse(meta.ttlExpiresAt) : NaN;
      if (!Number.isFinite(ttl) || ttl > Date.now()) continue;
      expired += this.db.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, row.id))
        .run().changes;
    }
    return expired;
  }

  #pruneLinks(workspaceId: string): number {
    const links = this.db.select().from(schema.knowledgeLinks)
      .where(eq(schema.knowledgeLinks.workspaceId, workspaceId))
      .all();
    let pruned = 0;
    for (const link of links) {
      const sourceArchived = this.#episodeArchived(workspaceId, link.sourceKind, link.sourceId);
      const targetArchived = this.#episodeArchived(workspaceId, link.targetKind, link.targetId);
      if (!sourceArchived || !targetArchived) continue;
      pruned += this.db.delete(schema.knowledgeLinks).where(eq(schema.knowledgeLinks.id, link.id)).run().changes;
    }
    return pruned;
  }

  #episodeArchived(workspaceId: string, kind: string, id: string): boolean {
    if (kind !== 'episode') return false;
    const row = this.db.select({ status: schema.memoryEpisodes.status, archivedAt: schema.memoryEpisodes.archivedAt })
      .from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
      .get();
    return Boolean(row && (row.status === 'archived' || row.archivedAt));
  }

  #settings(workspaceId: string): BrainCompressionSettings & { staleAfterDays: number; archiveAfterDays: number } {
    const row = this.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const parsed = parseRecord(row?.brainSettings);
    return {
      staleAfterDays: intSetting(parsed.staleAfterDays, 90, 7, 365),
      archiveAfterDays: intSetting(parsed.archiveAfterDays, 180, 14, 730),
      compressionThreshold: intSetting(parsed.compressionThreshold, 2000, 50, 50000),
      hardCompressionThreshold: intSetting(parsed.hardCompressionThreshold, 5000, 100, 100000),
      compressionMinConfidence: numSetting(parsed.compressionMinConfidence, 0.15, 0, 1),
      clusterSimilarityThreshold: numSetting(parsed.clusterSimilarityThreshold, 0.92, 0.5, 1),
      curatorClusterMinSize: intSetting(parsed.curatorClusterMinSize, 5, 2, 100),
    };
  }

  #record(workspaceId: string, result: BrainMaintenanceResult): void {
    this.db.insert(schema.brainQualityEvents).values({
      id: randomUUID(),
      workspaceId,
      scopeId: null,
      agentId: null,
      eventType: 'brain_maintenance_completed',
      atomId: null,
      abilityId: null,
      runId: null,
      delta: null,
      metadata: {
        staleMarked: result.staleMarked,
        atomsArchived: result.archived + result.compression.tier1Archived + result.compression.tier2Merged,
        linksPruned: result.linksPruned,
        sessionAtomsExpired: result.sessionAtomsExpired,
        stagedGraduated: result.stagedGraduated,
        stagedExpired: result.stagedExpired,
        compression: result.compression,
        nextTriggerAt: new Date(Date.now() + WEEK_MS).toISOString(),
      },
      createdAt: new Date().toISOString(),
    }).run();
  }

  #recordEvent(
    workspaceId: string,
    scopeId: string | null,
    agentId: string | null,
    eventType: string,
    atomId: string | null,
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.db.insert(schema.brainQualityEvents).values({
        id: randomUUID(),
        workspaceId,
        scopeId,
        agentId,
        eventType,
        atomId,
        abilityId: null,
        runId: null,
        delta: null,
        metadata,
        createdAt: new Date().toISOString(),
      }).run();
    } catch (err) {
      this.logger.warn('brain_maintenance.event_failed', { workspaceId, eventType, message: (err as Error).message });
    }
  }
}

function parseArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function intSetting(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function numSetting(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
