/**
 * AgentMemoryService — the personal Brain of a single agent (§G11).
 *
 * Agent-private memory is the slice of the workspace brain scoped to one agent:
 * it travels with that agent across every workflow and chat it runs. A
 * researcher that investigates competitors over months builds personal
 * expertise here that compounds independently of the workspace-wide log.
 *
 * There is exactly ONE durable store for it: the canonical `memory_episodes`
 * table, with `scope_id = agentId`. This service is the agent-scoped view over
 * that store — so an agent's explicit notes (`memory_append scope:agent`), its
 * failure reflections, AND the lessons auto-promoted from its successful runs
 * (`scopeId = agentId` promotion) all land in the same place and are retrieved
 * by the same dispatch context the rest of the brain uses. The old standalone
 * `agent_memories` table was retired (migration v51) to remove that
 * duplication.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { BrainGraph } from '@agentis/core';
import type { EpisodicMemoryStore } from '../episodicMemoryStore.js';

export interface AgentMemoryEntry {
  id: string;
  agentId: string;
  workspaceId: string;
  section: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface AppendAgentMemoryArgs {
  agentId: string;
  workspaceId: string;
  section?: string;
  content: string;
  tags?: string[];
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'it', 'this', 'that', 'as', 'at', 'by', 'from',
]);

export class AgentMemoryService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly episodes: EpisodicMemoryStore,
  ) {}

  /** Record one memory for an agent. Returns the stored entry. */
  append(args: AppendAgentMemoryArgs): AgentMemoryEntry {
    const section = (args.section ?? 'Notes').trim() || 'Notes';
    const content = args.content.trim();
    const episode = this.episodes.write({
      workspaceId: args.workspaceId,
      scopeId: args.agentId,
      agentId: args.agentId,
      type: 'distilled_lesson',
      title: section,
      summary: content,
      source: 'agent_write',
      confidence: 0.7,
      importance: 0.6,
      trust: 0.7,
      tags: ['agent_private', ...(args.tags ?? [])],
      metadata: { section, privateScope: 'agent' },
    });
    return {
      id: episode.id,
      agentId: args.agentId,
      workspaceId: args.workspaceId,
      section,
      content,
      tags: args.tags ?? [],
      createdAt: episode.createdAt,
    };
  }

  /** All entries for an agent, newest first. `limit` caps the result. */
  list(agentId: string, workspaceId: string, limit = 200): AgentMemoryEntry[] {
    return this.#rows(agentId, workspaceId, limit).map((row) => toEntry(row, agentId, workspaceId));
  }

  /** Count of an agent's stored memories. */
  countByAgent(agentId: string, workspaceId: string): number {
    return this.#rows(agentId, workspaceId, 100_000).length;
  }

  /** Workspace-wide totals + per-agent counts, for the Brain overview. */
  statsByWorkspace(workspaceId: string): { total: number; byAgent: Array<{ agentId: string; count: number }> } {
    const rows = this.db
      .select({ agentId: schema.memoryEpisodes.agentId, scopeId: schema.memoryEpisodes.scopeId })
      .from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), isNull(schema.memoryEpisodes.archivedAt)))
      .all()
      // Agent-private = scoped to that same agent. Excludes workspace-global
      // and team-scoped episodes.
      .filter((r): r is { agentId: string; scopeId: string } => !!r.agentId && r.scopeId === r.agentId);
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.agentId, (counts.get(r.agentId) ?? 0) + 1);
    return {
      total: rows.length,
      byAgent: [...counts.entries()].map(([agentId, count]) => ({ agentId, count })).sort((a, b) => b.count - a.count),
    };
  }

  /**
   * Lexical search across one agent's memories. Returns ranked hits. Used by the
   * `agent_memory_search` tool so an agent can recall its own prior findings.
   */
  search(agentId: string, workspaceId: string, query: string, topK = 5): Array<AgentMemoryEntry & { score: number }> {
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return [];
    const k = Math.max(1, Math.min(topK, 20));
    return this.list(agentId, workspaceId, 1000)
      .map((entry) => ({ ...entry, score: scoreText(queryTokens, `${entry.section} ${entry.content}`) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /**
   * The most recent entries, formatted as a context-block section. Returns an
   * empty string when the agent has no memory so callers never emit an empty
   * header. Best-effort: this never throws.
   */
  contextSection(agentId: string, workspaceId: string, maxEntries = 8): string {
    try {
      const entries = this.list(agentId, workspaceId, maxEntries);
      if (!entries.length) return '';
      const lines = entries.map((e) => `- ${e.content.replace(/\s+/g, ' ').trim().slice(0, 400)}${e.section ? ` _(${e.section.toLowerCase()})_` : ''}`);
      return `## Agent Memory — what you have learned across past tasks\n${lines.join('\n')}`;
    } catch {
      return '';
    }
  }

  /** Delete a single entry (returns true when a row was removed). */
  remove(id: string, agentId: string, workspaceId: string): boolean {
    const result = this.db
      .delete(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.id, id),
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        eq(schema.memoryEpisodes.scopeId, agentId),
      ))
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Wipe an agent's entire private memory. Returns the number of entries removed. */
  clear(agentId: string, workspaceId: string): number {
    const result = this.db
      .delete(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        eq(schema.memoryEpisodes.scopeId, agentId),
        eq(schema.memoryEpisodes.agentId, agentId),
      ))
      .run();
    return Number(result.changes ?? 0);
  }

  /** Active, agent-private episode rows (scoped to the agent), newest first. */
  #rows(agentId: string, workspaceId: string, limit: number): Array<typeof schema.memoryEpisodes.$inferSelect> {
    return this.db
      .select()
      .from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        eq(schema.memoryEpisodes.scopeId, agentId),
        isNull(schema.memoryEpisodes.archivedAt),
      ))
      .orderBy(desc(schema.memoryEpisodes.createdAt))
      .limit(limit)
      .all()
      .filter((row) => row.status !== 'archived');
  }

  graph(agentId: string, workspaceId: string, agentName = 'Agent brain'): BrainGraph {
    const entries = this.list(agentId, workspaceId);
    const now = new Date().toISOString();
    return {
      nodes: [
        {
          id: 'core',
          atomId: 'core',
          atomKind: 'core',
          label: agentName,
          summary: 'Private expertise and lessons accumulated by this agent.',
          confidence: 1,
          trust: 1,
          reinforceCount: 1,
          createdAt: now,
          updatedAt: now,
          metadata: { scope: 'agent', agentId },
        },
        ...entries.map((entry) => ({
          id: `memory:${entry.id}`,
          atomId: entry.id,
          atomKind: 'memory' as const,
          label: entry.section,
          summary: entry.content.slice(0, 180),
          confidence: 0.8,
          trust: 0.8,
          reinforceCount: 1,
          agentId,
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
          metadata: { tags: entry.tags, privateScope: 'agent' },
        })),
      ],
      links: entries.map((entry) => ({
        id: `agent-memory-core:${entry.id}`,
        source: `memory:${entry.id}`,
        target: 'core',
        sourceAtomId: entry.id,
        sourceKind: 'memory' as const,
        targetAtomId: 'core',
        targetKind: 'memory' as const,
        relation: 'derived_from' as const,
        confidence: 0.76,
        reinforceCount: 1,
        agentId,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
      })),
      meta: {
        workspaceId,
        scope: 'scoped',
        scopeId: agentId,
        atomCount: entries.length,
        linkCount: entries.length,
        lastActivityAt: entries[0]?.createdAt ?? null,
        adapterTypes: [],
      },
    };
  }

  detail(agentId: string, workspaceId: string, graphNodeId: string, agentName = 'Agent brain') {
    const graph = this.graph(agentId, workspaceId, agentName);
    const node = graph.nodes.find((candidate) => candidate.id === graphNodeId || candidate.atomId === graphNodeId);
    if (!node) return null;
    const links = graph.links.filter((link) => link.source === node.id || link.target === node.id);
    const relatedIds = new Set(links.map((link) => link.source === node.id ? link.target : link.source));
    const entry = node.atomKind === 'memory'
      ? this.list(agentId, workspaceId).find((candidate) => candidate.id === node.atomId) ?? null
      : null;
    return {
      node,
      links,
      relatedNodes: graph.nodes.filter((candidate) => relatedIds.has(candidate.id)),
      content: entry?.content ?? node.summary ?? '',
      provenance: {
        createdBy: agentName,
        agentId,
        createdAt: entry?.createdAt ?? node.createdAt,
        updatedAt: entry?.createdAt ?? node.updatedAt,
        source: entry ? 'Agent memory' : 'Agent Brain',
        reinforced: node.reinforceCount,
      },
      usedBy: entry ? [{ id: agentId, type: 'agent' as const, name: agentName, count: 1 }] : [],
    };
  }
}

/** Map an agent-scoped episode row to the agent-memory entry shape. */
function toEntry(row: typeof schema.memoryEpisodes.$inferSelect, agentId: string, workspaceId: string): AgentMemoryEntry {
  const metadata = parseRecord(row.metadata);
  const section = typeof metadata.section === 'string' && metadata.section.trim() ? metadata.section : row.title;
  return {
    id: row.id,
    agentId,
    workspaceId,
    section,
    content: row.summary,
    tags: parseArray(row.tags),
    createdAt: row.createdAt,
  };
}

function parseArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  if (typeof raw !== 'string') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function parseRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

/** Token-overlap score, length-normalised so long entries don't dominate. */
function scoreText(queryTokens: Set<string>, text: string): number {
  const docTokens = tokenize(text);
  if (docTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) if (docTokens.has(token)) overlap += 1;
  return overlap === 0 ? 0 : overlap / Math.sqrt(docTokens.size);
}
