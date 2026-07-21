import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import { cosineSimilarity, embedSyncOrDefer, isEmbeddingModelCoolingDown, isEmbeddingModelUnavailable, providerIdentity, vectorIsComparable } from './embedding/embeddingProvider.js';
import type { EmbeddingProviderResolver } from './embedding/embeddingProviderRegistry.js';
import type { CognitivePromotionQueueWorker } from './cognitivePromotionQueueWorker.js';

export interface SessionMoment {
  id: string;
  sessionId: string;
  workspaceId: string;
  scopeId: string | null;
  content: string;
  confidence: number;
  score?: number;
  createdAt: string;
  expiresAt: string;
}

const SESSION_ATOM_TTL_MS = 24 * 60 * 60 * 1000;

export class SessionMomentService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly logger: Logger,
    /** §B1.1 — workspace embedding resolver; defaults to none → lexical-only. */
    private readonly resolveProvider?: EmbeddingProviderResolver,
  ) {}

  add(args: {
    workspaceId: string;
    sessionId: string;
    scopeId?: string | null;
    content: string;
    confidence?: number;
  }): SessionMoment {
    const now = new Date();
    const content = args.content.trim();
    // §B1.1/§B1.2 — embed with the workspace provider, stamp identity, defer
    // async providers to the re-embed sweep instead of blocking the write.
    const provider = this.resolveProvider?.(args.workspaceId);
    let embedding: number[] | null = null;
    let embeddingModel: string | null = null;
    let embeddingDims: number | null = null;
    let needsReembed = false;
    if (provider) {
      const vector = embedSyncOrDefer(provider, content);
      if (vector) {
        embedding = vector;
        const identity = providerIdentity(provider);
        embeddingModel = identity.model;
        embeddingDims = identity.dims;
      } else {
        needsReembed = true;
      }
    }
    const row = {
      id: randomUUID(),
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      content,
      confidence: clamp01(args.confidence ?? 0.65),
      embedding,
      embeddingModel,
      embeddingDims,
      needsReembed,
      promotedAt: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_ATOM_TTL_MS).toISOString(),
    };
    if (!row.content) throw new Error('session atom content is required');
    this.db.insert(schema.sessionMoments).values(row).run();
    return rowToAtom(row);
  }

  list(args: { workspaceId: string; sessionId: string; limit?: number }): SessionMoment[] {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    return this.db.select().from(schema.sessionMoments)
      .where(and(
        eq(schema.sessionMoments.workspaceId, args.workspaceId),
        eq(schema.sessionMoments.sessionId, args.sessionId),
      ))
      .orderBy(desc(schema.sessionMoments.confidence), desc(schema.sessionMoments.createdAt))
      .limit(limit)
      .all()
      .map(rowToAtom);
  }

  query(args: { workspaceId: string; sessionId: string; query: string; limit?: number }): SessionMoment[] {
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
    const provider = this.resolveProvider?.(args.workspaceId);
    // Sync-only on this path; an async provider degrades to lexical here (and its
    // promise must be swallowed, not dropped — see embedSyncOrDefer).
    const queryVec = provider ? embedSyncOrDefer(provider, args.query) : null;
    return this.list({ workspaceId: args.workspaceId, sessionId: args.sessionId, limit: 100 })
      .map((atom) => {
        const row = this.db.select({
          embedding: schema.sessionMoments.embedding,
          embeddingModel: schema.sessionMoments.embeddingModel,
          embeddingDims: schema.sessionMoments.embeddingDims,
        }).from(schema.sessionMoments)
          .where(eq(schema.sessionMoments.id, atom.id))
          .get();
        const vec = parseEmbedding(row?.embedding);
        const comparable = queryVec && provider && vectorIsComparable(row?.embeddingModel, row?.embeddingDims, provider);
        const score = comparable && vec && vec.length === queryVec!.length
          ? cosineSimilarity(queryVec!, vec)
          : lexicalScore(args.query, atom.content);
        return { ...atom, score };
      })
      .filter((atom) => (atom.score ?? 0) > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
  }

  promoteEligible(args: {
    workspaceId: string;
    sessionId: string;
    queue?: CognitivePromotionQueueWorker | null;
  }): { enqueued: number; skipped: number } {
    const rows = this.db.select().from(schema.sessionMoments)
      .where(and(
        eq(schema.sessionMoments.workspaceId, args.workspaceId),
        eq(schema.sessionMoments.sessionId, args.sessionId),
        isNull(schema.sessionMoments.promotedAt),
      ))
      .all();
    let enqueued = 0;
    let skipped = 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      if (row.confidence < 0.7) {
        skipped += 1;
        continue;
      }
      if (args.queue) {
        args.queue.enqueue({
          workspaceId: args.workspaceId,
          itemType: 'atom_promotion',
          priority: 'normal',
          payload: {
            workspaceId: args.workspaceId,
            scopeId: row.scopeId,
            taskOutput: { summary: row.content },
            taskInput: { source: 'session_atom', sessionId: row.sessionId },
          },
        });
      }
      this.db.update(schema.sessionMoments)
        .set({ promotedAt: now })
        .where(eq(schema.sessionMoments.id, row.id))
        .run();
      enqueued += 1;
    }
    if (enqueued > 0) {
      this.logger.info('session_moments.promoted', { workspaceId: args.workspaceId, sessionId: args.sessionId, enqueued });
    }
    return { enqueued, skipped };
  }

  sweepExpired(nowIso = new Date().toISOString()): number {
    const result = this.db.delete(schema.sessionMoments)
      .where(lt(schema.sessionMoments.expiresAt, nowIso))
      .run();
    return result.changes;
  }

  /**
   * §B1.2 — backfill embeddings the write path deferred. An async provider
   * (default local ONNX) returns a Promise from `embed()`, so `add()` stores a
   * null vector + `needsReembed=1` instead of blocking the write. Without a
   * sweep those atoms stay lexical-only forever and never become semantically
   * seekable. This embeds the pending rows for a workspace and clears the flag.
   * Called by the boot re-embed sweep (mirrors `SharedIntelligence.reembedPending`).
   */
  async reembedPending(workspaceId: string, limit = 50): Promise<number> {
    const provider = this.resolveProvider?.(workspaceId);
    if (!provider) return 0;
    const rows = this.db.select().from(schema.sessionMoments)
      .where(and(
        eq(schema.sessionMoments.workspaceId, workspaceId),
        eq(schema.sessionMoments.needsReembed, true),
      ))
      .limit(limit)
      .all();
    if (rows.length === 0) return 0;
    // Known-unavailable and cooling down — skip silently (see sharedIntelligence).
    if (isEmbeddingModelCoolingDown(provider)) return 0;
    const identity = providerIdentity(provider);
    let embedded = 0;
    for (const row of rows) {
      try {
        const vector = await provider.embed(row.content);
        if (!Array.isArray(vector)) continue;
        this.db.update(schema.sessionMoments)
          .set({ embedding: vector, embeddingModel: identity.model, embeddingDims: identity.dims, needsReembed: false })
          .where(eq(schema.sessionMoments.id, row.id))
          .run();
        embedded += 1;
      } catch (err) {
        // Whole-sweep condition — see the matching guard in sharedIntelligence.
        if (isEmbeddingModelUnavailable(err)) {
          this.logger.warn('session_moments.reembed_paused', {
            workspaceId,
            pending: rows.length - embedded,
            message: (err as Error).message,
          });
          break;
        }
        this.logger.warn('session_moments.reembed_failed', { workspaceId, id: row.id, message: (err as Error).message });
      }
    }
    if (embedded > 0) this.logger.info('session_moments.reembedded', { workspaceId, embedded });
    return embedded;
  }

  emitRefresh(args: { workspaceId: string; scopeId?: string | null; reason?: string | null; atomCount: number; SessionMomentCount: number }): void {
    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_REFRESH_TRIGGERED, {
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      reason: args.reason ?? null,
      atomCount: args.atomCount,
      SessionMomentCount: args.SessionMomentCount,
    });
  }
}

function rowToAtom(row: typeof schema.sessionMoments.$inferSelect): SessionMoment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    scopeId: row.scopeId,
    content: row.content,
    confidence: row.confidence,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) return raw as number[];
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((n) => typeof n === 'number') ? parsed as number[] : null;
  } catch {
    return null;
  }
}

function lexicalScore(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let hits = 0;
  for (const token of left) if (right.has(token)) hits += 1;
  return hits / left.size;
}

function tokens(input: string): string[] {
  return input.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
