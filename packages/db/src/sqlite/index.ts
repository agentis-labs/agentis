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

  // PackagerService: agent personality fields.
  addColumn('agents', 'instructions', 'TEXT');
  addColumn('agents', 'avatar_glyph', 'TEXT');
  addColumn('agents', 'runtime_model', 'TEXT');
  addColumn('agents', 'role', 'TEXT');

  // PackagerService: workflow concurrency + tagging.
  addColumn('workflows', 'max_concurrent_runs', 'INTEGER');
  addColumn('workflows', 'concurrency_overflow', 'TEXT');
  addColumn('workflows', 'tags', "TEXT NOT NULL DEFAULT '[]'");

  // Spaces: app grouping.
  addColumn('app_instances', 'space_id', 'TEXT REFERENCES spaces(id) ON DELETE SET NULL');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_app_instances_space ON app_instances(workspace_id, space_id)');

  // Collective Brain: cross-agent graph provenance.
  addColumn('app_memory', 'adapter_type', 'TEXT');
  addColumn('app_memory', 'global_confidence', "TEXT NOT NULL DEFAULT '0'");
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS knowledge_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  reinforce_count INTEGER NOT NULL DEFAULT 1,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  adapter_type TEXT,
  run_id TEXT,
  app_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_workspace ON knowledge_links(workspace_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_source ON knowledge_links(workspace_id, source_id, source_kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_target ON knowledge_links(workspace_id, target_id, target_kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_agent ON knowledge_links(workspace_id, agent_id);
`);
  migrateChannelDeliveriesUniqueness(sqlite);
}

function migrateChannelDeliveriesUniqueness(sqlite: Database.Database): void {
  const indexes = sqlite.prepare("PRAGMA index_list('channel_deliveries')").all() as Array<{
    name: string;
    unique: number;
  }>;
  const hasGlobalExternalIdUnique = indexes.some((index) => {
    if (!index.unique) return false;
    const columns = sqlite.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>;
    return columns.length === 1 && columns[0]?.name === 'external_id';
  });
  if (hasGlobalExternalIdUnique) {
    sqlite.exec(`
CREATE TABLE IF NOT EXISTS channel_deliveries_next (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  conversation_message_id TEXT
);
INSERT OR IGNORE INTO channel_deliveries_next (id, connection_id, workspace_id, external_id, received_at, conversation_message_id)
  SELECT id, connection_id, workspace_id, external_id, received_at, conversation_message_id FROM channel_deliveries;
DROP TABLE channel_deliveries;
ALTER TABLE channel_deliveries_next RENAME TO channel_deliveries;
`);
  }
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_delivery_conn_external ON channel_deliveries(connection_id, external_id)');
}

export { schema };
