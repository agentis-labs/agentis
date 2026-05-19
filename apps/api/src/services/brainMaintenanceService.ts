import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { BrainCompressionService, BrainCompressionSettings } from './brainCompressionService.js';
import type { SessionAtomService } from './sessionAtomService.js';

export interface BrainMaintenanceResult {
  workspaceId: string;
  staleMarked: number;
  archived: number;
  linksPruned: number;
  sessionAtomsExpired: number;
  compression: ReturnType<BrainCompressionService['run']>;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class BrainMaintenanceService {
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    private readonly compression: BrainCompressionService,
    private readonly sessionAtoms: SessionAtomService,
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

    const compression = this.compression.run(workspaceId, settings);
    const linksPruned = this.#pruneLinks(workspaceId);
    const sessionAtomsExpired = this.sessionAtoms.sweepExpired(now);

    const result: BrainMaintenanceResult = {
      workspaceId,
      staleMarked,
      archived,
      linksPruned,
      sessionAtomsExpired,
      compression,
    };
    this.#record(workspaceId, result);
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_MAINTENANCE_COMPLETED, result);
    return result;
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
      appId: null,
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
        compression: result.compression,
        nextTriggerAt: new Date(Date.now() + WEEK_MS).toISOString(),
      },
      createdAt: new Date().toISOString(),
    }).run();
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
