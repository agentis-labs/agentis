/**
 * WorkspaceStoreService — Tier-3 workspace-scoped persistent KV (§4.1).
 *
 * Distinct from `WorkflowStoreService` (Tier 2, scoped to one workflow). Tier 3 is
 * shared across every workflow in a workspace: global flags, shared config,
 * cross-workflow coordination. Surfaced to templates as `{{workspace.kv.*}}`.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export interface WorkspaceStoreEntry {
  workspaceId: string;
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
}

export class WorkspaceStoreService {
  constructor(private readonly db: AgentisSqliteDb) {}

  get(workspaceId: string, key: string): unknown {
    const row = this.db
      .select()
      .from(schema.workspaceKv)
      .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, key)))
      .get();
    return row?.value;
  }

  set(workspaceId: string, key: string, value: unknown): WorkspaceStoreEntry {
    const now = new Date().toISOString();
    const existing = this.db
      .select()
      .from(schema.workspaceKv)
      .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, key)))
      .get();
    if (existing) {
      this.db
        .update(schema.workspaceKv)
        .set({ value, version: existing.version + 1, updatedAt: now })
        .where(eq(schema.workspaceKv.id, existing.id))
        .run();
      return { workspaceId, key, value, version: existing.version + 1, updatedAt: now };
    }
    this.db
      .insert(schema.workspaceKv)
      .values({ id: randomUUID(), workspaceId, key, value, version: 1, createdAt: now, updatedAt: now })
      .run();
    return { workspaceId, key, value, version: 1, updatedAt: now };
  }

  delete(workspaceId: string, key: string): boolean {
    const result = this.db
      .delete(schema.workspaceKv)
      .where(and(eq(schema.workspaceKv.workspaceId, workspaceId), eq(schema.workspaceKv.key, key)))
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  increment(workspaceId: string, key: string, amount: number): WorkspaceStoreEntry {
    const current = this.get(workspaceId, key);
    const next = typeof current === 'number' ? current + amount : amount;
    return this.set(workspaceId, key, next);
  }

  append(workspaceId: string, key: string, value: unknown): WorkspaceStoreEntry {
    const current = this.get(workspaceId, key);
    const next = Array.isArray(current) ? [...current, value] : current === undefined ? [value] : [current, value];
    return this.set(workspaceId, key, next);
  }

  /** Snapshot the entire workspace KV — used as `{{workspace.kv.*}}` template context. */
  snapshot(workspaceId: string): Record<string, unknown> {
    const rows = this.db
      .select()
      .from(schema.workspaceKv)
      .where(eq(schema.workspaceKv.workspaceId, workspaceId))
      .all();
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }
}
