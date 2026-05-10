import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';
import { EMBEDDED_INIT_SQL } from './embedded-sql.js';

export type AgentisSqliteDb = BetterSQLite3Database<typeof schema>;

export interface SqliteOpenOptions {
  /** Filesystem path to the database file. Will be created if missing. */
  path: string;
  /** Run embedded migrations on open. Defaults to true. */
  migrate?: boolean;
}

/**
 * Open the embedded SQLite database, ensure the directory exists, apply WAL,
 * enable foreign keys, and run hand-authored migrations idempotently.
 */
export function openSqlite(options: SqliteOpenOptions): { db: AgentisSqliteDb; sqlite: Database.Database } {
  mkdirSync(dirname(options.path), { recursive: true });
  const sqlite = new Database(options.path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  if (options.migrate !== false) {
    runEmbeddedMigrations(sqlite);
  }

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function runEmbeddedMigrations(sqlite: Database.Database): void {
  // Embedded migrations are inlined as a string literal in embedded-sql.ts
  // so distribution stays a single JS bundle with zero file-resolution risk.
  sqlite.exec(EMBEDDED_INIT_SQL);

  // ── Idempotent column additions ─────────────────────────────────────────
  // For pre-existing databases, the CREATE TABLE statements above are no-ops
  // (IF NOT EXISTS), so newly added columns must be added explicitly via
  // ALTER TABLE. SQLite has no `ADD COLUMN IF NOT EXISTS`; we check
  // pragma_table_info first.
  const columnExists = (table: string, column: string): boolean => {
    const rows = sqlite
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(table) as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  };
  const addColumn = (table: string, column: string, ddl: string): void => {
    if (!columnExists(table, column)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };

  // App Canvas: per-instance app graph (docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §12.4).
  addColumn('agent_packages', 'app_graph', 'TEXT');
}

export { schema };
