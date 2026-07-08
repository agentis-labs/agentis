/**
 * MemoryStore — typed workspace-memory FACADE over the unified substrate.
 *
 * Brain 10x §B4: the standalone `workspace_memory` table was retired. Typed
 * workspace memory (facts / preferences / patterns / rules / lessons) now lives
 * in the canonical `memory_episodes` table like every other durable atom, tagged
 * with the `plane:workspace_memory` discriminator. This class keeps the old
 * ergonomic API (write/list/countByScope/…) and the kind/source contract the
 * routes + UI depend on, reconstructing `kind`/`source` from episode metadata —
 * but there is now ONE physical store, one retriever, one decay lifecycle.
 *
 *   - Knowledge is retrieved (you fetch the right paragraph for the question).
 *   - Memory is recalled (you remember the rule that always applies).
 *
 * Sources: seed (packaged) · operator (UI-edited) · promotion (IntelligencePromotion).
 * Kinds: fact · preference · pattern · rule · lesson.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CreateRuntimeEpisodeInput, MemoryEpisode, RuntimeEpisode, RuntimeEpisodeType } from '@agentis/core';
import type { Logger } from '../../logger.js';
import { EpisodicMemoryStore } from '../episodicMemoryStore.js';

export interface MemoryWriteInput {
  workspaceId: string;
  scopeId: string | null;
  kind: MemoryEpisode['kind'];
  source: MemoryEpisode['source'];
  title: string;
  content: string;
  /**
   * Long-form body stored in the episode `details` column. For a `skill` atom
   * this is the full SKILL.md body (the procedure); `content` holds only the
   * short description that gets embedded for search. Keeps the searchable
   * surface cheap while the full procedure travels with the atom.
   */
  details?: string | null;
  trust?: number;
  importance?: number;
  tags?: string[];
  provenance?: Record<string, unknown>;
  /** §B7.3 — scope-affinity links (workflow/node ids this memory applies to). */
  appliesTo?: string[];
}

export interface MemoryListArgs {
  workspaceId: string;
  scopeId: string | null;
  kind?: MemoryEpisode['kind'];
  source?: MemoryEpisode['source'];
  /** Only episodes at or above this trust. */
  minTrust?: number;
  /** Default 50, max 200. */
  limit?: number;
  /** Which plane to list. Defaults to workspace memory; pass `skill_library`
   * to list `skill`/`example` atoms. */
  plane?: typeof WORKSPACE_MEMORY_PLANE | typeof SKILL_LIBRARY_PLANE;
}

/** Discriminator tag marking an episode as a typed workspace-memory row. */
export const WORKSPACE_MEMORY_PLANE = 'workspace_memory';
/**
 * Skill-library plane: `skill` (a procedure) + `example` (its demonstrations).
 * These ride the same episode substrate but on a SEPARATE plane so they never
 * surface in the always-inject dispatch tier (the `episode` branch of
 * `loadAtoms` excludes this plane). They are reached via search / skill
 * materialization instead. See Living Skills.
 */
export const SKILL_LIBRARY_PLANE = 'skill_library';
const PLANE_TAG = `plane:${WORKSPACE_MEMORY_PLANE}`;
const SKILL_LIBRARY_PLANE_TAG = `plane:${SKILL_LIBRARY_PLANE}`;

/** Which plane a typed-memory `kind` belongs to. */
function planeForKind(kind: MemoryEpisode['kind']): { plane: string; tag: string } {
  return kind === 'skill' || kind === 'example'
    ? { plane: SKILL_LIBRARY_PLANE, tag: SKILL_LIBRARY_PLANE_TAG }
    : { plane: WORKSPACE_MEMORY_PLANE, tag: PLANE_TAG };
}

/** Typed-memory `kind` → canonical episode `type`. Real kind kept in metadata. */
const KIND_TO_TYPE: Record<string, RuntimeEpisodeType> = {
  fact: 'observation',
  preference: 'decision',
  pattern: 'success_pattern',
  rule: 'decision',
  lesson: 'distilled_lesson',
  // Skill-library kinds ride durable canonical types (never 'observation',
  // which decays as an unconsolidated trace).
  skill: 'decision',
  example: 'success_pattern',
};
/** Typed-memory `source` → canonical episode `source`. Real source kept in metadata. */
const MEM_SOURCE_TO_EPISODE: Record<string, CreateRuntimeEpisodeInput['source']> = {
  seed: 'seed',
  operator: 'operator_write',
  promotion: 'run_promotion',
  agent: 'agent_write',
  system: 'system_write',
};

