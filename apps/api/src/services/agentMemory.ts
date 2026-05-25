/**
 * AgentMemoryService — the personal Brain of a single agent (§G11).
 *
 * The Brain has four memory scopes. Three are shared or contextual:
 *   - workspace MEMORY.md   — the collective log every agent inherits
 *   - workflow_kv_entries   — state scoped to one workflow's runs
 *   - knowledge bases       — shared indexed documents
 * This is the fourth: memory that belongs to *one agent* and travels with it
 * across every workflow and chat it ever runs. A researcher that investigates
 * competitors over months builds personal expertise here that compounds
 * independently of the workspace-wide log.
 *
 * Storage is lexical (same BM25-ish scorer the knowledge layer uses) so V1 needs
 * no embedding provider.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

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
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Record one memory for an agent. Returns the stored entry. */
  append(args: AppendAgentMemoryArgs): AgentMemoryEntry {
    const row = {
      id: randomUUID(),
      agentId: args.agentId,
      workspaceId: args.workspaceId,
      section: (args.section ?? 'Notes').trim() || 'Notes',
      content: args.content.trim(),
      tags: args.tags ?? [],
      createdAt: new Date().toISOString(),
    };
    this.db.insert(schema.agentMemories).values(row).run();
    return row;
  }

  /** All entries for an agent, newest first. `limit` caps the result. */
  list(agentId: string, workspaceId: string, limit = 200): AgentMemoryEntry[] {
    return this.db
      .select()
      .from(schema.agentMemories)
      .where(and(eq(schema.agentMemories.agentId, agentId), eq(schema.agentMemories.workspaceId, workspaceId)))
      .orderBy(desc(schema.agentMemories.createdAt))
      .limit(limit)
      .all()
      .map(toEntry);
  }

  /** Count of an agent's stored memories. */
  countByAgent(agentId: string, workspaceId: string): number {
    return this.list(agentId, workspaceId, 100_000).length;
  }

  /** Workspace-wide totals + per-agent counts, for the Brain overview. */
  statsByWorkspace(workspaceId: string): { total: number; byAgent: Array<{ agentId: string; count: number }> } {
    const rows = this.db
      .select({ agentId: schema.agentMemories.agentId })
      .from(schema.agentMemories)
      .where(eq(schema.agentMemories.workspaceId, workspaceId))
      .all();
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
      .delete(schema.agentMemories)
      .where(and(
        eq(schema.agentMemories.id, id),
        eq(schema.agentMemories.agentId, agentId),
        eq(schema.agentMemories.workspaceId, workspaceId),
      ))
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Wipe an agent's entire memory. Returns the number of entries removed. */
  clear(agentId: string, workspaceId: string): number {
    const result = this.db
      .delete(schema.agentMemories)
      .where(and(eq(schema.agentMemories.agentId, agentId), eq(schema.agentMemories.workspaceId, workspaceId)))
      .run();
    return Number(result.changes ?? 0);
  }
}

function toEntry(row: typeof schema.agentMemories.$inferSelect): AgentMemoryEntry {
  return {
    id: row.id,
    agentId: row.agentId,
    workspaceId: row.workspaceId,
    section: row.section,
    content: row.content,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    createdAt: row.createdAt,
  };
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
