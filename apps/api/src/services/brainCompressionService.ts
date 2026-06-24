import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import { cosineSimilarity } from './embeddingProvider.js';
import type { CognitivePromotionQueueWorker } from './cognitivePromotionQueueWorker.js';
import { coercePacerClass, pacerRouting, type PacerClass } from './brainPacer.js';
import { tokenize } from './brainText.js';

type EpisodeRow = typeof schema.memoryEpisodes.$inferSelect;

/** Resolve the PACER class + routing for an episode row from its metadata. */
function pacerOf(row: EpisodeRow): { cls: PacerClass | null; routing: ReturnType<typeof pacerRouting> } {
  const meta = parseRecord(row.metadata);
  const cls = coercePacerClass(meta.pacerClass);
  return { cls, routing: pacerRouting(cls ?? 'evidence') };
}

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
    private readonly queue?: CognitivePromotionQueueWorker | null,
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
    const softCutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    // PACER (Phase 5): durable classes (procedural/conceptual/reference) get a
    // longer leash before stale-archival and a lower confidence floor — a rarely
    // hit but correct repair rule should not be archived just for sitting idle.
    const hardCutoff = Date.now() - 120 * 24 * 60 * 60 * 1000;
    const now = new Date().toISOString();
    let archived = 0;
    for (const row of this.#activeRows(workspaceId)) {
      if (!row.managed || row.pinnedAt) continue;
      const { routing } = pacerOf(row);
      const cutoff = routing.decayResistant ? hardCutoff : softCutoff;
      const confFloor = routing.decayResistant ? settings.compressionMinConfidence * 0.5 : settings.compressionMinConfidence;
      const last = Date.parse(row.lastAccessedAt ?? row.updatedAt);
      if (Number(row.confidence) >= confFloor || !Number.isFinite(last) || last > cutoff) continue;
      archived += this.db.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, compressionTier: 1, updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, row.id))
        .run().changes;
    }
    return archived;
  }

  #tier2(workspaceId: string, rows: Array<typeof schema.memoryEpisodes.$inferSelect>, settings: BrainCompressionSettings): number {
    const now = new Date().toISOString();
    type Cand = { row: typeof schema.memoryEpisodes.$inferSelect; vec: number[] };
    const candidates: Cand[] = rows
      .filter((row) => row.managed && !row.pinnedAt)
      .map((row) => ({ row, vec: parseEmbedding(row.embedding) }))
      .filter((entry): entry is Cand => Boolean(entry.vec));

    // §0.2 — the old all-pairs cosine scan was O(n²): at the default 2000-atom
    // compression threshold that is ~2M vector comparisons every maintenance
    // pass, scaling quadratically. Near-duplicates share salient vocabulary, so
    // we bucket candidates by a cheap lexical signature and only run cosine WITHIN
    // a bucket — O(Σ bucketᵢ²), tiny when distinct memories spread across buckets.
    const buckets = new Map<string, Cand[]>();
    for (const cand of candidates) {
      const key = bucketSignature(`${cand.row.title} ${cand.row.summary}`);
      const group = buckets.get(key);
      if (group) group.push(cand); else buckets.set(key, [cand]);
    }

    const archived = new Set<string>();
    let merged = 0;
    for (const group of buckets.values()) {
      for (let i = 0; i < group.length; i += 1) {
        const keeper = group[i];
        if (!keeper || archived.has(keeper.row.id)) continue;
        const cluster: Array<typeof schema.memoryEpisodes.$inferSelect> = [];
        const keeperRouting = pacerOf(keeper.row).routing;
        for (let j = i + 1; j < group.length; j += 1) {
          const other = group[j];
          if (!other || archived.has(other.row.id)) continue;
          if (keeper.vec.length !== other.vec.length) continue;
          // PACER (Phase 5): a procedural rule merges only when NEARLY identical (a
          // small wording delta can be a different rule), evidence merges freely.
          // The pair threshold is the stricter of the two classes' requirements.
          const threshold = Math.max(
            settings.clusterSimilarityThreshold,
            keeperRouting.mergeSimilarity,
            pacerOf(other.row).routing.mergeSimilarity,
          );
          if (cosineSimilarity(keeper.vec, other.vec) >= threshold) {
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
    }
    return merged;
  }

  #tier3(workspaceId: string, rows: Array<typeof schema.memoryEpisodes.$inferSelect>, settings: BrainCompressionSettings): number {
    if (!this.queue) return 0;
    const byTag = new Map<string, EpisodeRow[]>();
    for (const row of rows) {
      if (!row.managed || row.pinnedAt) continue;
      for (const tag of parseJsonArray<string>(row.tags)) {
        if (tag.startsWith('pacer:')) continue; // routing tag, not a topic cluster
        const bucket = byTag.get(tag) ?? [];
        bucket.push(row);
        byTag.set(tag, bucket);
      }
    }
    // PACER (Phase 5): rank clusters so conceptual/procedural knowledge is
    // distilled first; skip evidence-dominated clusters entirely — evidence stays
    // archival and retrievable, it is not distilled into fuzzy memory.
    const clusters = [...byTag.entries()]
      .filter(([, members]) => members.length >= settings.curatorClusterMinSize)
      .map(([tag, members]) => {
        const dominant = dominantPacer(members);
        return { tag, members, dominant, priority: pacerRouting(dominant).curatorPriority };
      })
      .filter((c) => c.dominant !== 'evidence')
      .sort((a, b) => b.priority - a.priority);

    let enqueued = 0;
    for (const cluster of clusters) {
      this.queue.enqueue({
        workspaceId,
        itemType: 'curator_pass',
        priority: 'low',
        payload: {
          workspaceId,
          clusterTag: cluster.tag,
          pacerClass: cluster.dominant,
          atomIds: cluster.members.slice(0, 50).map((m) => m.id),
        },
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

/**
 * §0.2 — cheap lexical bucket key for the tier-2 near-duplicate pass. The 3 most
 * salient (longest) significant tokens, sorted, so re-statements of the same
 * lesson collide into one bucket while distinct memories spread out. Empty
 * signature (no significant tokens) groups together — fine, those are short and
 * few. This is a candidate PRE-FILTER; cosine still decides the actual merge.
 */
function bucketSignature(text: string): string {
  const top = [...new Set(tokenize(text))]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .slice(0, 3)
    .sort();
  return top.join(' ');
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

/** The most common PACER class across a cluster of atoms (defaults to evidence). */
function dominantPacer(members: EpisodeRow[]): PacerClass {
  const counts = new Map<PacerClass, number>();
  for (const row of members) {
    const cls = pacerOf(row).cls ?? 'evidence';
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  let best: PacerClass = 'evidence';
  let bestCount = -1;
  for (const [cls, count] of counts) {
    if (count > bestCount) { best = cls; bestCount = count; }
  }
  return best;
}
