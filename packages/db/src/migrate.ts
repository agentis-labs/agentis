/**
 * Migration runner — dialect-aware.
 *
 * Tracks applied migrations in a `schema_migrations` table:
 *
 *   CREATE TABLE schema_migrations (
 *     version    INTEGER PRIMARY KEY,
 *     name       TEXT    NOT NULL,
 *     applied_at TEXT    NOT NULL  -- ISO-8601 UTC
 *   );
 *
 * On `runSqliteMigrations`:
 *   1. Ensure `schema_migrations` exists.
 *   2. Backfill: if the table is empty AND the database already contains a
 *      core table from migration 1 (e.g. `users`), record version 1 as
 *      applied at the current time. This handles users upgrading from a
 *      pre-runner build without re-running the init script.
 *   3. For each registered migration whose version is not yet applied,
 *      apply its SQL and record it in a single `BEGIN IMMEDIATE` /
 *      `COMMIT` transaction. On failure the transaction is rolled back
 *      and the runner throws, leaving the database in its previous state.
 *
 * The runner is safe to invoke concurrently from multiple processes
 * because better-sqlite3 + WAL + `BEGIN IMMEDIATE` serialises writers and
 * the per-version uniqueness constraint catches double-application.
 *
 * Postgres support is scaffolded for parity (REFACTORING.md P1) but not
 * wired in V1; the standard-mode driver still throws from `openDatabase`.
 */

import type Database from 'better-sqlite3';
import { SQLITE_MIGRATIONS, type Migration } from './sqlite/migrations.js';

export interface MigrationStatus {
  /** Migrations whose `version` is recorded in schema_migrations. */
  readonly applied: readonly { version: number; name: string; appliedAt: string }[];
  /** Migrations registered in code but not yet recorded as applied. */
  readonly pending: readonly Migration[];
}

const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

function ensureMigrationsTable(sqlite: Database.Database): void {
  sqlite.exec(ENSURE_TABLE_SQL);
}

function listAppliedVersions(sqlite: Database.Database): Set<number> {
  const rows = sqlite
    .prepare('SELECT version FROM schema_migrations')
    .all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

function tableExists(sqlite: Database.Database, tableName: string): boolean {
  return Boolean(
    sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(tableName),
  );
}

function columnExists(sqlite: Database.Database, tableName: string, columnName: string): boolean {
  if (!tableExists(sqlite, tableName)) return false;
  const rows = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function engine10xSchemaIsPresent(sqlite: Database.Database): boolean {
  return (
    columnExists(sqlite, 'workflows', 'max_concurrent_runs') &&
    columnExists(sqlite, 'workflows', 'concurrency_overflow') &&
    columnExists(sqlite, 'workflow_edges', 'data_contract') &&
    tableExists(sqlite, 'workflow_run_queue') &&
    tableExists(sqlite, 'node_execution_cache') &&
    tableExists(sqlite, 'workflow_event_subscriptions') &&
    tableExists(sqlite, 'schedule_runs')
  );
}

function workflowTagsSchemaIsPresent(sqlite: Database.Database): boolean {
  return columnExists(sqlite, 'workflows', 'tags');
}

function workflowRunReplaySchemaIsPresent(sqlite: Database.Database): boolean {
  return columnExists(sqlite, 'workflow_runs', 'is_replay');
}

function agentCapabilityVersionSchemaIsPresent(sqlite: Database.Database): boolean {
  return columnExists(sqlite, 'agents', 'capability_version');
}

function spacesSchemaIsPresent(sqlite: Database.Database): boolean {
  return tableExists(sqlite, 'spaces') && columnExists(sqlite, 'app_instances', 'space_id');
}

const IMPLIED_MIGRATION_STAMPS: readonly {
  readonly version: number;
  readonly isPresent: (sqlite: Database.Database) => boolean;
}[] = [
  { version: 9, isPresent: engine10xSchemaIsPresent },
  { version: 20, isPresent: workflowTagsSchemaIsPresent },
  { version: 21, isPresent: workflowRunReplaySchemaIsPresent },
  { version: 23, isPresent: agentCapabilityVersionSchemaIsPresent },
  { version: 25, isPresent: spacesSchemaIsPresent },
] as const;

function stampImpliedMigrations(
  sqlite: Database.Database,
  already: Set<number>,
): Migration[] {
  const stamped: Migration[] = [];
  for (const stamp of IMPLIED_MIGRATION_STAMPS) {
    if (already.has(stamp.version) || !stamp.isPresent(sqlite)) continue;
    const migration = SQLITE_MIGRATIONS.find((m) => m.version === stamp.version);
    if (migration) {
      sqlite
        .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name);
      already.add(migration.version);
      stamped.push(migration);
    }
  }
  return stamped;
}

/**
 * If the database was initialised by a pre-runner build (i.e. has core
 * tables but an empty `schema_migrations`), record version 1 as already
 * applied so we don't re-execute it. We probe with a sentinel core table
 * (`users`) that has existed since migration 1.
 */
function backfillIfPreExisting(sqlite: Database.Database): void {
  const appliedCount = sqlite
    .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
    .get() as { n: number };
  if (appliedCount.n > 0) return;

  const sentinel = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`)
    .get();
  if (!sentinel) return;

  // Pre-existing initialised db with no migration record. Stamp v1.
  sqlite
    .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
    .run(1, 'init');
}

function applyMigration(sqlite: Database.Database, migration: Migration): void {
  const tx = sqlite.transaction(() => {
    sqlite.exec(migration.sql);
    sqlite
      .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
      .run(migration.version, migration.name);
  });
  tx.immediate();
}

export interface RunSqliteMigrationsResult {
  readonly applied: readonly Migration[];
}

/**
 * Apply all pending migrations. Idempotent: a second call with no new
 * registered migrations is a no-op.
 */
export function runSqliteMigrations(sqlite: Database.Database): RunSqliteMigrationsResult {
  ensureMigrationsTable(sqlite);
  backfillIfPreExisting(sqlite);

  const already = listAppliedVersions(sqlite);
  const applied: Migration[] = stampImpliedMigrations(sqlite, already);

  // Defensive ordering — the runtime registry is already sorted by version,
  // but we sort again so a future hand-edit can't introduce silent mis-order.
  const ordered = [...SQLITE_MIGRATIONS].sort((a, b) => a.version - b.version);

  for (const migration of ordered) {
    if (already.has(migration.version)) continue;
    applyMigration(sqlite, migration);
    already.add(migration.version);
    applied.push(migration);
    applied.push(...stampImpliedMigrations(sqlite, already));
  }

  applied.sort((a, b) => a.version - b.version);
  return { applied };
}

/**
 * Read-only inspection of the migration state. Used by `agentis migrate
 * --dry-run` and integration tests.
 */
export function getSqliteMigrationStatus(sqlite: Database.Database): MigrationStatus {
  ensureMigrationsTable(sqlite);
  const rows = sqlite
    .prepare(
      'SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version',
    )
    .all() as Array<{ version: number; name: string; appliedAt: string }>;
  const appliedSet = new Set(rows.map((r) => r.version));
  const pending = SQLITE_MIGRATIONS.filter((m) => !appliedSet.has(m.version));
  return { applied: rows, pending };
}
