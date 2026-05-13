/**
 * AppMemoryStore — App memory plane.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §11.4 + §14.4.
 *
 * Owns the `app_memory` table. Memory is distinct from knowledge:
 *
 *   - Knowledge is retrieved (you fetch the right paragraph for the question).
 *   - Memory is recalled (you remember the rule that always applies).
 *
 * Three sources, all written through the same surface:
 *   - seed       — packaged with the app (`MemorySeed`)
 *   - operator   — user-edited via the UI
 *   - promotion  — written by IntelligencePromotion when a pattern crosses
 *                  the confidence threshold for memorisation
 *
 * Five kinds:
 *   fact       static piece of information ("The fiscal year ends Dec 31")
 *   preference operator-stated preference  ("Always greet with first name")
 *   pattern    distilled regularity         ("Tickets in queue X take 4 days")
 *   rule       a hard constraint            ("Never email before 9am ET")
 *   lesson     a confirmed correction       ("Don't suggest weekend windows")
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { MemoryEpisode } from '@agentis/core';
import type { Logger } from '../logger.js';

export interface MemoryWriteInput {
  workspaceId: string;
  appId: string;
  kind: MemoryEpisode['kind'];
  source: MemoryEpisode['source'];
  title: string;
  content: string;
  trust?: number;
  importance?: number;
  tags?: string[];
  provenance?: Record<string, unknown>;
}

export interface MemoryListArgs {
  workspaceId: string;
  appId: string;
  kind?: MemoryEpisode['kind'];
  source?: MemoryEpisode['source'];
  /** Only episodes at or above this trust. */
  minTrust?: number;
  /** Default 50, max 200. */
  limit?: number;
}

export interface MemoryRecallArgs {
  workspaceId: string;
  appId: string;
  /** Free-text hint — used by the simple recall scorer. */
  hint?: string;
  /** Token budget; the recall trims by importance × trust × recency. */
  limit?: number;
  /** Restrict to one or more kinds (e.g. only 'rule' + 'preference' for prompt prelude). */
  kinds?: MemoryEpisode['kind'][];
}

const RECALL_CANDIDATE_LIMIT = 300;

export class AppMemoryStore {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {
    void this.logger;
  }

