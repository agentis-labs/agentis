import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import { HashingEmbeddingProvider, cosineSimilarity } from './embeddingProvider.js';
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

const provider = new HashingEmbeddingProvider();
const SESSION_ATOM_TTL_MS = 24 * 60 * 60 * 1000;

export class SessionMomentService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  add(args: {
    workspaceId: string;
    sessionId: string;
    scopeId?: string | null;
    content: string;
    confidence?: number;
  }): SessionMoment {
    const now = new Date();
    const row = {
      id: randomUUID(),
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      content: args.content.trim(),
      confidence: clamp01(args.confidence ?? 0.65),
      embedding: provider.embed(args.content.trim()),
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
    const queryVec = provider.embed(args.query);
    return this.list({ workspaceId: args.workspaceId, sessionId: args.sessionId, limit: 100 })
      .map((atom) => {
        const row = this.db.select({ embedding: schema.sessionMoments.embedding }).from(schema.sessionMoments)
          .where(eq(schema.sessionMoments.id, atom.id))
          .get();
        const vec = parseEmbedding(row?.embedding);
        const score = vec && vec.length === queryVec.length
          ? cosineSimilarity(queryVec, vec)
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
