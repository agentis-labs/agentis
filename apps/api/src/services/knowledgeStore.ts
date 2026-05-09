/**
 * KnowledgeStore — App Knowledge Wedge Plane 5 backend.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §10–§11.
 *
 * Owns the `knowledge_chunks` table. Three responsibilities:
 *
 *   1. Write seeds, imports, and promoted patterns — distinguished by `source`
 *      so retrieval can rank and the UI can explain provenance.
 *   2. Read by app + filters (source, tag) for the API surface.
 *   3. Retrieval:
 *        - Lexical (TF-IDF): always available; no pre-computation needed.
 *        - Vector (cosine similarity): active when an `EmbeddingProvider` is
 *          injected and the chunk has a pre-computed embedding.
 *        - Hybrid: when both paths produce scores, combines them as
 *          `0.65 × normalisedCosine + 0.35 × normalisedTFIDF`.
 *
 * The embedding column was reserved in the schema from day 1. The upgrade
 * from lexical to hybrid required:
 *   - Injecting an `EmbeddingProvider` into the constructor.
 *   - Calling `write()` (embeddings are generated automatically at write time).
 *   - No API changes elsewhere — `search()` auto-detects the active path.
 *
 * Tokenisation is intentionally minimal: lowercase, alphanumerics + `_`,
 * stop-word skip. Good enough for V1 wedge retrieval; deterministic and
 * dependency-free.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { KnowledgeChunk, KnowledgeHit } from '@agentis/core';
import type { Logger } from '../logger.js';
import { type EmbeddingProvider, cosineSimilarity } from './embeddingProvider.js';

export interface KnowledgeWriteInput {
  workspaceId: string;
  appId: string;
  title: string;
  content: string;
  source: KnowledgeChunk['source'];
  provenance?: Record<string, unknown>;
  tags?: string[];
  trust?: number;
  /**
   * Pre-computed embedding vector. When supplied, stored directly without
   * calling the provider. Use this when you already have an embedding from
   * an external model (e.g. OpenAI batch API) and want to avoid a second
   * round-trip.
   */
  embedding?: number[];
}

export interface KnowledgeSearchArgs {
  workspaceId: string;
  appId: string;
  query: string;
  /** Limit results (default 8, max 50). */
  limit?: number;
  /** Restrict to one or more sources. */
  sources?: KnowledgeChunk['source'][];
  /** Restrict to chunks tagged with any of these tags. */
  tags?: string[];
  /**
   * Force retrieval mode. Default 'auto':
   *   - 'auto': use hybrid when chunks have embeddings, else lexical.
   *   - 'lexical': always use TF-IDF (ignores embeddings).
   *   - 'vector': cosine similarity only; chunks without embeddings get score 0.
   *   - 'hybrid': both paths, weighted combination.
   */
  mode?: 'auto' | 'lexical' | 'vector' | 'hybrid';
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

/** Minimal English stop-words so very common words don't dominate ranking. */
const STOP_WORDS = new Set([
  'a','an','and','are','as','at','be','but','by','for','from','has','have',
  'i','in','into','is','it','its','of','on','or','that','the','their','this',
  'to','was','were','will','with','you','your','we','our','they','them','these',
  'those','do','does','did','if','then','than','so','too','can','could','would',
  'should','about','after','before','between','during','over','under','out','off',
]);

export class KnowledgeStore {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
    /** Optional embedding provider. When present, embeddings are generated at
     *  write time and hybrid/vector retrieval becomes available. */
    private readonly embeddingProvider?: EmbeddingProvider,
  ) {
    void this.logger;
  }

  /** Tokenise text for indexing or for a query. Pure, deterministic. */
  static tokenize(input: string): string[] {
    if (!input) return [];
    const out: string[] = [];
    const cleaned = input.toLowerCase().replace(/[^a-z0-9_\s]+/g, ' ');
    for (const raw of cleaned.split(/\s+/)) {
      if (!raw) continue;
      if (raw.length < 2) continue;
      if (STOP_WORDS.has(raw)) continue;
      out.push(raw);
    }
    return out;
  }