  /** Insert one episode; returns the new id. */
  write(input: MemoryWriteInput): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .insert(schema.appMemory)
      .values({
        id,
        workspaceId: input.workspaceId,
        appId: input.appId,
        kind: input.kind,
        source: input.source,
        title: input.title,
        content: input.content,
        trust: String(clamp01(input.trust ?? (input.source === 'seed' ? 0.9 : 0.7))),
        importance: String(clamp01(input.importance ?? 0.5)),
        tags: input.tags ?? [],
        provenance: input.provenance ?? {},
        reinforcedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  writeMany(inputs: MemoryWriteInput[]): string[] {
    return inputs.map((i) => this.write(i));
  }

  /**
   * Reinforce an existing episode — bumps trust and updates `reinforced_at`.
   * Promotion calls this when the same pattern appears again.
   */
  reinforce(workspaceId: string, episodeId: string, deltaTrust = 0.05): MemoryEpisode | null {
    const row = this.db
      .select()
      .from(schema.appMemory)
      .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, episodeId)))
      .get();
    if (!row) return null;
    const now = new Date().toISOString();
    const newTrust = clamp01(Number(row.trust) + deltaTrust);
    this.db
      .update(schema.appMemory)
      .set({ trust: String(newTrust), reinforcedAt: now, updatedAt: now })
      .where(eq(schema.appMemory.id, episodeId))
      .run();
    return rowToEpisode({ ...row, trust: String(newTrust), reinforcedAt: now, updatedAt: now });
  }

  /** Update operator-editable fields. Does not allow source/kind changes. */
  update(
    workspaceId: string,
    episodeId: string,
    patch: Partial<Pick<MemoryEpisode, 'title' | 'content' | 'trust' | 'importance' | 'tags'>>,
  ): MemoryEpisode | null {
    const row = this.db
      .select()
      .from(schema.appMemory)
      .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, episodeId)))
      .get();
    if (!row) return null;
    const now = new Date().toISOString();
    const next: Record<string, unknown> = { updatedAt: now };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.content !== undefined) next.content = patch.content;
    if (patch.trust !== undefined) next.trust = String(clamp01(patch.trust));
    if (patch.importance !== undefined) next.importance = String(clamp01(patch.importance));
    if (patch.tags !== undefined) next.tags = patch.tags;
    this.db.update(schema.appMemory).set(next).where(eq(schema.appMemory.id, episodeId)).run();
    return this.byId(workspaceId, episodeId);
  }

  delete(workspaceId: string, episodeId: string): boolean {
    const result = this.db
      .delete(schema.appMemory)
      .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, episodeId)))
      .run();
    return result.changes > 0;
  }

  /** Wipe an app's memory of a given source (used on re-seed). */
  deleteForApp(
    workspaceId: string,
    appId: string,
    source?: MemoryEpisode['source'],
  ): number {
    const where = source
      ? and(
          eq(schema.appMemory.workspaceId, workspaceId),
          eq(schema.appMemory.appId, appId),
          eq(schema.appMemory.source, source),
        )
      : and(
          eq(schema.appMemory.workspaceId, workspaceId),
          eq(schema.appMemory.appId, appId),
        );
    return this.db.delete(schema.appMemory).where(where).run().changes;
  }

  byId(workspaceId: string, episodeId: string): MemoryEpisode | null {
    const row = this.db
      .select()
      .from(schema.appMemory)
      .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, episodeId)))
      .get();
    return row ? rowToEpisode(row) : null;
  }

  list(args: MemoryListArgs): MemoryEpisode[] {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    let query = this.db
      .select()
      .from(schema.appMemory)
      .where(
        and(
          eq(schema.appMemory.workspaceId, args.workspaceId),
          eq(schema.appMemory.appId, args.appId),
          ...(args.kind ? [eq(schema.appMemory.kind, args.kind)] : []),
          ...(args.source ? [eq(schema.appMemory.source, args.source)] : []),
        ),
      )
      .orderBy(desc(schema.appMemory.updatedAt))
      .limit(limit)
      .$dynamic();
    const rows = query.all();
    let episodes = rows.map(rowToEpisode);
    if (args.minTrust !== undefined) {
      episodes = episodes.filter((e) => e.trust >= args.minTrust!);
    }
    return episodes;
  }

  /**
   * Recall — returns the most relevant episodes within a budget.
   *
   * Scoring is intentionally simple and explainable:
   *
   *   score = trust × importance × recencyDecay × hintMatch
   *
   * - hintMatch = 1.0 baseline; 1.4 if any hint token appears in title/content.
   * - recencyDecay = 1.0 for ≤ 7 days, 0.85 for 7–30 days, 0.7 for older.
   *   Reinforcement resets the clock.
   *
   * The whole goal is "what should the agent remember right now" — not a
   * perfect retrieval. Good-enough for V1; replace with embeddings when the
   * knowledge plane gets them.
   */
  recall(args: MemoryRecallArgs): MemoryEpisode[] {
    const limit = Math.min(Math.max(args.limit ?? 12, 1), 50);
    const rows = this.db.select().from(schema.appMemory)
      .where(and(
        eq(schema.appMemory.workspaceId, args.workspaceId),
        eq(schema.appMemory.appId, args.appId),
        ...(args.kinds && args.kinds.length > 0 ? [inArray(schema.appMemory.kind, args.kinds)] : []),
      ))
      .orderBy(desc(schema.appMemory.updatedAt))
      .limit(RECALL_CANDIDATE_LIMIT)
      .all();
    if (rows.length === 0) return [];

    const hintTokens = (args.hint ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 3);
    const now = Date.now();

    const scored = rows
      .map((row) => {
        const ep = rowToEpisode(row);
        const base = ep.trust * (0.5 + ep.importance * 0.5);
        const recency = recencyDecay(now, ep.reinforcedAt ?? ep.updatedAt);
        const text = `${ep.title}\n${ep.content}`.toLowerCase();
        let hintBoost = 1;
        for (const t of hintTokens) {
          if (text.includes(t)) {
            hintBoost = 1.4;
            break;
          }
        }
        return { ep, score: base * recency * hintBoost };
      })

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ ep }) => ep);
  }

  countByApp(workspaceId: string, appId: string): { total: number; byKind: Record<string, number>; bySource: Record<string, number> } {
    const rowsByKind = this.db
      .select({ kind: schema.appMemory.kind, count: sql<number>`count(*)` })
      .from(schema.appMemory)
      .where(
        and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.appId, appId)),
      )
      .groupBy(schema.appMemory.kind)
      .all();
    const rowsBySource = this.db
      .select({ source: schema.appMemory.source, count: sql<number>`count(*)` })
      .from(schema.appMemory)
      .where(
        and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.appId, appId)),
      )
      .groupBy(schema.appMemory.source)
      .all();
    let total = 0;
    const byKind: Record<string, number> = {};
    for (const r of rowsByKind) {
      const c = Number(r.count) || 0;
      byKind[r.kind] = c;
      total += c;
    }
    const bySource: Record<string, number> = {};
    for (const r of rowsBySource) {
      bySource[r.source] = Number(r.count) || 0;
    }
    return { total, byKind, bySource };
  }
}

// ────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────

function rowToEpisode(row: typeof schema.appMemory.$inferSelect): MemoryEpisode {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    appId: row.appId,
    kind: row.kind as MemoryEpisode['kind'],
    source: row.source as MemoryEpisode['source'],
    title: row.title,
    content: row.content,
    trust: Number(row.trust),
    importance: Number(row.importance),
    tags: parseJsonArray<string>(row.tags),
    provenance: parseJsonRecord(row.provenance),
    reinforcedAt: row.reinforcedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
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
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function recencyDecay(now: number, atIso: string): number {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return 0.7;
  const ageDays = (now - at) / (1000 * 60 * 60 * 24);
  if (ageDays <= 7) return 1.0;
  if (ageDays <= 30) return 0.85;
  return 0.7;
}