export class MemoryStore {
  #episodes: EpisodicMemoryStore | null = null;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {
    void this.logger;
  }

  /** §B4 — wire the canonical episode store (constructed later in bootstrap). */
  setEpisodicStore(store: EpisodicMemoryStore): void {
    this.#episodes = store;
  }

  private get episodes(): EpisodicMemoryStore {
    // Production wires a resolver-backed store via setEpisodicStore; if a caller
    // (e.g. a unit test) constructs MemoryStore standalone, lazily self-construct
    // a functional store over the same db so the facade is always usable.
    if (!this.#episodes) this.#episodes = new EpisodicMemoryStore(this.db, this.logger);
    return this.#episodes;
  }

  /** Insert one typed-memory atom into the unified substrate; returns the new id. */
  write(input: MemoryWriteInput): string {
    const trust = clamp01(input.trust ?? (input.source === 'seed' ? 0.9 : 0.7));
    const importance = clamp01(input.importance ?? 0.5);
    const { plane, tag: planeTag } = planeForKind(input.kind);
    // Skill-library atoms are NEVER constitutional/always-inject — a skill is a
    // procedure discovered on demand, not a hard rule injected every turn.
    const governing = plane === WORKSPACE_MEMORY_PLANE
      && input.source === 'operator'
      && (input.kind === 'rule' || importance >= 0.8 || (input.tags ?? []).includes('charter'));
    // Built as a variable (not an object literal at the call site) so the extra
    // `governing` field — read by the store via a cast — isn't excess-property-checked.
    const writeInput = {
      workspaceId: input.workspaceId,
      scopeId: input.scopeId ?? null,
      type: KIND_TO_TYPE[input.kind] ?? 'observation',
      title: input.title,
      summary: input.content,
      details: input.details ?? null,
      source: MEM_SOURCE_TO_EPISODE[input.source] ?? 'system_write',
      confidence: trust,
      importance,
      trust,
      tags: [...(input.tags ?? []), planeTag],
      metadata: {
        plane,
        memoryKind: input.kind,
        memorySource: input.source,
        provenance: input.provenance ?? {},
      },
      governing,
      appliesTo: input.appliesTo ?? [],
    } as unknown as CreateRuntimeEpisodeInput;
    return this.episodes.write(writeInput).id;
  }

  writeMany(inputs: MemoryWriteInput[]): string[] {
    return inputs.map((i) => this.write(i));
  }

  /** Reinforce an existing atom — bumps trust + reinforcedAt. */
  reinforce(workspaceId: string, episodeId: string, deltaTrust = 0.05): MemoryEpisode | null {
    if (!this.#isPlaneRow(workspaceId, episodeId)) return null;
    const updated = this.episodes.reinforce(workspaceId, episodeId, { trustDelta: deltaTrust, confidenceDelta: deltaTrust });
    return updated ? toMemoryEpisode(updated) : null;
  }

  /** Update operator-editable fields. Does not allow source/kind changes. */
  update(
    workspaceId: string,
    scopeId: string | null,
    episodeId: string,
    patch: Partial<Pick<MemoryEpisode, 'title' | 'content' | 'trust' | 'importance' | 'tags'>>,
  ): MemoryEpisode | null {
    const existing = this.byId(workspaceId, episodeId);
    if (!existing || (scopeId !== undefined && existing.scopeId !== (scopeId ?? null))) return null;
    const set: Parameters<EpisodicMemoryStore['update']>[2] = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.content !== undefined) set.summary = patch.content;
    if (patch.trust !== undefined) set.trust = clamp01(patch.trust);
    if (patch.importance !== undefined) set.importance = clamp01(patch.importance);
    if (patch.tags !== undefined) set.tags = [...patch.tags, PLANE_TAG];
    const updated = this.episodes.update(workspaceId, episodeId, set);
    return updated ? toMemoryEpisode(updated) : null;
  }

  delete(workspaceId: string, scopeId: string | null, episodeId: string): boolean {
    const existing = this.byId(workspaceId, episodeId);
    if (!existing || (scopeId !== undefined && existing.scopeId !== (scopeId ?? null))) return false;
    return this.episodes.delete(workspaceId, episodeId);
  }

  byId(workspaceId: string, episodeId: string): MemoryEpisode | null {
    const ep = this.episodes.byId(workspaceId, episodeId);
    if (!ep || !hasPlaneTag(ep.tags)) return null;
    return toMemoryEpisode(ep);
  }

  list(args: MemoryListArgs): MemoryEpisode[] {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const planeTag = args.plane === SKILL_LIBRARY_PLANE ? SKILL_LIBRARY_PLANE_TAG : PLANE_TAG;
    const rows = this.#planeRows(args.workspaceId, args.scopeId, planeTag);
    let episodes = rows.map(toMemoryEpisode);
    if (args.kind) episodes = episodes.filter((e) => e.kind === args.kind);
    if (args.source) episodes = episodes.filter((e) => e.source === args.source);
    if (args.minTrust !== undefined) episodes = episodes.filter((e) => e.trust >= args.minTrust!);
    return episodes.slice(0, limit);
  }

  countByScope(workspaceId: string, scopeId: string | null): { total: number; byKind: Record<string, number>; bySource: Record<string, number> } {
    const rows = this.#planeRows(workspaceId, scopeId).map(toMemoryEpisode);
    const byKind: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const r of rows) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    }
    return { total: rows.length, byKind, bySource };
  }

  /** Active plane rows for a workspace/scope, newest first. */
  #planeRows(workspaceId: string, scopeId: string | null, planeTag: string = PLANE_TAG): RuntimeEpisode[] {
    const conds = [
      eq(schema.memoryEpisodes.workspaceId, workspaceId),
      isNull(schema.memoryEpisodes.archivedAt),
      scopeId == null ? isNull(schema.memoryEpisodes.scopeId) : eq(schema.memoryEpisodes.scopeId, scopeId),
    ];
    return this.db.select().from(schema.memoryEpisodes)
      .where(and(...conds))
      .orderBy(desc(schema.memoryEpisodes.updatedAt))
      .limit(1000)
      .all()
      .map(rowToRuntimeEpisode)
      .filter((ep) => ep.tags.includes(planeTag));
  }

  #isPlaneRow(workspaceId: string, episodeId: string): boolean {
    const ep = this.episodes.byId(workspaceId, episodeId);
    return Boolean(ep && hasPlaneTag(ep.tags));
  }
}