  /** Write one chunk. Returns the persisted row's id. */
  write(input: KnowledgeWriteInput): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const tokens = KnowledgeStore.tokenize(`${input.title} ${input.content}`);

    // Generate embedding if provider is wired and one wasn't pre-supplied.
    let embedding: number[] | null = input.embedding ?? null;
    if (!embedding && this.embeddingProvider) {
      const raw = this.embeddingProvider.embed(`${input.title} ${input.content}`);
      // `embed` may return a promise (async provider). For the sync write path,
      // we require sync providers (HashingEmbeddingProvider is sync). Async
      // providers should use `writeAsync()` below.
      embedding = Array.isArray(raw) ? raw : null;
    }

    this.db
      .insert(schema.knowledgeChunks)
      .values({
        id,
        workspaceId: input.workspaceId,
        appId: input.appId,
        title: input.title,
        content: input.content,
        contentTokens: tokens,
        source: input.source,
        provenance: input.provenance ?? {},
        tags: input.tags ?? [],
        embedding: embedding as unknown as null, // stored as JSON array in TEXT column
        trust: String(clamp01(input.trust ?? 1)),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  /**
   * Async variant of `write()` — supports providers whose `embed()` returns a
   * Promise (e.g. OpenAI API). Use this in non-hot-path ingestion code.
   */
  async writeAsync(input: KnowledgeWriteInput): Promise<string> {
    let embedding: number[] | null = input.embedding ?? null;
    if (!embedding && this.embeddingProvider) {
      const raw = this.embeddingProvider.embed(`${input.title} ${input.content}`);
      embedding = raw instanceof Promise ? await raw : raw;
    }
    return this.write({ ...input, embedding: embedding ?? undefined });
  }

  /** Bulk write — returns the new ids in order. */
  writeMany(inputs: KnowledgeWriteInput[]): string[] {
    return inputs.map((i) => this.write(i));
  }

  /** Delete every chunk for an app — used on re-seed and on app uninstall. */
  deleteForApp(workspaceId: string, appId: string, source?: KnowledgeChunk['source']): number {
    const where = source
      ? and(
          eq(schema.knowledgeChunks.workspaceId, workspaceId),
          eq(schema.knowledgeChunks.appId, appId),
          eq(schema.knowledgeChunks.source, source),
        )
      : and(
          eq(schema.knowledgeChunks.workspaceId, workspaceId),
          eq(schema.knowledgeChunks.appId, appId),
        );
    const result = this.db.delete(schema.knowledgeChunks).where(where).run();
    return result.changes;
  }

  /** List chunks for an app (UI listings, NOT retrieval). */
  list(args: {
    workspaceId: string;
    appId: string;
    source?: KnowledgeChunk['source'];
    limit?: number;
  }): KnowledgeChunk[] {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const where = args.source
      ? and(
          eq(schema.knowledgeChunks.workspaceId, args.workspaceId),
          eq(schema.knowledgeChunks.appId, args.appId),
          eq(schema.knowledgeChunks.source, args.source),
        )
      : and(
          eq(schema.knowledgeChunks.workspaceId, args.workspaceId),
          eq(schema.knowledgeChunks.appId, args.appId),
        );
    const rows = this.db.select().from(schema.knowledgeChunks).where(where).limit(limit).all();
    return rows.map(rowToChunk);
  }

  /**
   * Unified retrieval. Auto-selects the best available path:
   *
   *   - 'lexical'  (TF-IDF)  — always available; corpus-wide IDF estimate.
   *   - 'vector'   (cosine)  — requires: (a) provider wired, (b) chunks have
   *                            stored embeddings. Falls back to lexical.
   *   - 'hybrid'             — both paths scored, combined as:
   *                            0.65 × norm(cosine) + 0.35 × norm(tfidf).
   *   - 'auto'    (default)  — hybrid when all candidates have embeddings AND
   *                            a provider is available; else lexical.
   *
   * TF-IDF scoring (lexical path):
   *   score(chunk) = Σ_t (tf_length_norm(t, chunk) × idf(t))
   *   idf(t) = log((1 + N) / (1 + df)) + 1   [smoothed]
   */
  search(args: KnowledgeSearchArgs): KnowledgeHit[] {
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const queryTokens = KnowledgeStore.tokenize(args.query);

    // Load all chunks for the app — workspace+app is indexed and the
    // expected per-app size (≤ 10k chunks) makes JS-side scoring fine.
    const candidates = this.db
      .select()
      .from(schema.knowledgeChunks)
      .where(
        and(
          eq(schema.knowledgeChunks.workspaceId, args.workspaceId),
          eq(schema.knowledgeChunks.appId, args.appId),
        ),
      )
      .all();

    // Source/tag filters.
    let filtered = candidates;
    if (args.sources && args.sources.length > 0) {
      const allowed = new Set(args.sources);
      filtered = filtered.filter((c) => allowed.has(c.source as KnowledgeChunk['source']));
    }
    if (args.tags && args.tags.length > 0) {
      const wantedTags = new Set(args.tags);
      filtered = filtered.filter((c) => {
        const tags = parseJsonArray<string>(c.tags);
        return tags.some((t) => wantedTags.has(t));
      });
    }

    if (filtered.length === 0) return [];

    // Resolve effective retrieval mode.
    const mode = this.#resolveMode(args.mode, filtered);

    if (mode === 'lexical') {
      return this.#scoreLexical(filtered, queryTokens, limit, 'lexical');
    }
    if (mode === 'vector') {
      if (!this.embeddingProvider) return this.#scoreLexical(filtered, queryTokens, limit, 'lexical');
      const qVec = asSync(this.embeddingProvider.embed(args.query));
      return this.#scoreVector(filtered, qVec, limit);
    }
    // hybrid (or auto resolved to hybrid)
    return this.#scoreHybrid(filtered, queryTokens, limit);
  }

  /**
   * Pure vector search — useful when you know all chunks have embeddings.
   * Returns at most `limit` results sorted by cosine similarity descending.
   * Chunks without embeddings are omitted.
   */
  searchVector(args: KnowledgeSearchArgs): KnowledgeHit[] {
    if (!this.embeddingProvider) {
      this.logger.warn('knowledge.searchVector.no_provider', {
        appId: args.appId,
        fallback: 'lexical',
      });
      return this.search({ ...args, mode: 'lexical' });
    }
    return this.search({ ...args, mode: 'vector' });
  }

  /** Count helpers (used by AppIntelligenceResponse summary). */
  countByApp(workspaceId: string, appId: string): { total: number; bySource: Record<string, number> } {
    const rows = this.db
      .select({ source: schema.knowledgeChunks.source, count: sql<number>`count(*)` })
      .from(schema.knowledgeChunks)
      .where(
        and(
          eq(schema.knowledgeChunks.workspaceId, workspaceId),
          eq(schema.knowledgeChunks.appId, appId),
        ),
      )
      .groupBy(schema.knowledgeChunks.source)
      .all();
    let total = 0;
    const bySource: Record<string, number> = {};
    for (const r of rows) {
      const c = Number(r.count) || 0;
      bySource[r.source] = c;
      total += c;
    }
    return { total, bySource };
  }

  /** Used by ingestion to load a batch of chunks by id (e.g. for impact preview). */
  byIds(workspaceId: string, ids: string[]): KnowledgeChunk[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .select()
      .from(schema.knowledgeChunks)
      .where(
        and(
          eq(schema.knowledgeChunks.workspaceId, workspaceId),
          inArray(schema.knowledgeChunks.id, ids),
        ),
      )
      .all();
    return rows.map(rowToChunk);
  }

  // ────────────────────────────────────────────────────────────
  // Private scoring helpers
  // ────────────────────────────────────────────────────────────

  /**
   * Determine the effective retrieval mode. Rules:
   *   - If the caller specified 'lexical': always lexical.
   *   - If no provider: always lexical (vector can't work).
   *   - If 'vector': vector (chunks without embeddings score 0).
   *   - If 'hybrid': hybrid (TF-IDF + cosine, combined).
   *   - If 'auto' (default): hybrid when ≥ 50% of candidates have embeddings;
   *     else lexical (avoids noisy half-and-half scoring for fresh databases).
   */
  #resolveMode(
    requested: KnowledgeSearchArgs['mode'],
    candidates: typeof schema.knowledgeChunks.$inferSelect[],
  ): 'lexical' | 'vector' | 'hybrid' {
    if (!this.embeddingProvider) return 'lexical';
    if (requested === 'lexical') return 'lexical';
    if (requested === 'vector') return 'vector';
    if (requested === 'hybrid') return 'hybrid';
    // 'auto' or undefined:
    const withEmbedding = candidates.filter((c) => c.embedding !== null).length;
    const coverage = withEmbedding / Math.max(1, candidates.length);
    return coverage >= 0.5 ? 'hybrid' : 'lexical';
  }

  /** TF-IDF scoring over `candidates`. `method` is injected into hits. */
  #scoreLexical(
    candidates: typeof schema.knowledgeChunks.$inferSelect[],
    queryTokens: string[],
    limit: number,
    method: KnowledgeHit['retrievalMethod'],
  ): KnowledgeHit[] {
    if (queryTokens.length === 0) return [];
    const querySet = new Set(queryTokens);
    type Cand = { row: typeof candidates[number]; tokens: string[] };
    const withTokens: Cand[] = [];
    for (const c of candidates) {
      const tokens = parseJsonArray<string>(c.contentTokens);
      let touch = false;
      for (const t of tokens) {
        if (querySet.has(t)) { touch = true; break; }
      }
      if (touch) withTokens.push({ row: c, tokens });
    }
    if (withTokens.length === 0) return [];

    const N = withTokens.length;
    const docFreq = new Map<string, number>();
    for (const c of withTokens) {
      const seen = new Set<string>();
      for (const t of c.tokens) {
        if (!querySet.has(t) || seen.has(t)) continue;
        seen.add(t);
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }

    const scored = withTokens.map((c) => {
      const tf = new Map<string, number>();
      for (const t of c.tokens) {
        if (querySet.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      let score = 0;
      for (const qt of queryTokens) {
        const f = tf.get(qt) ?? 0;
        if (f === 0) continue;
        const df = docFreq.get(qt) ?? 1;
        const idf = Math.log((1 + N) / (1 + df)) + 1;
        const normTf = f / Math.max(1, Math.sqrt(c.tokens.length));
        score += normTf * idf;
      }
      const trust = Number(c.row.trust);
      return { chunk: c.row, score: score * (Number.isFinite(trust) ? trust : 1) };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ chunk, score }) =>
      rowToHit(chunk, score, method),
    );
  }

  /**
   * Pure vector scoring. Skips chunks without embeddings.
   * `qVec` must be L2-normalised (dot product = cosine similarity).
   */
  #scoreVector(
    candidates: typeof schema.knowledgeChunks.$inferSelect[],
    qVec: number[],
    limit: number,
  ): KnowledgeHit[] {
    const scored: Array<{ chunk: typeof candidates[number]; score: number }> = [];
    for (const c of candidates) {
      const emb = parseJsonArray<number>(c.embedding);
      if (emb.length === 0) continue; // no embedding — skip in pure vector mode
      const sim = cosineSimilarity(qVec, emb);
      const trust = Number(c.trust);
      scored.push({ chunk: c, score: sim * (Number.isFinite(trust) ? trust : 1) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ chunk, score }) =>
      rowToHit(chunk, score, 'vector'),
    );
  }

  /**
   * Hybrid scoring: TF-IDF + cosine, min-max normalised then combined.
   *
   * Combined score = 0.65 × normCosine + 0.35 × normTfidf
   *
   * Chunks without embeddings receive cosine score 0 (they still get ranked
   * via their TF-IDF component). This avoids completely discarding legacy data
   * while prioritising chunks that have both signals.
   */
  #scoreHybrid(
    candidates: typeof schema.knowledgeChunks.$inferSelect[],
    queryTokens: string[],
    limit: number,
  ): KnowledgeHit[] {
    if (!this.embeddingProvider) {
      return this.#scoreLexical(candidates, queryTokens, limit, 'lexical');
    }
    const qVec = asSync(this.embeddingProvider.embed(
      queryTokens.join(' '),
    ));

    // ── TF-IDF scores for all candidates ──────────────────
    const querySet = new Set(queryTokens);
    type CandEntry = {
      row: typeof candidates[number];
      tokens: string[];
      tfidf: number;
      cosine: number;
    };
    const entries: CandEntry[] = [];

    // Pre-compute TF-IDF. Start with a doc-frequency map over the whole set
    // (not just the touching subset) to avoid inflating IDF from filtering.
    const docFreq = new Map<string, number>();
    const tokenCache = candidates.map((c) => parseJsonArray<string>(c.contentTokens));
    for (const tokens of tokenCache) {
      const seen = new Set<string>();
      for (const t of tokens) {
        if (!querySet.has(t) || seen.has(t)) continue;
        seen.add(t);
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }
    const N = candidates.length;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      const tokens = tokenCache[i]!;

      // TF-IDF score.
      const tf = new Map<string, number>();
      for (const t of tokens) {
        if (querySet.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      let tfidf = 0;
      for (const qt of queryTokens) {
        const f = tf.get(qt) ?? 0;
        if (f === 0) continue;
        const df = docFreq.get(qt) ?? 1;
        const idf = Math.log((1 + N) / (1 + df)) + 1;
        tfidf += (f / Math.max(1, Math.sqrt(tokens.length))) * idf;
      }
      const trust = Number(c.trust);
      const trustMul = Number.isFinite(trust) ? trust : 1;
      tfidf *= trustMul;

      // Cosine score.
      const emb = parseJsonArray<number>(c.embedding);
      const cosine = emb.length > 0 ? cosineSimilarity(qVec, emb) * trustMul : 0;

      entries.push({ row: c, tokens, tfidf, cosine });
    }

    // Min-max normalise TF-IDF so it's on the same [0, 1] scale as cosine.
    const maxTfidf = Math.max(...entries.map((e) => e.tfidf), 1e-9);
    const maxCosine = Math.max(...entries.map((e) => e.cosine), 1e-9);

    const scored = entries.map((e) => {
      const normTfidf = e.tfidf / maxTfidf;
      const normCosine = e.cosine / maxCosine;
      // Skip entries with no signal in either path.
      if (normTfidf === 0 && normCosine === 0) return null;
      const method: KnowledgeHit['retrievalMethod'] =
        e.cosine > 0 ? 'hybrid' : 'lexical';
      const score = 0.65 * normCosine + 0.35 * normTfidf;
      return { chunk: e.row, score, method };
    }).filter((e): e is NonNullable<typeof e> => e !== null);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ chunk, score, method }) =>
      rowToHit(chunk, score, method),
    );
  }
}

