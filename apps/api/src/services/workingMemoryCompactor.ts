/**
 * WorkingMemoryCompactor — Layer 1 evolution.
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md §5.5.
 *
 * Wraps the in-memory `ScratchpadService` with:
 *   - namespacing (run, agent, subflow, turn, eval, artifact, system)
 *   - typed entries (working_plan, working_summary, …)
 *   - compaction (multi-turn tasks shouldn't dump raw turn history forever)
 *   - durable persistence to `working_memory_entries` for important kinds
 *
 * The compactor is also responsible for producing the working summary that
 * Layer 5 retrieval injects at the top of the prompt (§9.5 priority 1).
 *
 * Compaction rules:
 *   - turn_history: keep last 3 turns verbatim, summarise older turns
 *   - tool_result_cache: drop entries older than 10 minutes
 *   - artifact_draft: keep latest version per slot, drop older versions
 *   - blocker / pending_questions: keep only unresolved
 *   - others: untouched
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type {
  WorkingMemoryEntry,
  WorkingMemoryKind,
  WorkingMemoryNamespace,
  WorkingMemorySummary,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { ScratchpadService } from './scratchpad.js';

/** Namespaces whose entries should be persisted to the durable table. */
const DURABLE_NAMESPACES = new Set<WorkingMemoryNamespace>(['run', 'eval', 'artifact']);

/** Kinds that should always be persisted, regardless of namespace. */
const DURABLE_KINDS = new Set<WorkingMemoryKind>([
  'working_plan',
  'working_summary',
  'pending_questions',
  'blocker',
  'artifact_draft',
  'evaluation_state',
]);

/** Tool result cache TTL — drop entries older than this on compaction. */
const TOOL_RESULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** Turn history retention — keep this many recent turns verbatim. */
const TURN_HISTORY_KEEP_RECENT = 3;

