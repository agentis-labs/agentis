/**
 * AgentAbilityService — BRAIN-ABILITIES-REPLAN.md Part IV.
 *
 * Owns the `agent_abilities` table: procedural how-to documents that an agent
 * role accumulates and refines. Responsibilities:
 *
 *   1. CRUD — operator-authored abilities (Path 2).
 *   2. Relevance query — top-N active abilities for a dispatched task,
 *      ranked by embedding cosine similarity (used by WorkflowEngine).
 *   3. Versioning — every patch creates a NEW immutable row; the previous
 *      row transitions to `superseded`. Full rollback is supported.
 *   4. `upsertFromReview` — the background reviewer's write path.
 *   5. Package seeding (Path 3 / U8).
 *
 * Distinct from `skills` (executable code) and brain atoms (world facts).
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, or, isNull } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type AgentAbility,
  type AbilityAssertion,
  type AbilitySource,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import {
  type EmbeddingProvider,
  cosineSimilarity,
  embedText,
  selectEmbeddingProvider,
} from './embeddingProvider.js';

type AbilityRow = typeof schema.agentAbilities.$inferSelect;

/** Minimum cosine relevance for an ability to be injected at dispatch. */
const DISPATCH_MIN_RELEVANCE = 0.3;
const DEFAULT_DISPATCH_LIMIT = 3;
const MAX_DISPATCH_LIMIT = 8;
/** Cosine similarity above which the reviewer patches rather than forks. */
const REVIEW_MATCH_THRESHOLD = 0.8;

export interface AbilityScope {
  agentId?: string | null;
  workflowId?: string | null;
  teamRole?: string | null;
}

export interface CreateAbilityInput extends AbilityScope {
  workspaceId: string;
  title: string;
  content: string;
  tags?: string[];
  confidence?: number;
  source?: AbilitySource;
  managed?: boolean;
  assertions?: AbilityAssertion[];
  derivedFromPackage?: string | null;
  derivedFromRunIds?: string[];
}

export class AgentAbilityService {
  readonly #embeddingProviders = new Map<string, EmbeddingProvider>();

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  // ── reads ───────────────────────────────────────────────────

  /** List abilities for an agent (and its team-scoped workflow abilities). */
  list(
    workspaceId: string,
    scope: AbilityScope & { includeSuperseded?: boolean },
  ): AgentAbility[] {
    const rows = this.db.select().from(schema.agentAbilities)
      .where(and(
        eq(schema.agentAbilities.workspaceId, workspaceId),
        this.#scopeFilter(scope),
      ))
      .orderBy(desc(schema.agentAbilities.confidence))
      .all();
    return rows
      .filter((row) => scope.includeSuperseded || row.status !== 'superseded')
      .map(rowToAbility);
  }

  get(workspaceId: string, id: string): AgentAbility | null {
    const row = this.db.select().from(schema.agentAbilities)
      .where(and(eq(schema.agentAbilities.workspaceId, workspaceId), eq(schema.agentAbilities.id, id)))
      .get();
    return row ? rowToAbility(row) : null;
  }

