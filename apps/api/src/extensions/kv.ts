/**
 * Extension KV store — EXTENSIONS-AND-LISTENER-10X §2.5.
 *
 * Workspace+extension-scoped durable state. Read/write is gated behind the
 * `kv.read` / `kv.write` permissions at the runtime boundary; this service is
 * the storage layer and does not itself enforce permissions.
 */

import { and, eq, lt } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export interface ExtensionKvEntry {
  key: string;
  value: unknown;
  updatedAt: string;
  expiresAt: string | null;
}

export class ExtensionKvStore {
  constructor(private readonly db: AgentisSqliteDb) {}

  get(workspaceId: string, extensionId: string, key: string): unknown {
    const row = this.db
      .select()
      .from(schema.extensionKv)
      .where(
        and(
          eq(schema.extensionKv.workspaceId, workspaceId),
          eq(schema.extensionKv.extensionId, extensionId),
          eq(schema.extensionKv.key, key),
        ),
      )
      .get();
    if (!row) return undefined;
    if (row.expiresAt && Date.parse(row.expiresAt) < Date.now()) {
      this.delete(workspaceId, extensionId, key);
      return undefined;
    }
    return row.value;
  }

  set(workspaceId: string, extensionId: string, key: string, value: unknown, ttlSeconds?: number): void {
    const now = new Date();
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? new Date(now.getTime() + ttlSeconds * 1000).toISOString() : null;
    this.db
      .insert(schema.extensionKv)
      .values({ workspaceId, extensionId, key, value, updatedAt: now.toISOString(), expiresAt })
      .onConflictDoUpdate({
        target: [schema.extensionKv.workspaceId, schema.extensionKv.extensionId, schema.extensionKv.key],
        set: { value, updatedAt: now.toISOString(), expiresAt },
      })
      .run();
  }

  delete(workspaceId: string, extensionId: string, key: string): boolean {
    const res = this.db
      .delete(schema.extensionKv)
      .where(
        and(
          eq(schema.extensionKv.workspaceId, workspaceId),
          eq(schema.extensionKv.extensionId, extensionId),
          eq(schema.extensionKv.key, key),
        ),
      )
      .run();
    return Number(res.changes ?? 0) > 0;
  }

  list(workspaceId: string, extensionId: string): ExtensionKvEntry[] {
    const rows = this.db
      .select()
      .from(schema.extensionKv)
      .where(and(eq(schema.extensionKv.workspaceId, workspaceId), eq(schema.extensionKv.extensionId, extensionId)))
      .all();
    const now = Date.now();
    return rows
      .filter((r) => !r.expiresAt || Date.parse(r.expiresAt) >= now)
      .map((r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt, expiresAt: r.expiresAt ?? null }));
  }

  clear(workspaceId: string, extensionId: string): void {
    this.db
      .delete(schema.extensionKv)
      .where(and(eq(schema.extensionKv.workspaceId, workspaceId), eq(schema.extensionKv.extensionId, extensionId)))
      .run();
  }

  /** Best-effort TTL sweep — safe to call periodically. */
  sweepExpired(): void {
    this.db.delete(schema.extensionKv).where(lt(schema.extensionKv.expiresAt, new Date().toISOString())).run();
  }
}