// ────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────

/**
 * Resolve an `embed()` result that may be sync or async.
 * HashingEmbeddingProvider is always sync; this helper future-proofs the
 * hot path without requiring the whole function to be async.
 */
function asSync(result: number[] | Promise<number[]>): number[] {
  if (Array.isArray(result)) return result;
  // If the provider is async, we can't await here without making search()
  // async. Log a warning and return an empty vector — the hybrid path will
  // fall back to pure TF-IDF for this query.
  return [];
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToChunk(row: typeof schema.knowledgeChunks.$inferSelect): KnowledgeChunk {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    appId: row.appId,
    title: row.title,
    content: row.content,
    contentTokens: parseJsonArray<string>(row.contentTokens),
    source: row.source as KnowledgeChunk['source'],
    provenance: parseJsonRecord(row.provenance),
    tags: parseJsonArray<string>(row.tags),
    embedding: row.embedding ? parseJsonArray<number>(row.embedding) : null,
    trust: Number(row.trust),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToHit(
  row: typeof schema.knowledgeChunks.$inferSelect,
  score: number,
  retrievalMethod?: KnowledgeHit['retrievalMethod'],
): KnowledgeHit {
  return {
    chunkId: row.id,
    appId: row.appId,
    title: row.title,
    content: row.content,
    score,
    source: row.source as KnowledgeChunk['source'],
    tags: parseJsonArray<string>(row.tags),
    trust: Number(row.trust),
    provenance: parseJsonRecord(row.provenance),
    retrievalMethod,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