  /** Full version history for an ability lineage (newest first). */
  history(workspaceId: string, id: string): AgentAbility[] {
    const head = this.get(workspaceId, id);
    if (!head) return [];
    const chain: AgentAbility[] = [head];
    let cursor = head.parentAbilityId;
    const guard = new Set<string>([head.id]);
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      const prev = this.get(workspaceId, cursor);
      if (!prev) break;
      chain.push(prev);
      cursor = prev.parentAbilityId;
    }
    return chain;
  }

  // ── writes ──────────────────────────────────────────────────

  /** Create a fresh ability (operator write or package seed). */
  async create(input: CreateAbilityInput): Promise<AgentAbility> {
    if (!input.agentId && !input.workflowId) {
      throw new Error('ability requires agentId or workflowId');
    }
    const source = input.source ?? 'operator_write';
    const managed = input.managed ?? (source !== 'operator_write');
    const row = await this.#insertRow({
      workspaceId: input.workspaceId,
      agentId: input.agentId ?? null,
      workflowId: input.workflowId ?? null,
      teamRole: input.teamRole ?? null,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      version: 1,
      parentAbilityId: null,
      changelog: [`v1 — created (${source})`],
      confidence: clamp01(input.confidence ?? 0.5),
      source,
      managed,
      assertions: input.assertions ?? [],
      derivedFromPackage: input.derivedFromPackage ?? null,
      derivedFromRunIds: input.derivedFromRunIds ?? [],
      status: 'active',
    });
    this.#publish(REALTIME_EVENTS.ABILITY_CREATED, row);
    return rowToAbility(row);
  }

  /**
   * Patch an ability — creates a NEW version row, supersedes the old one.
   * Never mutates a superseded row (preserves the audit trail).
   */
  async patch(
    workspaceId: string,
    id: string,
    patch: { title?: string; content?: string; tags?: string[]; confidence?: number; changeNote?: string },
    options: { source?: AbilitySource } = {},
  ): Promise<AgentAbility | null> {
    const current = this.db.select().from(schema.agentAbilities)
      .where(and(eq(schema.agentAbilities.workspaceId, workspaceId), eq(schema.agentAbilities.id, id)))
      .get();
    if (!current) return null;

    const now = new Date().toISOString();
    const note = patch.changeNote ?? 'updated';
    const nextVersion = (current.version ?? 1) + 1;
    const changelog = [`v${current.version}→v${nextVersion}: ${note}`, ...parseJsonArray<string>(current.changelog)];

    const row = await this.#insertRow({
      workspaceId,
      agentId: current.agentId,
      workflowId: current.workflowId,
      teamRole: current.teamRole,
      title: patch.title ?? current.title,
      content: patch.content ?? current.content,
      tags: patch.tags ?? parseJsonArray<string>(current.tags),
      version: nextVersion,
      parentAbilityId: current.id,
      changelog,
      confidence: clamp01(patch.confidence ?? Number(current.confidence)),
      source: options.source ?? 'operator_write',
      managed: Boolean(current.managed),
      assertions: parseJsonArray<AbilityAssertion>(current.assertions),
      derivedFromPackage: current.derivedFromPackage,
      derivedFromRunIds: parseJsonArray<string>(current.derivedFromRunIds),
      status: 'active',
      reinforceCount: (current.reinforceCount ?? 0) + 1,
    });
    // Old row → superseded, never injected again.
    this.db.update(schema.agentAbilities)
      .set({ status: 'superseded', updatedAt: now })
      .where(eq(schema.agentAbilities.id, current.id))
      .run();
    this.#publish(REALTIME_EVENTS.ABILITY_UPDATED, row);
    return rowToAbility(row);
  }

  /** Archive an ability (recoverable — never a hard delete for managed rows). */
  archive(workspaceId: string, id: string): boolean {
    const changes = this.db.update(schema.agentAbilities)
      .set({ status: 'archived', updatedAt: new Date().toISOString() })
      .where(and(eq(schema.agentAbilities.workspaceId, workspaceId), eq(schema.agentAbilities.id, id)))
      .run().changes;
    return changes > 0;
  }

  /** Pin / unpin — pinned abilities are exempt from auto-decay. */
  setPinned(workspaceId: string, id: string, pinned: boolean): boolean {
    const changes = this.db.update(schema.agentAbilities)
      .set({ pinnedAt: pinned ? new Date().toISOString() : null, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.agentAbilities.workspaceId, workspaceId), eq(schema.agentAbilities.id, id)))
      .run().changes;
    return changes > 0;
  }

  /**
   * Roll back to a prior version — creates a new `operator_rollback` row from
   * the target's content so the audit trail is preserved.
   */
  async rollback(workspaceId: string, targetVersionId: string): Promise<AgentAbility | null> {
    const target = this.get(workspaceId, targetVersionId);
    if (!target) return null;
    // Find the current head of this lineage (the active row).
    const active = this.list(workspaceId, {
      agentId: target.agentId,
      workflowId: target.workflowId,
      teamRole: target.teamRole,
    }).find((a) => a.title === target.title && a.status === 'active');
    if (active) {
      return this.patch(workspaceId, active.id, {
        title: target.title,
        content: target.content,
        tags: target.tags,
        confidence: target.confidence,
        changeNote: `rolled back to v${target.version}`,
      }, { source: 'operator_rollback' });
    }
    return this.create({
      workspaceId,
      agentId: target.agentId,
      workflowId: target.workflowId,
      teamRole: target.teamRole,
      title: target.title,
      content: target.content,
      tags: target.tags,
      confidence: target.confidence,
      source: 'operator_rollback',
    });
  }

  /**
   * Background-reviewer write path. If a semantically similar active ability
   * exists for this scope, patch it (a new version); otherwise create a new
   * ability. Returns the resulting ability and whether it was new.
   */
  async upsertFromReview(input: {
    workspaceId: string;
    agentId?: string | null;
    workflowId?: string | null;
    teamRole?: string | null;
    title: string;
    content: string;
    tags?: string[];
    runId?: string | null;
    changeNote?: string;
  }): Promise<{ ability: AgentAbility; created: boolean }> {
    const existing = this.list(input.workspaceId, {
      agentId: input.agentId,
      workflowId: input.workflowId,
      teamRole: input.teamRole,
    }).filter((a) => a.status === 'active');

    const queryVec = await this.#embed(input.workspaceId, `${input.title}\n${input.content}`);
    let match: AgentAbility | null = null;
    if (queryVec && existing.length > 0) {
      let bestScore = REVIEW_MATCH_THRESHOLD;
      for (const ability of existing) {
        const vec = this.#abilityEmbedding(input.workspaceId, ability.id);
        if (!vec || vec.length !== queryVec.length) continue;
        const score = cosineSimilarity(queryVec, vec);
        if (score >= bestScore) { bestScore = score; match = ability; }
      }
    }

    if (match) {
      const runIds = input.runId
        ? [...new Set([...match.derivedFromRunIds, input.runId])]
        : match.derivedFromRunIds;
      const patched = await this.patch(input.workspaceId, match.id, {
        content: input.content,
        confidence: Math.min(0.95, match.confidence + 0.06),
        changeNote: input.changeNote ?? 'background review refinement',
      }, { source: 'background_review' });
      if (patched) {
        this.db.update(schema.agentAbilities)
          .set({ derivedFromRunIds: runIds, reinforceCount: patched.reinforceCount })
          .where(eq(schema.agentAbilities.id, patched.id))
          .run();
        this.#publish(REALTIME_EVENTS.ABILITY_REINFORCED, this.#rawRow(patched.id)!);
        return { ability: { ...patched, derivedFromRunIds: runIds }, created: false };
      }
    }

    const ability = await this.create({
      workspaceId: input.workspaceId,
      agentId: input.agentId ?? null,
      workflowId: input.workflowId ?? null,
      teamRole: input.teamRole ?? null,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      confidence: 0.55,
      source: 'background_review',
      managed: true,
      derivedFromRunIds: input.runId ? [input.runId] : [],
    });
    return { ability, created: true };
  }

  /**
   * Select the top-N relevant active abilities for a dispatched task and
   * render them as a frozen injection block. Bumps `usageCount`/`lastUsedAt`.
   */
  async buildDispatchBlock(args: {
    workspaceId: string;
    agentId?: string | null;
    workflowId?: string | null;
    teamRole?: string | null;
    appId?: string | null;
    runId?: string | null;
    taskDescription: string;
    limit?: number;
  }): Promise<{ block: string; abilityIds: string[] }> {
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_DISPATCH_LIMIT, 1), MAX_DISPATCH_LIMIT);
    const candidates = this.list(args.workspaceId, {
      agentId: args.agentId,
      workflowId: args.workflowId,
      teamRole: args.teamRole,
    }).filter((a) => a.status === 'active');
    if (candidates.length === 0) return { block: '', abilityIds: [] };

    let queryVec: number[] | null = null;
    try {
      queryVec = await this.#embed(args.workspaceId, args.taskDescription);
    } catch {
      queryVec = null;
    }

    const ranked = candidates
      .map((ability) => {
        const vec = queryVec ? this.#abilityEmbedding(args.workspaceId, ability.id) : null;
        const score = queryVec && vec && vec.length === queryVec.length
          ? cosineSimilarity(queryVec, vec)
          : lexicalScore(args.taskDescription, `${ability.title} ${ability.content}`);
        return { ability, score };
      })
      .filter((r) => r.score >= DISPATCH_MIN_RELEVANCE)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (ranked.length === 0) return { block: '', abilityIds: [] };

    const now = new Date().toISOString();
    const sections: string[] = [];
    const abilityIds: string[] = [];
    for (const { ability } of ranked) {
      abilityIds.push(ability.id);
      sections.push(`### ${ability.title} [confidence: ${ability.confidence.toFixed(2)}]\n${ability.content.trim()}`);
      this.db.update(schema.agentAbilities)
        .set({ usageCount: ability.usageCount + 1, lastUsedAt: now })
        .where(eq(schema.agentAbilities.id, ability.id))
        .run();
      this.db.insert(schema.brainQualityEvents).values({
        id: randomUUID(),
        workspaceId: args.workspaceId,
        appId: args.appId ?? null,
        agentId: args.agentId ?? null,
        eventType: 'ability_used',
        atomId: null,
        abilityId: ability.id,
        runId: args.runId ?? null,
        delta: null,
        metadata: { score: ranked.find((entry) => entry.ability.id === ability.id)?.score ?? null },
        createdAt: now,
      }).run();
    }
    const header = `AGENT ABILITIES [${ranked.length} loaded — proven procedures, apply them]`;
    return { block: `${header}\n\n${sections.join('\n\n')}`, abilityIds };
  }

  // ── internals ───────────────────────────────────────────────

  #scopeFilter(scope: AbilityScope) {
    const clauses = [];
    if (scope.agentId) {
      clauses.push(eq(schema.agentAbilities.agentId, scope.agentId));
    }
    if (scope.workflowId) {
      clauses.push(and(
        eq(schema.agentAbilities.workflowId, scope.workflowId),
        scope.teamRole
          ? or(isNull(schema.agentAbilities.teamRole), eq(schema.agentAbilities.teamRole, scope.teamRole))
          : isNull(schema.agentAbilities.teamRole),
      ));
    }
    if (clauses.length === 0) {
      // No scope — match nothing rather than everything.
      return eq(schema.agentAbilities.id, '__none__');
    }
    return clauses.length === 1 ? clauses[0]! : or(...clauses)!;
  }

  async #insertRow(values: {
    workspaceId: string;
    agentId: string | null;
    workflowId: string | null;
    teamRole: string | null;
    title: string;
    content: string;
    tags: string[];
    version: number;
    parentAbilityId: string | null;
    changelog: string[];
    confidence: number;
    source: AbilitySource;
    managed: boolean;
    assertions: AbilityAssertion[];
    derivedFromPackage: string | null;
    derivedFromRunIds: string[];
    status: string;
    reinforceCount?: number;
  }): Promise<AbilityRow> {
    const id = randomUUID();
    const now = new Date().toISOString();
    let embedding: number[] | null = null;
    try {
      embedding = await this.#embed(values.workspaceId, `${values.title}\n${values.content}`);
    } catch (err) {
      this.logger.warn('ability.embed_failed', { message: (err as Error).message });
    }
    const row = {
      id,
      workspaceId: values.workspaceId,
      agentId: values.agentId,
      workflowId: values.workflowId,
      teamRole: values.teamRole,
      title: values.title,
      content: values.content,
      tags: values.tags,
      version: values.version,
      parentAbilityId: values.parentAbilityId,
      changelog: values.changelog,
      confidence: values.confidence,
      reinforceCount: values.reinforceCount ?? 0,
      usageCount: 0,
      source: values.source,
      derivedFromPackage: values.derivedFromPackage,
      derivedFromRunIds: values.derivedFromRunIds,
      assertions: values.assertions,
      managed: values.managed,
      status: values.status,
      pinnedAt: null,
      lastUsedAt: null,
      embedding: embedding as unknown as null,
      contextAtoms: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.agentAbilities).values(row).run();
    return row as unknown as AbilityRow;
  }

  #rawRow(id: string): AbilityRow | null {
    return this.db.select().from(schema.agentAbilities)
      .where(eq(schema.agentAbilities.id, id))
      .get() ?? null;
  }

  #abilityEmbedding(workspaceId: string, id: string): number[] | null {
    const row = this.db.select({ embedding: schema.agentAbilities.embedding })
      .from(schema.agentAbilities)
      .where(eq(schema.agentAbilities.id, id))
      .get();
    return parseEmbedding(row?.embedding);
  }

  #publish(event: (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS], row: AbilityRow): void {
    try {
      this.bus.publish(REALTIME_ROOMS.workspace(row.workspaceId), event, {
        workspaceId: row.workspaceId,
        ability: rowToAbility(row),
      });
    } catch {
      // realtime publish is best-effort
    }
  }

  #resolveEmbeddingProvider(workspaceId: string): EmbeddingProvider {
    const cached = this.#embeddingProviders.get(workspaceId);
    if (cached) return cached;
    let type = 'hashing';
    let config: Record<string, unknown> = {};
    try {
      const row = this.db.select({
        type: schema.workspaces.embeddingProviderType,
        config: schema.workspaces.embeddingProviderConfig,
      }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
      if (row?.type) type = row.type;
      if (row?.config && typeof row.config === 'object') config = row.config as Record<string, unknown>;
    } catch {
      // degrade to hashing
    }
    const provider = selectEmbeddingProvider(type, config);
    this.#embeddingProviders.set(workspaceId, provider);
    return provider;
  }

  invalidateEmbeddingProvider(workspaceId: string): void {
    this.#embeddingProviders.delete(workspaceId);
  }

  async #embed(workspaceId: string, text: string): Promise<number[] | null> {
    const provider = this.#resolveEmbeddingProvider(workspaceId);
    return embedText(provider, text);
  }
}