/** True when an episode belongs to any MemoryStore-managed plane. */
function hasPlaneTag(tags: string[]): boolean {
  return tags.includes(PLANE_TAG) || tags.includes(SKILL_LIBRARY_PLANE_TAG);
}

// ────────────────────────────────────────────────────────────
// Mapping helpers — episode ⇆ typed MemoryEpisode
// ────────────────────────────────────────────────────────────

/** Reconstruct the typed MemoryEpisode contract from a canonical episode. */
function toMemoryEpisode(ep: RuntimeEpisode): MemoryEpisode {
  const meta = ep.metadata ?? {};
  const kind = (typeof meta.memoryKind === 'string' ? meta.memoryKind : 'lesson') as MemoryEpisode['kind'];
  const source = (typeof meta.memorySource === 'string' ? meta.memorySource : 'system') as MemoryEpisode['source'];
  const provenance = meta.provenance && typeof meta.provenance === 'object' && !Array.isArray(meta.provenance)
    ? meta.provenance as Record<string, unknown>
    : {};
  return {
    id: ep.id,
    workspaceId: ep.workspaceId,
    scopeId: ep.scopeId ?? null,
    kind,
    source,
    title: ep.title,
    content: ep.summary,
    trust: ep.trust,
    importance: ep.importance,
    tags: ep.tags.filter((t) => t !== PLANE_TAG && t !== SKILL_LIBRARY_PLANE_TAG),
    provenance,
    reinforcedAt: ep.reinforcedAt ?? null,
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
  };
}

/** Minimal row → RuntimeEpisode for the direct-query read paths. */
function rowToRuntimeEpisode(row: typeof schema.memoryEpisodes.$inferSelect): RuntimeEpisode {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scopeId: row.scopeId,
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
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
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