export class WorkingMemoryCompactor {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly scratchpad: ScratchpadService,
    private readonly logger: Logger,
    /** Workspace context. Required because durable rows are workspace-scoped. */
    private readonly workspaceResolver: (runId: string) => string | null,
  ) {}

  // ────────────────────────────────────────────────────────────
  // Read / write API
  // ────────────────────────────────────────────────────────────

  /**
   * Compose a scratchpad key from (namespace, kind, key). The legacy
   * scratchpad is a single key→value Map per run, so we encode the structure
   * into the key. `~` is a separator that doesn't appear in user-facing keys.
   */
  static composeKey(namespace: WorkingMemoryNamespace, kind: WorkingMemoryKind, key: string): string {
    return `${namespace}~${kind}~${key}`;
  }

  static parseKey(composed: string): { namespace: WorkingMemoryNamespace; kind: WorkingMemoryKind; key: string } | null {
    const parts = composed.split('~');
    if (parts.length < 3) return null;
    const [namespace, kind, ...keyParts] = parts;
    return {
      namespace: namespace as WorkingMemoryNamespace,
      kind: kind as WorkingMemoryKind,
      key: keyParts.join('~'),
    };
  }

  /**
   * Read a typed entry from working memory.
   *
   * Reads the in-memory scratchpad first; falls back to the durable table
   * if the scratchpad doesn't have it (e.g. after a process restart).
   */
  read<T = unknown>(runId: string, namespace: WorkingMemoryNamespace, kind: WorkingMemoryKind, key: string): T | null {
    const composed = WorkingMemoryCompactor.composeKey(namespace, kind, key);
    const inMem = this.scratchpad.read(runId, composed);
    if (inMem !== undefined) return inMem as T;

    // Durable fallback.
    const workspaceId = this.workspaceResolver(runId);
    if (!workspaceId) return null;
    const row = this.db.select().from(schema.workingMemoryEntries)
      .where(
        and(
          eq(schema.workingMemoryEntries.workspaceId, workspaceId),
          eq(schema.workingMemoryEntries.runId, runId),
          eq(schema.workingMemoryEntries.namespace, namespace),
          eq(schema.workingMemoryEntries.kind, kind),
          eq(schema.workingMemoryEntries.entryKey, key),
        ),
      )
      .get();
    if (!row) return null;
    // Re-prime the scratchpad cache.
    const payload = parseJsonRecord(row.payload);
    this.scratchpad.write(runId, composed, payload);
    return payload as T;
  }

  /**
   * Write a typed entry. Always writes to the in-memory scratchpad; persists
   * to the durable table when (namespace ∈ DURABLE_NAMESPACES) OR
   * (kind ∈ DURABLE_KINDS).
   */
  write<T = unknown>(
    runId: string,
    namespace: WorkingMemoryNamespace,
    kind: WorkingMemoryKind,
    key: string,
    payload: T,
  ): void {
    const composed = WorkingMemoryCompactor.composeKey(namespace, kind, key);
    this.scratchpad.write(runId, composed, payload);

    if (DURABLE_NAMESPACES.has(namespace) || DURABLE_KINDS.has(kind)) {
      this.#persist(runId, namespace, kind, key, payload as Record<string, unknown>);
    }
  }

  /**
   * Delete a typed entry from both layers.
   */
  delete(runId: string, namespace: WorkingMemoryNamespace, kind: WorkingMemoryKind, key: string): void {
    const composed = WorkingMemoryCompactor.composeKey(namespace, kind, key);
    this.scratchpad.delete(runId, composed);
    const workspaceId = this.workspaceResolver(runId);
    if (!workspaceId) return;
    this.db.delete(schema.workingMemoryEntries)
      .where(
        and(
          eq(schema.workingMemoryEntries.workspaceId, workspaceId),
          eq(schema.workingMemoryEntries.runId, runId),
          eq(schema.workingMemoryEntries.namespace, namespace),
          eq(schema.workingMemoryEntries.kind, kind),
          eq(schema.workingMemoryEntries.entryKey, key),
        ),
      )
      .run();
  }

  /**
   * Snapshot of all working entries for a run, structured by namespace+kind.
   *
   * Useful for the dashboard's "State Surfaces" panel (§5.3 reference).
   */
  snapshot(runId: string): WorkingMemoryEntry[] {
    const raw = this.scratchpad.snapshotOf(runId);
    const entries: WorkingMemoryEntry[] = [];
    const now = new Date().toISOString();
    for (const [composed, payload] of Object.entries(raw)) {
      const parsed = WorkingMemoryCompactor.parseKey(composed);
      if (!parsed) continue;
      entries.push({
        runId,
        namespace: parsed.namespace,
        kind: parsed.kind,
        key: parsed.key,
        payload,
        tokenEstimate: estimateTokens(payload),
        createdAt: now,
        updatedAt: now,
      });
    }
    return entries;
  }

  // ────────────────────────────────────────────────────────────
  // Compaction
  // ────────────────────────────────────────────────────────────

  /**
   * Compact working memory for a run. Applies the rules in the file header.
   *
   * Returns a `WorkingMemorySummary` describing what was compacted.
   * This summary itself is written back as a `working_summary` entry so
   * Layer 5 retrieval can inject it.
   */
  compact(runId: string): WorkingMemorySummary {
    const before = this.snapshot(runId);
    const rawTokens = before.reduce((s, e) => s + (e.tokenEstimate ?? 0), 0);
    const compactedNamespaces = new Set<WorkingMemoryNamespace>();
    const now = Date.now();

    // Group by (namespace, kind, key).
    for (const entry of before) {
      let dropped = false;

      switch (entry.kind) {
        case 'tool_result_cache': {
          const at = (entry.payload as { atIso?: string } | null)?.atIso;
          const t = at ? new Date(at).getTime() : 0;
          if (t && now - t > TOOL_RESULT_TTL_MS) dropped = true;
          break;
        }
        case 'turn_history': {
          // Keep only the last N turns. The payload is { turns: Turn[] }.
          const payload = entry.payload as { turns?: Array<{ summary?: string; atIso?: string; costCents?: number }> } | null;
          if (payload?.turns && payload.turns.length > TURN_HISTORY_KEEP_RECENT) {
            const olderTurns = payload.turns.slice(0, payload.turns.length - TURN_HISTORY_KEEP_RECENT);
            const recentTurns = payload.turns.slice(-TURN_HISTORY_KEEP_RECENT);
            const summary = olderTurns.map((t) => t.summary).filter(Boolean).join(' • ');
            const newPayload = {
              turns: recentTurns,
              olderSummary: summary || undefined,
              olderTurnCount: olderTurns.length,
            };
            this.write(entry.runId, entry.namespace, entry.kind, entry.key, newPayload);
            compactedNamespaces.add(entry.namespace);
          }
          break;
        }
        case 'pending_questions': {
          // Drop the entry if all questions were resolved (empty array).
          const payload = entry.payload as { questions?: string[] } | null;
          if (payload && Array.isArray(payload.questions) && payload.questions.length === 0) {
            dropped = true;
          }
          break;
        }
        case 'blocker': {
          // Drop if blocker is marked resolved.
          const payload = entry.payload as { resolved?: boolean } | null;
          if (payload?.resolved) dropped = true;
          break;
        }
        case 'artifact_draft': {
          // Keep only the latest version per slot. We rely on the key
          // including the slot identifier; the runtime should write
          // `artifact:<slot>` and increment a `version` field inside payload.
          // Compaction is a no-op for V1; multi-version retention is reserved.
          break;
        }
      }

      if (dropped) {
        this.delete(entry.runId, entry.namespace, entry.kind, entry.key);
        compactedNamespaces.add(entry.namespace);
      }
    }

    // Generate the working summary.
    const after = this.snapshot(runId);
    const summary = composeSummary(after);
    const summaryEntry: WorkingMemorySummary = {
      runId,
      summary,
      rawTokens,
      summaryTokens: estimateTokens(summary),
      compactedNamespaces: Array.from(compactedNamespaces),
      generatedAt: new Date().toISOString(),
    };

    // Persist the summary itself so retrieval can pull it.
    this.write(runId, 'run', 'working_summary', 'auto', summaryEntry);

    this.logger.info('working_memory.compaction', {
      runId,
      rawTokens,
      summaryTokens: summaryEntry.summaryTokens,
      compactedNamespaces: summaryEntry.compactedNamespaces,
    });

    return summaryEntry;
  }

  /**
   * Get (or generate) the current working summary for a run.
   *
   * Returns the persisted summary if one exists; otherwise compacts on demand
   * to produce one.
   */
  summarize(runId: string): WorkingMemorySummary {
    const existing = this.read<WorkingMemorySummary>(runId, 'run', 'working_summary', 'auto');
    if (existing) return existing;
    return this.compact(runId);
  }

  /**
   * Dispose all working memory for a run. Called by the engine when the run
   * completes. The durable rows stay (operators may inspect post-mortem)
   * unless the caller passes `durable: true`.
   */
  dispose(runId: string, opts?: { durable?: boolean }): void {
    this.scratchpad.dispose(runId);
    if (opts?.durable) {
      const workspaceId = this.workspaceResolver(runId);
      if (workspaceId) {
        this.db.delete(schema.workingMemoryEntries)
          .where(
            and(
              eq(schema.workingMemoryEntries.workspaceId, workspaceId),
              eq(schema.workingMemoryEntries.runId, runId),
            ),
          )
          .run();
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Durable persistence
  // ────────────────────────────────────────────────────────────

  #persist(
    runId: string,
    namespace: WorkingMemoryNamespace,
    kind: WorkingMemoryKind,
    key: string,
    payload: Record<string, unknown>,
  ): void {
    const workspaceId = this.workspaceResolver(runId);
    if (!workspaceId) return;
    const tokenEstimate = estimateTokens(payload);
    const now = new Date().toISOString();
    // Upsert via INSERT OR IGNORE then UPDATE (no schema-level UPSERT in older
    // SQLite versions, but Drizzle's onConflictDoNothing handles it).
    this.db.insert(schema.workingMemoryEntries).values({
      id: randomUUID(),
      workspaceId,
      runId,
      namespace,
      kind,
      entryKey: key,
      payload,
      tokenEstimate,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().run();
    // Update the existing row.
    this.db.update(schema.workingMemoryEntries)
      .set({ payload, tokenEstimate, updatedAt: now })
      .where(
        and(
          eq(schema.workingMemoryEntries.workspaceId, workspaceId),
          eq(schema.workingMemoryEntries.runId, runId),
          eq(schema.workingMemoryEntries.namespace, namespace),
          eq(schema.workingMemoryEntries.kind, kind),
          eq(schema.workingMemoryEntries.entryKey, key),
        ),
      )
      .run();
  }

  /**
   * Sum of token estimates over all durable entries for a run.
   * Useful for observability and budget planning.
   */
  durableTokenTotal(runId: string): number {
    const workspaceId = this.workspaceResolver(runId);
    if (!workspaceId) return 0;
    const result = this.db.select({ total: sql<number>`SUM(${schema.workingMemoryEntries.tokenEstimate})` })
      .from(schema.workingMemoryEntries)
      .where(
        and(
          eq(schema.workingMemoryEntries.workspaceId, workspaceId),
          eq(schema.workingMemoryEntries.runId, runId),
        ),
      )
      .get();
    return Number(result?.total ?? 0);
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Estimate tokens for arbitrary data. Uses the standard heuristic of
 * ~4 chars per token. Fast, deterministic, no external deps.
 */
function estimateTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / 4);
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return 0;
  }
}

/**
 * Build a compact human-readable summary from a snapshot.
 *
 * Layered structure:
 *   - Plan: <working_plan if present>
 *   - Open questions: <pending_questions>
 *   - Blockers: <blocker entries>
 *   - Recent turns: <turn_history older summary>
 */
function composeSummary(entries: WorkingMemoryEntry[]): string {
  const lines: string[] = [];

  // Plan
  const plan = entries.find((e) => e.kind === 'working_plan');
  if (plan) {
    const p = plan.payload as { steps?: Array<{ title: string; status?: string }> } | null;
    if (p?.steps && p.steps.length > 0) {
      const planLines = p.steps.map((s) => `  - [${s.status ?? 'pending'}] ${s.title}`);
      lines.push('Plan:', ...planLines);
    }
  }

  // Open questions (across all namespaces)
  const questions = entries
    .filter((e) => e.kind === 'pending_questions')
    .flatMap((e) => (e.payload as { questions?: string[] } | null)?.questions ?? []);
  if (questions.length > 0) {
    lines.push('Open questions:', ...questions.map((q) => `  - ${q}`));
  }

  // Blockers
  const blockers = entries
    .filter((e) => e.kind === 'blocker')
    .map((e) => (e.payload as { reason?: string } | null)?.reason)
    .filter(Boolean) as string[];
  if (blockers.length > 0) {
    lines.push('Blockers:', ...blockers.map((b) => `  - ${b}`));
  }

  // Older turn history summaries
  const olderTurns = entries
    .filter((e) => e.kind === 'turn_history')
    .map((e) => (e.payload as { olderSummary?: string } | null)?.olderSummary)
    .filter(Boolean);
  if (olderTurns.length > 0) {
    lines.push('Earlier context:', ...olderTurns.map((t) => `  - ${t}`));
  }

  return lines.length > 0 ? lines.join('\n') : '';
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
