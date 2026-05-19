import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import { cosineSimilarity } from './embeddingProvider.js';
import type { BrainPromotionQueueWorker } from './brainPromotionQueueWorker.js';

export interface BrainCompressionSettings {
  compressionThreshold: number;
  hardCompressionThreshold: number;
  compressionMinConfidence: number;
  clusterSimilarityThreshold: number;
  curatorClusterMinSize: number;
}

export interface BrainCompressionResult {
  activeBefore: number;
  activeAfter: number;
  tier1Archived: number;
  tier2Merged: number;
  tier3Enqueued: number;
}

export class BrainCompressionService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
    private readonly queue?: BrainPromotionQueueWorker | null,
  ) {}

  run(workspaceId: string, inputSettings: Partial<BrainCompressionSettings> = {}): BrainCompressionResult {
    const settings = { ...defaultSettings(), ...inputSettings };
    const before = this.#activeRows(workspaceId);
    if (before.length <= settings.compressionThreshold) {
      return { activeBefore: before.length, activeAfter: before.length, tier1Archived: 0, tier2Merged: 0, tier3Enqueued: 0 };
    }

    const tier1Archived = this.#tier1(workspaceId, settings);
    let current = this.#activeRows(workspaceId);
    let tier2Merged = 0;
    if (current.length > settings.compressionThreshold) {
      tier2Merged = this.#tier2(workspaceId, current, settings);
      current = this.#activeRows(workspaceId);
    }
    const tier3Enqueued = current.length > settings.hardCompressionThreshold
      ? this.#tier3(workspaceId, current, settings)
      : 0;
    const after = this.#activeRows(workspaceId).length;
    this.logger.info('brain_compression.completed', { workspaceId, tier1Archived, tier2Merged, tier3Enqueued, activeBefore: before.length, activeAfter: after });
    return { activeBefore: before.length, activeAfter: after, tier1Archived, tier2Merged, tier3Enqueued };
  }

  #tier1(workspaceId: string, settings: BrainCompressionSettings): number {
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const now = new Date().toISOString();
    let archived = 0;
    for (const row of this.#activeRows(workspaceId)) {
      if (!row.managed || row.pinnedAt) continue;
      const last = Date.parse(row.lastAccessedAt ?? row.updatedAt);
      if (Number(row.confidence) >= settings.compressionMinConfidence || !Number.isFinite(last) || last > cutoff) continue;
      archived += this.db.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, compressionTier: 1, updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, row.id))
        .run().changes;
    }
    return archived;
  }

  #tier2(workspaceId: string, rows: Array<typeof schema.memoryEpisodes.$inferSelect>, settings: BrainCompressionSettings): number {
    const now = new Date().toISOString();
    const candidates = rows
      .filter((row) => row.managed && !row.pinnedAt)
      .map((row) => ({ row, vec: parseEmbedding(row.embedding) }))
      .filter((entry): entry is { row: typeof schema.memoryEpisodes.$inferSelect; vec: number[] } => Boolean(entry.vec));
    const archived = new Set<string>();
    let merged = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const keeper = candidates[i];
      if (!keeper || archived.has(keeper.row.id)) continue;
      const cluster: Array<typeof schema.memoryEpisodes.$inferSelect> = [];
      for (let j = i + 1; j < candidates.length; j += 1) {
        const other = candidates[j];
        if (!other || archived.has(other.row.id)) continue;
        if (keeper.vec.length !== other.vec.length) continue;
        if (cosineSimilarity(keeper.vec, other.vec) >= settings.clusterSimilarityThreshold) {
          cluster.push(other.row);
          archived.add(other.row.id);
        }
      }
      if (cluster.length === 0) continue;
      const compressedFrom = [
        ...parseJsonArray<string>(keeper.row.compressedFrom),
        ...cluster.map((row) => row.id),
      ];
      this.db.update(schema.memoryEpisodes)
        .set({
          compressedFrom,
          compressionTier: 2,
          lastAccessedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.memoryEpisodes.id, keeper.row.id))
        .run();
      for (const row of cluster) {
        this.db.update(schema.memoryEpisodes)
          .set({ status: 'archived', archivedAt: now, compressionTier: 2, updatedAt: now })
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, row.id)))
          .run();
        merged += 1;
      }
    }
    return merged;
  }

  #tier3(workspaceId: string, rows: Array<typeof schema.memoryEpisodes.$inferSelect>, settings: BrainCompressionSettings): number {
    if (!this.queue) return 0;
    const byTag = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.managed || row.pinnedAt) continue;
      for (const tag of parseJsonArray<string>(row.tags)) {
        const bucket = byTag.get(tag) ?? [];
        bucket.push(row.id);
        byTag.set(tag, bucket);
      }
    }
    let enqueued = 0;
    for (const [tag, ids] of byTag) {
      if (ids.length < settings.curatorClusterMinSize) continue;
      this.queue.enqueue({
        workspaceId,
        itemType: 'curator_pass',
        priority: 'low',
        payload: { workspaceId, clusterTag: tag, atomIds: ids.slice(0, 50) },
      });
      enqueued += 1;
    }
    return enqueued;
  }

  #activeRows(workspaceId: string) {
    return this.db.select().from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        or(eq(schema.memoryEpisodes.status, 'active'), eq(schema.memoryEpisodes.status, 'stale'))!,
      ))
      .orderBy(desc(schema.memoryEpisodes.updatedAt))
      .all();
  }
}

function defaultSettings(): BrainCompressionSettings {
  return {
    compressionThreshold: 2000,
    hardCompressionThreshold: 5000,
    compressionMinConfidence: 0.15,
    clusterSimilarityThreshold: 0.92,
    curatorClusterMinSize: 5,
  };
}

function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) return raw as number[];
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) && value.every((n) => typeof n === 'number') ? value as number[] : null;
  } catch {
    return null;
  }
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}
