/**
 * AppDataService — the app's operational Data layer (AGENTIS-PLATFORM-10X §A1).
 *
 * Each installed app owns a set of schema-defined structured tables. Workflows
 * write to them (`data_write` node), workflows read from them, external APIs
 * query them, and the Brain learns from them.
 *
 * This is NOT the Brain (knowledge/embeddings) and NOT the knowledge base
 * (unstructured RAG docs). It is a plain structured store — records with
 * schemas, filters, and pagination.
 *
 * Physical model:
 *   - One dynamically-created SQLite table per app table:
 *     `appdata_<sanitizedAppId>_<tableName>`.
 *   - Each row has `id`, `created_at`, `updated_at` plus one column per
 *     declared field. `json` fields are stored as TEXT (JSON-encoded).
 *   - The `app_data_tables` registry row records the declared schema for
 *     introspection and safe migration.
 *
 * Every write fires `DATA_RECORD_CHANGED` on the bus — this is the primitive
 * that the `data_event` trigger type listens to, making apps autonomous.
 */

import { randomUUID } from 'node:crypto';
import { sql, eq, and } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  AgentisError,
  type AppDataTable,
  type AppDataField,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import { evalCondition } from '../engine/SafeConditionParser.js';

export interface QueryFilter {
  /** Equality filters: column → value. */
  where?: Record<string, unknown>;
  /** A SafeConditionParser expression applied per-row (post-SQL filter). */
  expression?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
}

export interface QueryResult {
  records: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}

export interface DataChangeEvent {
  appId: string;
  workspaceId: string;
  table: string;
  event: 'insert' | 'update' | 'delete';
  recordId: string;
  record: Record<string, unknown>;
}

const RESERVED_COLUMNS = new Set(['id', 'created_at', 'updated_at']);