// ── helpers ────────────────────────────────────────────────────

function rowToAbility(row: AbilityRow): AgentAbility {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    workflowId: row.workflowId,
    teamRole: row.teamRole,
    title: row.title,
    content: row.content,
    tags: parseJsonArray<string>(row.tags),
    version: row.version,
    parentAbilityId: row.parentAbilityId,
    changelog: parseJsonArray<string>(row.changelog),
    confidence: Number(row.confidence),
    reinforceCount: row.reinforceCount,
    usageCount: row.usageCount,
    source: row.source as AgentAbility['source'],
    derivedFromPackage: row.derivedFromPackage,
    derivedFromRunIds: parseJsonArray<string>(row.derivedFromRunIds),
    assertions: parseJsonArray<AbilityAssertion>(row.assertions),
    managed: Boolean(row.managed),
    status: row.status as AgentAbility['status'],
    pinnedAt: row.pinnedAt,
    lastUsedAt: row.lastUsedAt,
    contextAtoms: parseJsonArray<string>(row.contextAtoms),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw.every((n) => typeof n === 'number') ? (raw as number[]) : null;
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) && value.every((n) => typeof n === 'number') ? value : null;
  } catch {
    return null;
  }
}

/** Cheap token-overlap score — lexical fallback when embeddings are absent. */
function lexicalScore(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter((t) => t.length > 2));
  const at = tok(a);
  const bt = tok(b);
  if (at.size === 0 || bt.size === 0) return 0;
  let overlap = 0;
  for (const t of at) if (bt.has(t)) overlap += 1;
  return overlap / Math.min(at.size, bt.size);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
