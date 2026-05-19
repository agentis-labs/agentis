/**
 * EpisodicMemoryStore — Layer 3 backend.
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md §7.
 *
 * Owns the `memory_episodes` table. Three responsibilities:
 *
 *   1. Write episodes (from promotion, operator UI, agent proposals, seeds).
 *   2. Read by workspace/app/workflow/run/type for the API surface.
 *   3. Lexical and (when wired) semantic retrieval for the memory runtime.
 *
 * Distinct from the wedge's `AppMemoryStore` (which holds `app_memory` rows
 * for typed knowledge: facts, rules, patterns). EpisodicMemoryStore holds
 * execution-derived lessons.
 *
 * Retrieval defaults (configurable via `searchEpisodes` args):
 *   - lexical TF-IDF on title + summary + details
 *   - per-candidate score = tfidf × trust × outcomeBoost × freshnessDecay
 *   - archived episodes excluded by default
 *   - superseded episodes excluded by default
 */

import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql, desc } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type {
  CreateRuntimeEpisodeInput,
  RuntimeEpisode,
  RuntimeEpisodeType,
  RuntimeEpisodeOutcome,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { type EmbeddingProvider, cosineSimilarity } from './embeddingProvider.js';

export interface EpisodeSearchArgs {
  workspaceId: string;
  /** Restrict to one app — falsy means workspace-wide. */
  appId?: string;
  workflowId?: string;
  /** Restrict to specific types. */
  types?: RuntimeEpisodeType[];
  /** Free-text query. */
  query?: string;
  /** Required tags (any-match). */
  tags?: string[];
  /** Required entities (any-match). */
  entities?: string[];
  /** Outcome filter. */
  outcomeStatus?: RuntimeEpisodeOutcome;
  /** Include archived rows. Default false. */
  includeArchived?: boolean;
  /** Include superseded rows. Default false. */
  includeSuperseded?: boolean;
  /** Result cap (default 8, max 50). */
  limit?: number;
  /** Override retrieval mode. */
  mode?: 'lexical' | 'vector' | 'hybrid' | 'auto';
}

const STOP_WORDS = new Set([
  'a','an','and','are','as','at','be','but','by','for','from','has','have',
  'i','in','into','is','it','its','of','on','or','that','the','their','this',
  'to','was','were','will','with','you','your','we','our','they','them','these',
  'those','do','does','did','if','then','than','so','too','can','could','would',
  'should','about','after','before','between','during','over','under','out','off',
]);

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

export class EpisodicMemoryStore {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
    private readonly embeddingProvider?: EmbeddingProvider,
  ) {
    void this.logger;
  }

  /** Tokenise text for lexical scoring. Same tokeniser shape as KnowledgeStore. */
  static tokenize(input: string): string[] {
    if (!input) return [];
    const out: string[] = [];
    const cleaned = input.toLowerCase().replace(/[^a-z0-9_\s]+/g, ' ');
    for (const raw of cleaned.split(/\s+/)) {
      if (!raw || raw.length < 2 || STOP_WORDS.has(raw)) continue;
      out.push(raw);
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────
  // Write
  // ────────────────────────────────────────────────────────────

  /** Persist a new episode. Returns the created row. */
  write(input: CreateRuntimeEpisodeInput): RuntimeEpisode {
    const id = randomUUID();
    const now = new Date().toISOString();
    const confidence = clamp01(input.confidence ?? 0.5);
    const importance = clamp01(input.importance ?? 0.5);
    const trust = clamp01(input.trust ?? 0.5);

    let embedding: number[] | null = null;
    if (this.embeddingProvider) {
      const text = `${input.title} ${input.summary} ${input.details ?? ''}`;
      const raw = this.embeddingProvider.embed(text);
      embedding = Array.isArray(raw) ? raw : null;
    }

    const row = {
      id,
      workspaceId: input.workspaceId,
      appId: input.appId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      agentId: input.agentId ?? null,
      type: input.type,
      title: input.title,
      summary: input.summary,
      details: input.details ?? null,
      source: input.source,
      confidence: String(confidence),
      importance: String(importance),
      trust: String(trust),
      tags: input.tags ?? [],
      entities: input.entities ?? [],
      outcomeStatus: input.outcomeStatus ?? null,
      embedding: embedding as unknown as null,
      metadata: input.metadata ?? {},
      reinforcedAt: null,
      archivedAt: null,
      supersededBy: null,
      // Brain & Abilities Replan §B5/B6 — lifecycle + managed/protected flags.
      // operator_write / seed / system_write are operator-authored: never
      // auto-archived. All other sources are decay-eligible.
      status: 'active',
      managed: !['operator_write', 'seed', 'system_write'].includes(input.source),
      pinnedAt: null,
      lastAccessedAt: null,
      isDisputed: false,
      disputeReason: null,
      disputeResolvedAt: null,
      disputeSnoozedUntil: null,
      contextCondition: null,
      compressedFrom: null,
      compressionTier: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.insert(schema.memoryEpisodes).values(row).run();
    return rowToEpisode({ ...row, embedding: embedding as unknown as null });
  }

  /** Look up an episode by id. */
  byId(workspaceId: string, id: string): RuntimeEpisode | null {
    const row = this.db
      .select()
      .from(schema.memoryEpisodes)
      .where(
        and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          eq(schema.memoryEpisodes.id, id),
        ),
      )
      .get();
    return row ? rowToEpisode(row) : null;
  }

  /**
   * Reinforce an existing episode (re-promotion). Bumps confidence and trust
   * by small increments and updates `reinforcedAt`. Used by the promotion
   * pipeline when a candidate matches an existing episode.
   */
  reinforce(workspaceId: string, id: string, options?: {
    confidenceDelta?: number;
    trustDelta?: number;
    importanceDelta?: number;
  }): RuntimeEpisode | null {
    const existing = this.byId(workspaceId, id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const newConfidence = clamp01(existing.confidence + (options?.confidenceDelta ?? 0.07));
    const newTrust = clamp01(existing.trust + (options?.trustDelta ?? 0.05));
    const newImportance = clamp01(existing.importance + (options?.importanceDelta ?? 0));
    this.db.update(schema.memoryEpisodes)
      .set({
        confidence: String(newConfidence),
        trust: String(newTrust),
        importance: String(newImportance),
        reinforcedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.memoryEpisodes.id, id))
      .run();
    return this.byId(workspaceId, id);
  }

  /** Update an episode (operator edits). Only the safe fields. */
  update(workspaceId: string, id: string, patch: Partial<{
    title: string;
    summary: string;
    details: string | null;
    tags: string[];
    entities: string[];
    importance: number;
    trust: number;
    confidence: number;
    outcomeStatus: RuntimeEpisodeOutcome | null;
    metadata: Record<string, unknown>;
  }>): RuntimeEpisode | null {
    const existing = this.byId(workspaceId, id);
    if (!existing) return null;
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.details !== undefined) set.details = patch.details;
    if (patch.tags !== undefined) set.tags = patch.tags;
    if (patch.entities !== undefined) set.entities = patch.entities;
    if (patch.importance !== undefined) set.importance = String(clamp01(patch.importance));
    if (patch.trust !== undefined) set.trust = String(clamp01(patch.trust));
    if (patch.confidence !== undefined) set.confidence = String(clamp01(patch.confidence));
    if (patch.outcomeStatus !== undefined) set.outcomeStatus = patch.outcomeStatus;
    if (patch.metadata !== undefined) set.metadata = patch.metadata;

    this.db.update(schema.memoryEpisodes)
      .set(set)
      .where(eq(schema.memoryEpisodes.id, id))
      .run();
    return this.byId(workspaceId, id);
  }

  /** Archive (soft-delete) an episode. Hides it from default retrieval. */
  archive(workspaceId: string, id: string): boolean {
    const result = this.db.update(schema.memoryEpisodes)
      .set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          eq(schema.memoryEpisodes.id, id),
        ),
      )
      .run();
    return result.changes > 0;
  }

  /** Mark an episode as superseded by another. Used on contradiction resolution. */
  supersede(workspaceId: string, id: string, supersededBy: string): boolean {
    const result = this.db.update(schema.memoryEpisodes)
      .set({ supersededBy, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          eq(schema.memoryEpisodes.id, id),
        ),
      )
      .run();
    return result.changes > 0;
  }

  /** Hard delete (operator action). */
  delete(workspaceId: string, id: string): boolean {
    const result = this.db.delete(schema.memoryEpisodes)
      .where(
        and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          eq(schema.memoryEpisodes.id, id),
        ),
      )
      .run();
    return result.changes > 0;
  }

  /**
   * Delete episodes for an app. By default deletes ALL — used on full app
   * uninstall. Pass `source` to delete only seeded/promoted/etc.
   */
  deleteForApp(workspaceId: string, appId: string, source?: RuntimeEpisode['source']): number {
    const conds = [
      eq(schema.memoryEpisodes.workspaceId, workspaceId),
      eq(schema.memoryEpisodes.appId, appId),
    ];
    if (source) conds.push(eq(schema.memoryEpisodes.source, source));
    const result = this.db.delete(schema.memoryEpisodes).where(and(...conds)).run();
    return result.changes;
  }

  // ────────────────────────────────────────────────────────────
  // Read
  // ────────────────────────────────────────────────────────────

  /** List episodes for an app/workspace. UI listings, not retrieval ranking. */
  list(args: {
    workspaceId: string;
    appId?: string;
    types?: RuntimeEpisodeType[];
    workflowId?: string;
    runId?: string;
    includeArchived?: boolean;
    limit?: number;
  }): RuntimeEpisode[] {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const conds = [eq(schema.memoryEpisodes.workspaceId, args.workspaceId)];
    if (args.appId) conds.push(eq(schema.memoryEpisodes.appId, args.appId));
    if (args.workflowId) conds.push(eq(schema.memoryEpisodes.workflowId, args.workflowId));
    if (args.runId) conds.push(eq(schema.memoryEpisodes.runId, args.runId));
    if (!args.includeArchived) conds.push(isNull(schema.memoryEpisodes.archivedAt));
    const rows = this.db.select().from(schema.memoryEpisodes).where(and(...conds))
      .orderBy(desc(schema.memoryEpisodes.createdAt))
      .limit(limit)
      .all();
    let filtered = rows;
    if (args.types && args.types.length > 0) {
      const typeSet = new Set(args.types);
      filtered = filtered.filter((r) => typeSet.has(r.type as RuntimeEpisodeType));
    }
    return filtered.map(rowToEpisode);
  }

  /**
   * Lexical (and optionally hybrid) retrieval for the memory runtime.
   *
   * Score formula:
   *   score = (tfidf × trust × outcomeBoost × freshnessDecay)
   *         + (cosine × trust if vector path is active)
   *
   * - outcomeBoost: 1.2 for 'good', 0.85 for 'bad', 1.0 for 'mixed' or null.
   *   The runtime values lessons that worked AND lessons that warn about failures.
   * - freshnessDecay: smooth exponential decay over months since createdAt.
   * - archived/superseded excluded unless explicitly requested.
   */
  searchEpisodes(args: EpisodeSearchArgs): RuntimeEpisode[] {
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    // Load candidates for the workspace (and optionally app).
    const conds = [eq(schema.memoryEpisodes.workspaceId, args.workspaceId)];
    if (args.appId) conds.push(eq(schema.memoryEpisodes.appId, args.appId));
    if (args.workflowId) conds.push(eq(schema.memoryEpisodes.workflowId, args.workflowId));
    if (!args.includeArchived) conds.push(isNull(schema.memoryEpisodes.archivedAt));
    if (!args.includeSuperseded) conds.push(isNull(schema.memoryEpisodes.supersededBy));

    let rows = this.db.select().from(schema.memoryEpisodes).where(and(...conds)).all();

    // In-memory filters (small candidate sets per app).
    if (args.types && args.types.length > 0) {
      const t = new Set(args.types);
      rows = rows.filter((r) => t.has(r.type as RuntimeEpisodeType));
    }
    if (args.outcomeStatus) {
      rows = rows.filter((r) => r.outcomeStatus === args.outcomeStatus);
    }
    if (args.tags && args.tags.length > 0) {
      const wanted = new Set(args.tags);
      rows = rows.filter((r) => parseJsonArray<string>(r.tags).some((t) => wanted.has(t)));
    }
    if (args.entities && args.entities.length > 0) {
      const wanted = new Set(args.entities);
      rows = rows.filter((r) => parseJsonArray<string>(r.entities).some((e) => wanted.has(e)));
    }
    if (rows.length === 0) return [];

    const queryTokens = args.query ? EpisodicMemoryStore.tokenize(args.query) : [];

    // No query → rank by trust × importance × recency.
    if (queryTokens.length === 0) {
      const scored = rows.map((r) => {
        const trust = Number(r.trust) || 0;
        const importance = Number(r.importance) || 0;
        const ageDays = ageDaysSince(r.createdAt);
        const freshness = freshnessDecay(ageDays);
        const score = trust * (0.5 + 0.5 * importance) * freshness;
        return { row: r, score };
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map(({ row }) => rowToEpisode(row));
    }

    // Lexical TF-IDF on title + summary + details.
    const querySet = new Set(queryTokens);
    type Cand = { row: typeof rows[number]; tokens: string[]; tfidf: number };
    const docs: Cand[] = [];
    for (const r of rows) {
      const text = `${r.title} ${r.summary} ${r.details ?? ''}`;
      const tokens = EpisodicMemoryStore.tokenize(text);
      docs.push({ row: r, tokens, tfidf: 0 });
    }
    const N = docs.length;
    const docFreq = new Map<string, number>();
    for (const c of docs) {
      const seen = new Set<string>();
      for (const t of c.tokens) {
        if (!querySet.has(t) || seen.has(t)) continue;
        seen.add(t);
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }
    for (const c of docs) {
      const tf = new Map<string, number>();
      for (const t of c.tokens) if (querySet.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
      let s = 0;
      for (const qt of queryTokens) {
        const f = tf.get(qt) ?? 0;
        if (f === 0) continue;
        const df = docFreq.get(qt) ?? 1;
        const idf = Math.log((1 + N) / (1 + df)) + 1;
        s += (f / Math.max(1, Math.sqrt(c.tokens.length))) * idf;
      }
      c.tfidf = s;
    }

    // Vector path — when wired and we have at least one chunk with embedding.
    const mode = args.mode ?? 'auto';
    let qVec: number[] | null = null;
    const wantsVector = (mode === 'vector' || mode === 'hybrid' || mode === 'auto')
      && this.embeddingProvider !== undefined;
    if (wantsVector) {
      const raw = this.embeddingProvider!.embed(args.query!);
      if (Array.isArray(raw)) qVec = raw;
    }

    const maxTfidf = Math.max(...docs.map((d) => d.tfidf), 1e-9);

    const scored = docs.map((c) => {
      const r = c.row;
      const trust = Number(r.trust) || 0;
      const ageDays = ageDaysSince(r.createdAt);
      const freshness = freshnessDecay(ageDays);
      const outcomeBoost = r.outcomeStatus === 'good' ? 1.2
        : r.outcomeStatus === 'bad' ? 0.85
        : 1.0;

      // Lexical contribution (normalised for hybrid combination).
      const normTfidf = c.tfidf / maxTfidf;

      // Vector contribution.
      let vectorScore = 0;
      if (qVec) {
        const emb = parseJsonArray<number>(r.embedding);
        if (emb.length === qVec.length) vectorScore = cosineSimilarity(qVec, emb);
      }

      let combined = 0;
      if (mode === 'lexical' || !wantsVector) {
        combined = normTfidf;
      } else if (mode === 'vector') {
        combined = vectorScore;
      } else {
        // hybrid / auto
        combined = 0.6 * vectorScore + 0.4 * normTfidf;
      }

      const score = combined * trust * outcomeBoost * freshness;
      return { row: r, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ row }) => rowToEpisode(row));
  }

  /** Find episodes similar to a candidate (used for dedup). */
  findSimilar(workspaceId: string, candidate: { title: string; summary: string; appId?: string | null; type?: string }, threshold = 0.7): RuntimeEpisode[] {
    const args: EpisodeSearchArgs = {
      workspaceId,
      query: `${candidate.title} ${candidate.summary}`,
      limit: 5,
    };
    if (candidate.appId) args.appId = candidate.appId;
    if (candidate.type) args.types = [candidate.type as RuntimeEpisodeType];
    const hits = this.searchEpisodes(args);
    // Heuristic: cosine sim ≥ threshold means "close enough to dedupe".
    if (!this.embeddingProvider) return hits.slice(0, 1);
    const candVec = this.embeddingProvider.embed(`${candidate.title} ${candidate.summary}`);
    if (!Array.isArray(candVec)) return hits;
    return hits.filter((h) => {
      if (!h.embedding) return false;
      return cosineSimilarity(candVec, h.embedding) >= threshold;
    });
  }

  /** Counts grouped by type, useful for the dashboard. */
  countByApp(workspaceId: string, appId: string): { total: number; byType: Record<string, number> } {
    const rows = this.db.select({
      type: schema.memoryEpisodes.type,
      count: sql<number>`count(*)`,
    })
      .from(schema.memoryEpisodes)
      .where(
        and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          eq(schema.memoryEpisodes.appId, appId),
          isNull(schema.memoryEpisodes.archivedAt),
        ),
      )
      .groupBy(schema.memoryEpisodes.type)
      .all();
    let total = 0;
    const byType: Record<string, number> = {};
    for (const r of rows) {
      const c = Number(r.count) || 0;
      byType[r.type] = c;
      total += c;
    }
    return { total, byType };
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function ageDaysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

/**
 * Smooth exponential freshness decay.
 *   - 0–7 days:   ~1.0 (recent)
 *   - 30 days:    ~0.85
 *   - 90 days:    ~0.6
 *   - 180+ days:  ~0.4
 * Floor at 0.3 so very old but still-trusted episodes don't disappear.
 */
function freshnessDecay(ageDays: number): number {
  if (ageDays <= 7) return 1;
  const decay = Math.exp(-ageDays / 180);
  return Math.max(0.3, decay);
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch { return []; }
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}

function rowToEpisode(row: typeof schema.memoryEpisodes.$inferSelect): RuntimeEpisode {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    appId: row.appId,
    workflowId: row.workflowId,
    runId: row.runId,
    agentId: row.agentId,
    type: row.type as RuntimeEpisode['type'],
    title: row.title,
    summary: row.summary,
    details: row.details,
    source: row.source as RuntimeEpisode['source'],
    confidence: Number(row.confidence) || 0,
    importance: Number(row.importance) || 0,
    trust: Number(row.trust) || 0,
    tags: parseJsonArray<string>(row.tags),
    entities: parseJsonArray<string>(row.entities),
    outcomeStatus: row.outcomeStatus as RuntimeEpisode['outcomeStatus'],
    embedding: row.embedding ? parseJsonArray<number>(row.embedding) : null,
    metadata: parseJsonRecord(row.metadata),
    reinforcedAt: row.reinforcedAt,
    archivedAt: row.archivedAt,
    supersededBy: row.supersededBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