export class AppDataService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  // ────────────────────────────────────────────────────────────
  // DDL — table provisioning + safe migration
  // ────────────────────────────────────────────────────────────

  /**
   * Create (or safely migrate) the physical table for one app Data table.
   * Idempotent: re-running adds new columns but never drops existing ones.
   */
  ensureTable(workspaceId: string, appId: string, table: AppDataTable): void {
    const physical = physicalName(appId, table.name);
    const fields = Object.entries(table.schema).filter(([col]) => !RESERVED_COLUMNS.has(col));

    this.db.run(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS "${physical}" (` +
          `id TEXT PRIMARY KEY, ` +
          fields.map(([col, def]) => `"${columnName(col)}" ${sqlType(def)}`).join(', ') +
          (fields.length > 0 ? ', ' : '') +
          `created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ` +
          `updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` +
          `)`,
      ),
    );

    // Safe migration: add columns declared since the last activation.
    const existing = new Set(
      (this.db.all(sql.raw(`PRAGMA table_info("${physical}")`)) as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    for (const [col, def] of fields) {
      const cn = columnName(col);
      if (!existing.has(cn)) {
        this.db.run(sql.raw(`ALTER TABLE "${physical}" ADD COLUMN "${cn}" ${sqlType(def)}`));
      }
    }

    // Indexes.
    for (const idx of table.indexes ?? []) {
      const cn = columnName(idx.field);
      const idxName = `idx_${physical}_${cn}`;
      const unique = idx.type === 'unique' ? 'UNIQUE ' : '';
      this.db.run(
        sql.raw(`CREATE ${unique}INDEX IF NOT EXISTS "${idxName}" ON "${physical}" ("${cn}")`),
      );
    }

    // Registry upsert.
    const existingRow = this.db
      .select()
      .from(schema.appDataTables)
      .where(and(eq(schema.appDataTables.appId, appId), eq(schema.appDataTables.name, table.name)))
      .get();
    const now = new Date().toISOString();
    if (existingRow) {
      this.db
        .update(schema.appDataTables)
        .set({
          description: table.description ?? null,
          schemaJson: table as unknown as object,
          updatedAt: now,
        })
        .where(eq(schema.appDataTables.id, existingRow.id))
        .run();
    } else {
      this.db
        .insert(schema.appDataTables)
        .values({
          id: randomUUID(),
          workspaceId,
          appId,
          name: table.name,
          physicalName: physical,
          description: table.description ?? null,
          schemaJson: table as unknown as object,
          rowCount: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  }

  /** Provision every Data table declared by an app. Called on activation. */
  provisionTables(workspaceId: string, appId: string, tables: AppDataTable[]): number {
    for (const t of tables) {
      try {
        this.ensureTable(workspaceId, appId, t);
      } catch (err) {
        this.logger.error('app_data.provision_failed', {
          appId,
          table: t.name,
          err: (err as Error).message,
        });
        throw err;
      }
    }
    return tables.length;
  }

  /** Drop all physical tables + registry rows for an app (on uninstall). */
  dropTablesForApp(appId: string): void {
    const rows = this.db
      .select()
      .from(schema.appDataTables)
      .where(eq(schema.appDataTables.appId, appId))
      .all();
    for (const row of rows) {
      this.db.run(sql.raw(`DROP TABLE IF EXISTS "${row.physicalName}"`));
    }
    this.db.delete(schema.appDataTables).where(eq(schema.appDataTables.appId, appId)).run();
  }

  // ────────────────────────────────────────────────────────────
  // Introspection
  // ────────────────────────────────────────────────────────────

  schema(appId: string, table: string): AppDataTable | null {
    const row = this.#registryRow(appId, table);
    return row ? (row.schemaJson as unknown as AppDataTable) : null;
  }

  listTables(appId: string): Array<{ name: string; description: string | null; rowCount: number }> {
    return this.db
      .select()
      .from(schema.appDataTables)
      .where(eq(schema.appDataTables.appId, appId))
      .all()
      .map((r) => ({ name: r.name, description: r.description, rowCount: r.rowCount }));
  }

  // ────────────────────────────────────────────────────────────
  // DML
  // ────────────────────────────────────────────────────────────

  insert(
    workspaceId: string,
    appId: string,
    table: string,
    record: Record<string, unknown>,
  ): { id: string } {
    const { decl, physical } = this.#resolve(appId, table);
    this.#validateRequired(table, decl, record);
    const id = typeof record.id === 'string' && record.id ? record.id : randomUUID();
    const now = new Date().toISOString();
    const cols = ['id'];
    const values: unknown[] = [id];
    for (const [field, def] of Object.entries(decl.schema)) {
      if (RESERVED_COLUMNS.has(field)) continue;
      cols.push(columnName(field));
      values.push(encodeValue(record[field], def));
    }
    cols.push('created_at', 'updated_at');
    values.push(now, now);

    this.#exec(
      `INSERT OR REPLACE INTO "${physical}" (${cols.map((c) => `"${c}"`).join(', ')}) ` +
        `VALUES (${cols.map(() => '?').join(', ')})`,
      values,
    );

    this.#bumpRowCount(appId, table, 1);
    const full = this.getRecord(appId, table, id) ?? { id, ...record };
    this.#emit({ appId, workspaceId, table, event: 'insert', recordId: id, record: full });
    this.#enforceMaxRows(appId, table, decl, physical);
    return { id };
  }

  update(
    workspaceId: string,
    appId: string,
    table: string,
    id: string,
    patch: Record<string, unknown>,
  ): void {
    const { decl, physical } = this.#resolve(appId, table);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, def] of Object.entries(decl.schema)) {
      if (RESERVED_COLUMNS.has(field)) continue;
      if (field in patch) {
        sets.push(`"${columnName(field)}" = ?`);
        values.push(encodeValue(patch[field], def));
      }
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = ?`);
    values.push(new Date().toISOString());
    values.push(id);
    this.#exec(`UPDATE "${physical}" SET ${sets.join(', ')} WHERE id = ?`, values);
    const full = this.getRecord(appId, table, id);
    if (full) {
      this.#emit({ appId, workspaceId, table, event: 'update', recordId: id, record: full });
    }
  }

  /** Insert when no row matches `idField`, otherwise update the match. */
  upsert(
    workspaceId: string,
    appId: string,
    table: string,
    record: Record<string, unknown>,
    idField: string,
  ): { id: string; created: boolean } {
    const { physical } = this.#resolve(appId, table);
    const matchValue = record[idField];
    if (matchValue !== undefined && matchValue !== null) {
      const existing = this.#row(
        `SELECT id FROM "${physical}" WHERE "${columnName(idField)}" = ? LIMIT 1`,
        [matchValue],
      ) as { id: string } | undefined;
      if (existing) {
        this.update(workspaceId, appId, table, existing.id, record);
        return { id: existing.id, created: false };
      }
    }
    const { id } = this.insert(workspaceId, appId, table, record);
    return { id, created: true };
  }

  delete(workspaceId: string, appId: string, table: string, id: string): void {
    const { physical } = this.#resolve(appId, table);
    const before = this.getRecord(appId, table, id);
    this.#exec(`DELETE FROM "${physical}" WHERE id = ?`, [id]);
    if (before) {
      this.#bumpRowCount(appId, table, -1);
      this.#emit({ appId, workspaceId, table, event: 'delete', recordId: id, record: before });
    }
  }

  /**
   * Delete every row of a Data table without dropping the table itself.
   * Returns the number of rows removed. Used by the workflow Output tab's
   * "Clear accumulated records" action.
   */
  clearTable(workspaceId: string, appId: string, table: string): number {
    const { physical } = this.#resolve(appId, table);
    const removed = this.count(appId, table);
    this.#exec(`DELETE FROM "${physical}"`, []);
    const row = this.#registryRow(appId, table);
    if (row) {
      this.db
        .update(schema.appDataTables)
        .set({ rowCount: 0, updatedAt: new Date().toISOString() })
        .where(eq(schema.appDataTables.id, row.id))
        .run();
    }
    try {
      this.bus.publish(REALTIME_ROOMS.app(appId), REALTIME_EVENTS.DATA_RECORD_CHANGED, {
        appId,
        workspaceId,
        table,
        event: 'delete',
        recordId: '*',
        record: {},
      });
      this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.DATA_RECORD_CHANGED, {
        appId,
        workspaceId,
        table,
        event: 'delete',
        recordId: '*',
        record: {},
      });
    } catch (err) {
      this.logger.warn('app_data.emit_failed', { appId, err: (err as Error).message });
    }
    return removed;
  }

  getRecord(appId: string, table: string, id: string): Record<string, unknown> | null {
    const { decl, physical } = this.#resolve(appId, table);
    const row = this.#row(`SELECT * FROM "${physical}" WHERE id = ? LIMIT 1`, [id]) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeRow(row, decl) : null;
  }

  query(appId: string, table: string, filter: QueryFilter = {}): QueryResult {
    const { decl, physical } = this.#resolve(appId, table);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [field, value] of Object.entries(filter.where ?? {})) {
      if (!(field in decl.schema) && !RESERVED_COLUMNS.has(field)) continue;
      clauses.push(`"${columnName(field)}" = ?`);
      params.push(value);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const orderCol =
      filter.orderBy && (filter.orderBy in decl.schema || RESERVED_COLUMNS.has(filter.orderBy))
        ? columnName(filter.orderBy)
        : 'created_at';
    const orderDir = filter.orderDir === 'asc' ? 'ASC' : 'DESC';

    const totalRow = this.#row(`SELECT COUNT(*) AS n FROM "${physical}"${where}`, params) as
      | { n: number }
      | undefined;

    const rows = this.#all(
      `SELECT * FROM "${physical}"${where} ORDER BY "${orderCol}" ${orderDir} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ) as Array<Record<string, unknown>>;

    let records = rows.map((r) => decodeRow(r, decl));
    if (filter.expression) {
      records = records.filter((r) => safeMatch(filter.expression!, r));
    }
    return { records, total: totalRow?.n ?? records.length, limit, offset };
  }

  count(appId: string, table: string, where?: Record<string, unknown>): number {
    return this.query(appId, table, { where, limit: 1 }).total;
  }

  // ────────────────────────────────────────────────────────────
  // Retention
  // ────────────────────────────────────────────────────────────

  /**
   * Enforce `ttlDays` retention across every registered Data table. Rows older
   * than the table's TTL are deleted. `maxRows` is enforced inline on insert;
   * this sweep covers the time-based policy. Returns a summary of what pruned.
   * Pruning is silent — it does NOT fire `data_event` triggers (a retention
   * delete is housekeeping, not an operational mutation).
   */
  sweepRetention(): { tablesSwept: number; rowsPruned: number } {
    const rows = this.db.select().from(schema.appDataTables).all();
    let rowsPruned = 0;
    let tablesSwept = 0;
    const now = Date.now();
    for (const row of rows) {
      const decl = row.schemaJson as unknown as AppDataTable;
      const ttlDays = decl.retention?.ttlDays;
      if (!ttlDays || ttlDays <= 0) continue;
      tablesSwept += 1;
      const cutoff = new Date(now - ttlDays * 86_400_000).toISOString();
      try {
        const before = this.count(row.appId, row.name);
        this.#exec(`DELETE FROM "${row.physicalName}" WHERE created_at < ?`, [cutoff]);
        const after = this.count(row.appId, row.name);
        const pruned = Math.max(0, before - after);
        if (pruned > 0) {
          rowsPruned += pruned;
          this.#bumpRowCount(row.appId, row.name, -pruned);
          this.logger.info('app_data.retention_pruned', {
            appId: row.appId,
            table: row.name,
            pruned,
            policy: 'ttl',
          });
        }
      } catch (err) {
        this.logger.warn('app_data.retention_failed', {
          appId: row.appId,
          table: row.name,
          err: (err as Error).message,
        });
      }
    }
    return { tablesSwept, rowsPruned };
  }

  // ────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────

  /** Reject inserts that omit a `required: true` field. */
  #validateRequired(table: string, decl: AppDataTable, record: Record<string, unknown>): void {
    for (const [field, def] of Object.entries(decl.schema)) {
      if (RESERVED_COLUMNS.has(field) || !def.required) continue;
      const v = record[field];
      if (v === undefined || v === null || v === '') {
        throw new AgentisError(
          'VALIDATION_FAILED',
          `Data table "${table}": required field "${field}" is missing`,
        );
      }
    }
  }

  /** Trim the oldest rows beyond a table's `maxRows` retention cap. */
  #enforceMaxRows(appId: string, table: string, decl: AppDataTable, physical: string): void {
    const maxRows = decl.retention?.maxRows;
    if (!maxRows || maxRows <= 0) return;
    const total = this.count(appId, table);
    if (total <= maxRows) return;
    const excess = total - maxRows;
    try {
      this.#exec(
        `DELETE FROM "${physical}" WHERE id IN (` +
          `SELECT id FROM "${physical}" ORDER BY created_at ASC LIMIT ?)`,
        [excess],
      );
      this.#bumpRowCount(appId, table, -excess);
      this.logger.info('app_data.retention_pruned', {
        appId,
        table,
        pruned: excess,
        policy: 'max_rows',
      });
    } catch (err) {
      this.logger.warn('app_data.retention_failed', {
        appId,
        table,
        err: (err as Error).message,
      });
    }
  }

  #resolve(appId: string, table: string): { decl: AppDataTable; physical: string } {
    const row = this.#registryRow(appId, table);
    if (!row) {
      throw new AgentisError(
        'RESOURCE_NOT_FOUND',
        `App ${appId} has no Data table "${table}"`,
      );
    }
    return { decl: row.schemaJson as unknown as AppDataTable, physical: row.physicalName };
  }

  #registryRow(appId: string, table: string) {
    return this.db
      .select()
      .from(schema.appDataTables)
      .where(and(eq(schema.appDataTables.appId, appId), eq(schema.appDataTables.name, table)))
      .get();
  }

  #bumpRowCount(appId: string, table: string, delta: number): void {
    const row = this.#registryRow(appId, table);
    if (!row) return;
    this.db
      .update(schema.appDataTables)
      .set({ rowCount: Math.max(0, row.rowCount + delta), updatedAt: new Date().toISOString() })
      .where(eq(schema.appDataTables.id, row.id))
      .run();
  }

  #emit(change: DataChangeEvent): void {
    try {
      this.bus.publish(REALTIME_ROOMS.app(change.appId), REALTIME_EVENTS.DATA_RECORD_CHANGED, change);
      this.bus.publish(
        REALTIME_ROOMS.workspace(change.workspaceId),
        REALTIME_EVENTS.DATA_RECORD_CHANGED,
        change,
      );
    } catch (err) {
      this.logger.warn('app_data.emit_failed', { appId: change.appId, err: (err as Error).message });
    }
  }

  /** Run a parameterized statement against the raw SQLite driver. */
  #exec(query: string, params: unknown[]): void {
    rawClient(this.db).prepare(query).run(...(params as never[]));
  }
  #row(query: string, params: unknown[]): unknown {
    return rawClient(this.db).prepare(query).get(...(params as never[]));
  }
  #all(query: string, params: unknown[]): unknown[] {
    return rawClient(this.db).prepare(query).all(...(params as never[]));
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

interface RawClient {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Reach the underlying better-sqlite3 Database for dynamic SQL. */
function rawClient(db: AgentisSqliteDb): RawClient {
  const client = (db as unknown as { $client?: RawClient }).$client;
  if (!client) {
    throw new AgentisError('INTERNAL_ERROR', 'AppDataService: raw SQLite client unavailable');
  }
  return client;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function physicalName(appId: string, table: string): string {
  return `appdata_${sanitizeId(appId)}_${columnName(table)}`;
}

function columnName(field: string): string {
  const clean = field.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!/^[a-zA-Z_]/.test(clean)) return `f_${clean}`;
  return clean;
}

function sqlType(def: AppDataField): string {
  switch (def.type) {
    case 'number':
      return 'REAL';
    case 'boolean':
      return 'INTEGER';
    case 'string':
    case 'text':
    case 'date':
    case 'json':
    default:
      return 'TEXT';
  }
}

function encodeValue(value: unknown, def: AppDataField): unknown {
  if (value === undefined || value === null) return null;
  switch (def.type) {
    case 'boolean':
      return value ? 1 : 0;
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'date':
      return value instanceof Date ? value.toISOString() : String(value);
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

function decodeRow(row: Record<string, unknown>, decl: AppDataTable): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  for (const [field, def] of Object.entries(decl.schema)) {
    if (RESERVED_COLUMNS.has(field)) continue;
    const raw = row[columnName(field)];
    out[field] = decodeValue(raw, def);
  }
  return out;
}

function decodeValue(raw: unknown, def: AppDataField): unknown {
  if (raw === undefined || raw === null) return null;
  switch (def.type) {
    case 'boolean':
      return raw === 1 || raw === true || raw === '1';
    case 'number':
      return typeof raw === 'number' ? raw : Number(raw);
    case 'json':
      try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

/** Evaluate a SafeConditionParser expression against a record; never throws. */
export function safeMatch(expression: string, record: Record<string, unknown>): boolean {
  if (!expression || !expression.trim()) return true;
  try {
    return evalCondition(expression, { ...record, record });
  } catch {
    return false;
  }
}
