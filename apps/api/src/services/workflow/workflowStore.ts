/**
 * WorkflowStoreService — workflow-scoped persistent KV. Part of the Brain's
 * workflow-memory layer.
 *
 * The `scratchpad` service is run-scoped and disposed on completion.
 * `workflow_kv_entries` is workflow-scoped and persists indefinitely — the
 * foundation for long-running automations (daily/weekly/monthly workflows
 * that need to remember state across runs). Carrying `workspace_id` lets the
 * Brain surface index these entries as structured workspace facts.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export interface WorkflowStoreEntry {
  workflowId: string;
  workspaceId: string;
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
}

export class WorkflowStoreService {
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Read a single key. Returns `undefined` when missing. */
  get(workspaceId: string, workflowId: string, key: string): unknown {
    return this.getEntry(workspaceId, workflowId, key)?.value;
  }

  getEntry(workspaceId: string, workflowId: string, key: string): WorkflowStoreEntry | undefined {
    const row = this.db
      .select()
      .from(schema.workflowKvEntries)
      .where(
        and(
          eq(schema.workflowKvEntries.workspaceId, workspaceId),
          eq(schema.workflowKvEntries.workflowId, workflowId),
          eq(schema.workflowKvEntries.key, key),
        ),
      )
      .get();
    return row ? {
      workflowId: row.workflowId,
      workspaceId: row.workspaceId,
      key: row.key,
      value: row.value,
      version: row.version,
      updatedAt: row.updatedAt,
    } : undefined;
  }

  /** Atomically validate every expected version and commit all state writes. */
  commit(
    workspaceId: string,
    workflowId: string,
    writes: Array<{ key: string; expectedVersion: number; value: unknown; mode?: 'replace' | 'set' }>,
  ): WorkflowStoreEntry[] {
    if (writes.length === 0) return [];
    const duplicate = writes.find((write, index) => writes.findIndex((candidate) => candidate.key === write.key) !== index);
    if (duplicate) throw new AgentisError('VALIDATION_FAILED', `Duplicate workflow state binding for key ${duplicate.key}`);
    return this.db.transaction((tx) => {
      const current = writes.map((write) => ({
        write,
        row: tx.select().from(schema.workflowKvEntries).where(and(
          eq(schema.workflowKvEntries.workspaceId, workspaceId),
          eq(schema.workflowKvEntries.workflowId, workflowId),
          eq(schema.workflowKvEntries.key, write.key),
        )).get(),
      }));
      for (const item of current) {
        if ((item.row?.version ?? 0) !== item.write.expectedVersion) {
          throw new AgentisError(
            'GRAPH_REVISION_CONFLICT',
            `Workflow state '${item.write.key}' changed concurrently (expected v${item.write.expectedVersion}, actual v${item.row?.version ?? 0}).`,
          );
        }
      }
      const now = new Date().toISOString();
      return current.map(({ write, row }) => {
        const value = write.mode === 'set'
          ? mergeSetValues(row?.value, write.value)
          : write.value;
        const version = (row?.version ?? 0) + 1;
        if (row) {
          tx.update(schema.workflowKvEntries).set({ value, version, updatedAt: now })
            .where(and(eq(schema.workflowKvEntries.id, row.id), eq(schema.workflowKvEntries.version, write.expectedVersion))).run();
        } else {
          tx.insert(schema.workflowKvEntries).values({
            id: randomUUID(), workspaceId, workflowId, key: write.key, value, version, createdAt: now, updatedAt: now,
          }).run();
        }
        return { workflowId, workspaceId, key: write.key, value, version, updatedAt: now };
      });
    });
  }

  /** Atomic upsert. Bumps `version` for optimistic-concurrency clients. */
  set(workspaceId: string, workflowId: string, key: string, value: unknown): WorkflowStoreEntry {
    const now = new Date().toISOString();
    const existing = this.db
      .select()
      .from(schema.workflowKvEntries)
      .where(
        and(
          eq(schema.workflowKvEntries.workspaceId, workspaceId),
          eq(schema.workflowKvEntries.workflowId, workflowId),
          eq(schema.workflowKvEntries.key, key),
        ),
      )
      .get();
    if (existing) {
      this.db
        .update(schema.workflowKvEntries)
        .set({ value, version: existing.version + 1, updatedAt: now })
        .where(eq(schema.workflowKvEntries.id, existing.id))
        .run();
      return {
        workflowId,
        workspaceId,
        key,
        value,
        version: existing.version + 1,
        updatedAt: now,
      };
    }
    this.db
      .insert(schema.workflowKvEntries)
      .values({
        id: randomUUID(),
        workspaceId,
        workflowId,
        key,
        value,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return { workflowId, workspaceId, key, value, version: 1, updatedAt: now };
  }

  /** Remove a key. Returns true when the row existed. */
  delete(workspaceId: string, workflowId: string, key: string): boolean {
    const result = this.db
      .delete(schema.workflowKvEntries)
      .where(
        and(
          eq(schema.workflowKvEntries.workspaceId, workspaceId),
          eq(schema.workflowKvEntries.workflowId, workflowId),
          eq(schema.workflowKvEntries.key, key),
        ),
      )
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Integer counter — creates the key as 0 + amount if missing. */
  increment(workspaceId: string, workflowId: string, key: string, amount: number): WorkflowStoreEntry {
    const current = this.get(workspaceId, workflowId, key);
    const next = typeof current === 'number' ? current + amount : amount;
    return this.set(workspaceId, workflowId, key, next);
  }

  /**
   * Append to an array-typed entry. Creates the entry as `[value]` when
   * missing; converts non-array existing values into a one-element array
   * before appending.
   */
  append(workspaceId: string, workflowId: string, key: string, value: unknown): WorkflowStoreEntry {
    const current = this.get(workspaceId, workflowId, key);
    const next = Array.isArray(current)
      ? [...current, value]
      : current === undefined
        ? [value]
        : [current, value];
    return this.set(workspaceId, workflowId, key, next);
  }

  /** Snapshot the entire KV for a workflow — used as `{{store.*}}` template context. */
  snapshot(workspaceId: string, workflowId: string): Record<string, unknown> {
    const rows = this.db
      .select()
      .from(schema.workflowKvEntries)
      .where(
        and(
          eq(schema.workflowKvEntries.workspaceId, workspaceId),
          eq(schema.workflowKvEntries.workflowId, workflowId),
        ),
      )
      .all();
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }
}

function mergeSetValues(current: unknown, next: unknown): unknown[] {
  const values = [
    ...(Array.isArray(current) ? current : current === undefined ? [] : [current]),
    ...(Array.isArray(next) ? next : next === undefined ? [] : [next]),
  ];
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = stableValueKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableValueKey(value: unknown): string {
  if (!value || typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableValueKey).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${key}:${stableValueKey(item)}`).join(',')}}`;
}
