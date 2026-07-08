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

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i] ?? '';
    const next = sql[i + 1] ?? '';

    if (inLineComment) {
      current += char;
      if (char === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === '-' && next === '-') {
      current += char + next;
      i += 1;
      inLineComment = true;
      continue;
    }

    if (char === '/' && next === '*') {
      current += char + next;
      i += 1;
      inBlockComment = true;
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .trim();
}

function unquoteIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('`') && trimmed.endsWith('`'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return trimmed.slice(1, -1).replace(/""/g, '"').replace(/``/g, '`');
  }
  return trimmed;
}

function parseAddColumnStatement(statement: string): { table: string; column: string } | null {
  const normalized = stripSqlComments(statement);
  const match = normalized.match(
    /^ALTER\s+TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w]*)\s+ADD\s+(?:COLUMN\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w]*)\b/i,
  );
  if (!match) return null;

  const parts = normalized.match(
    /^ALTER\s+TABLE\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w]*))\s+ADD\s+(?:COLUMN\s+)?((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w]*))\b/i,
  );
  if (!parts) return null;
  return {
    table: unquoteIdentifier(parts[1] ?? ''),
    column: unquoteIdentifier(parts[2] ?? ''),
  };
}

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const rows = sqlite
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all(table) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function isDuplicateColumnError(error: unknown): boolean {
  return (
    error instanceof Error
    && /duplicate column name:/i.test(error.message)
  );
}

function execMigrationSql(sqlite: Database.Database, sql: string): void {
  for (const statement of splitSqlStatements(sql)) {
    try {
      sqlite.exec(statement);
    } catch (error) {
      const addColumn = parseAddColumnStatement(statement);
      if (addColumn && isDuplicateColumnError(error) && columnExists(sqlite, addColumn.table, addColumn.column)) {
        continue;
      }
      throw error;
    }
  }
}

function applyMigration(sqlite: Database.Database, migration: Migration): void {
  const tx = sqlite.transaction(() => {
    execMigrationSql(sqlite, migration.sql);
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
  const applied: Migration[] = [];

  // Defensive ordering — the runtime registry is already sorted by version,
  // but we sort again so a future hand-edit can't introduce silent mis-order.
  const ordered = [...SQLITE_MIGRATIONS].sort((a, b) => a.version - b.version);

  for (const migration of ordered) {
    if (already.has(migration.version)) continue;
    applyMigration(sqlite, migration);
    already.add(migration.version);
    applied.push(migration);
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



