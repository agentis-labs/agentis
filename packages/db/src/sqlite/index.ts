import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';
import { EMBEDDED_INIT_SQL } from './embedded-sql.js';
import { runSqliteMigrations } from '../migrate.js';

export type AgentisSqliteDb = BetterSQLite3Database<typeof schema>;

export interface SqliteOpenOptions {
  /** Filesystem path to the database file. Will be created if missing. */
  path: string;
  /** Run embedded migrations on open. Defaults to true. */
  migrate?: boolean;
}

/**
 * Open the embedded SQLite database, ensure the directory exists, apply WAL,
 * enable foreign keys, and run migrations idempotently.
 *
 * Two migration layers run, in order:
 *   1. runEmbeddedMigrations — authoritative for the actual V1 schema: it
 *      execs EMBEDDED_INIT_SQL and applies the idempotent drift-patch
 *      ALTERs/rebuilds that keep pre-existing databases current.
 *   2. runSqliteMigrations — the versioned schema_migrations layer. Because
 *      step 1 already created the core tables, it backfills version 1 (the
 *      init) rather than re-running it, then applies any future versioned
 *      migrations. This is the authoritative *record* of applied versions.
 */
export function openSqlite(options: SqliteOpenOptions): { db: AgentisSqliteDb; sqlite: Database.Database } {
  mkdirSync(dirname(options.path), { recursive: true });
  const sqlite = new Database(options.path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  if (options.migrate !== false) {
    runEmbeddedMigrations(sqlite);
    runSqliteMigrations(sqlite);
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
  const tableExists = (table: string): boolean => {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name: string } | undefined;
    return Boolean(row);
  };
  const columnExists = (table: string, column: string): boolean => {
    if (!tableExists(table)) return false;
    const rows = sqlite
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(table) as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  };
  const addColumn = (table: string, column: string, ddl: string): void => {
    if (!tableExists(table)) return;
    if (!columnExists(table, column)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };

  // App Canvas: per-instance app graph (docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §12.4).
  addColumn('agent_packages', 'app_graph', 'TEXT');

  // Workspace issue queue defaults.
  addColumn('workspaces', 'issue_prefix', "TEXT NOT NULL DEFAULT 'AGT'");

  // Company OS layer (migration v2): conversation messages can be linked to an
  // issue. embedded-sql.ts predates this column — patch the drift here.
  addColumn('conversation_messages', 'issue_id', 'TEXT');
  addColumn('conversations', 'title', 'TEXT');
  addColumn('conversations', 'archived_at', 'TEXT');
  sqlite.exec(`
DROP INDEX IF EXISTS uq_conversation_agent;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_agent_active ON conversations(workspace_id, agent_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_history ON conversations(workspace_id, agent_id, archived_at, last_message_at);
`);

  // PackagerService: agent personality fields.
  addColumn('agents', 'instructions', 'TEXT');
  addColumn('agents', 'avatar_glyph', 'TEXT');
  addColumn('agents', 'avatar_url', 'TEXT');
  addColumn('agents', 'runtime_model', 'TEXT');
  addColumn('agents', 'role', 'TEXT');
  addColumn('agents', 'description', 'TEXT');
  addColumn('agents', 'space_id', 'TEXT');
  addColumn('agents', 'reports_to', 'TEXT REFERENCES agents(id) ON DELETE SET NULL');
  addColumn('agents', 'is_paused', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('agents', 'monthly_budget_cents', 'INTEGER');
  addColumn('agents', 'current_month_spend_cents', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('agents', 'budget_reset_day', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('agents', 'canvas_position', 'TEXT');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_agents_reports_to ON agents(workspace_id, reports_to)');
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS agents_workspace_orchestrator ON agents(workspace_id) WHERE role = 'orchestrator'");

  // PackagerService: workflow concurrency + tagging.
  addColumn('workflows', 'max_concurrent_runs', 'INTEGER');
  addColumn('workflows', 'concurrency_overflow', "TEXT NOT NULL DEFAULT 'queue'");
  addColumn('workflows', 'tags', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('workflows', 'intended_behavior', 'TEXT');
  // Normalize the concurrency_overflow column on databases created before it had
  // a default: older schemas added it NOT NULL with no default, so every insert
  // that omitted it failed with a NOT NULL constraint error. Rebuild the table
  // to NOT NULL DEFAULT 'queue' and backfill NULLs. Idempotent (no-op once
  // normalized). Must run after the addColumn calls above so the source table
  // has every column.
  migrateWorkflowsConcurrencyOverflow(sqlite);
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS workflow_run_queue (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ambient_id TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  trigger_id TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  inputs TEXT NOT NULL DEFAULT '{}',
  initial_state TEXT,
  graph_snapshot TEXT,
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scheduled_at TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  parent_run_id TEXT,
  chain_depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_queue_pending ON workflow_run_queue(workflow_id, status, scheduled_at, priority, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_workflow_run_queue_workspace ON workflow_run_queue(workspace_id, status, enqueued_at);

CREATE TABLE IF NOT EXISTS node_execution_cache (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, workflow_id, node_id, input_hash)
);
CREATE INDEX IF NOT EXISTS idx_cache_expiry ON node_execution_cache(expires_at);

CREATE TABLE IF NOT EXISTS workflow_event_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  target_workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  source_node_id TEXT,
  filter_expression TEXT,
  input_mapping TEXT NOT NULL DEFAULT '{}',
  coalesce_policy TEXT NOT NULL DEFAULT 'always_enqueue',
  catchup_policy TEXT NOT NULL DEFAULT 'enqueue_missed_with_cap:5',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_event_sub_source ON workflow_event_subscriptions(source_workflow_id, enabled);
CREATE INDEX IF NOT EXISTS idx_event_sub_target ON workflow_event_subscriptions(target_workflow_id, enabled);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  last_fired_at TEXT,
  missed_fires INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_schedule_due ON schedule_runs(status, scheduled_at);
`);

  migrateWorkflowRunsEphemeral(sqlite);
  addColumn('workflow_runs', 'conversation_id', 'TEXT REFERENCES conversations(id) ON DELETE SET NULL');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_runs_conversation ON workflow_runs(conversation_id, created_at DESC)');

  // Spaces: app grouping.
  addColumn('spaces', 'icon_glyph', 'TEXT');
  migrateChannelDeliveriesUniqueness(sqlite);

  sqlite.exec(`
CREATE TABLE IF NOT EXISTS async_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'normal',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_for TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error TEXT,
  leased_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_async_jobs_poll ON async_jobs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_async_jobs_workspace ON async_jobs(workspace_id, created_at);
`);
  // async_jobs was created in migration v7 without priority or leased_at;
  // migration v30 drops and recreates it, but the embedded path uses CREATE TABLE IF NOT EXISTS
  // which is a no-op for pre-existing databases. Patch the drift here.
  addColumn('async_jobs', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
  addColumn('async_jobs', 'leased_at', 'TEXT');

  sqlite.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS ledger_events_fts USING fts5(
  event_type,
  payload_text
);
CREATE TRIGGER IF NOT EXISTS ledger_events_fts_insert AFTER INSERT ON ledger_events BEGIN
  INSERT INTO ledger_events_fts(rowid, event_type, payload_text)
  VALUES (
    new.rowid,
    new.event_type,
    trim(
      coalesce(json_extract(new.payload, '$.content'), '') || ' ' ||
      coalesce(json_extract(new.payload, '$.output'), '') || ' ' ||
      coalesce(json_extract(new.payload, '$.summary'), '') || ' ' ||
      coalesce(json_extract(new.payload, '$.error'), '') || ' ' ||
      coalesce(new.payload, '')
    )
  );
END;
CREATE TRIGGER IF NOT EXISTS ledger_events_fts_delete AFTER DELETE ON ledger_events BEGIN
  DELETE FROM ledger_events_fts WHERE rowid = old.rowid;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
  body,
  content='conversation_messages',
  content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_insert AFTER INSERT ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_delete AFTER DELETE ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS conversation_messages_fts_update AFTER UPDATE ON conversation_messages BEGIN
  INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO conversation_messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
`);
}

function migrateWorkflowRunsEphemeral(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info('workflow_runs')").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const names = new Set(columns.map((column) => column.name));
  const workflowId = columns.find((column) => column.name === 'workflow_id');
  const hasAllEphemeralColumns = names.has('is_ephemeral') && names.has('ephemeral_title') && names.has('graph_snapshot');
  if (workflowId?.notnull === 0 && hasAllEphemeralColumns) return;

  const selectColumn = (name: string, fallback: string) => (names.has(name) ? name : fallback);
  sqlite.exec(`
PRAGMA foreign_keys = OFF;
CREATE TABLE IF NOT EXISTS workflow_runs_next (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id      TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  workflow_id     TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'CREATED',
  run_state       TEXT NOT NULL,
  replan_count    INTEGER NOT NULL DEFAULT 0,
  is_replay       INTEGER NOT NULL DEFAULT 0,
  is_ephemeral    INTEGER NOT NULL DEFAULT 0,
  ephemeral_title TEXT,
  graph_snapshot  TEXT,
  trigger_id      TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  parent_run_id   TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO workflow_runs_next (
  id, workspace_id, ambient_id, workflow_id, user_id, status, run_state, replan_count, is_replay,
  is_ephemeral, ephemeral_title, graph_snapshot, trigger_id, parent_run_id, started_at,
  completed_at, created_at, updated_at
)
SELECT
  id, workspace_id, ambient_id, workflow_id, user_id, status, run_state, replan_count, ${selectColumn('is_replay', '0')},
  ${selectColumn('is_ephemeral', '0')}, ${selectColumn('ephemeral_title', 'NULL')}, ${selectColumn('graph_snapshot', 'NULL')},
  trigger_id, parent_run_id, started_at, completed_at, created_at, updated_at
FROM workflow_runs;
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_next RENAME TO workflow_runs;
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_workspace_created ON workflow_runs(workspace_id, created_at DESC);
`);
}

function migrateWorkflowsConcurrencyOverflow(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info('workflows')").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  if (columns.length === 0) return; // table doesn't exist yet

  const overflow = columns.find((column) => column.name === 'concurrency_overflow');
  const alreadyNormalized = Boolean(
    overflow
      && overflow.notnull === 1
      && typeof overflow.dflt_value === 'string'
      && overflow.dflt_value.replace(/'/g, '').trim() === 'queue',
  );
  if (alreadyNormalized) return;

  const names = new Set(columns.map((column) => column.name));
  // Tolerate very old DBs that predate some columns by substituting a literal.
  const pick = (name: string, fallback: string) => (names.has(name) ? name : fallback);
  const overflowExpr = names.has('concurrency_overflow')
    ? "COALESCE(concurrency_overflow, 'queue')"
    : "'queue'";

  sqlite.exec(`
PRAGMA foreign_keys = OFF;
CREATE TABLE workflows_next (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id            TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registry_entry_id     TEXT,
  registry_version      TEXT,
  title                 TEXT NOT NULL,
  summary               TEXT,
  intended_behavior     TEXT,
  graph                 TEXT NOT NULL,
  settings              TEXT NOT NULL DEFAULT '{}',
  is_from_registry      INTEGER NOT NULL DEFAULT 0,
  max_concurrent_runs   INTEGER,
  concurrency_overflow  TEXT NOT NULL DEFAULT 'queue',
  tags                  TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO workflows_next (
  id, workspace_id, ambient_id, user_id, registry_entry_id, registry_version,
  title, summary, intended_behavior, graph, settings, is_from_registry,
  max_concurrent_runs, concurrency_overflow, tags, created_at, updated_at
)
SELECT
  id, workspace_id, ambient_id, user_id, ${pick('registry_entry_id', 'NULL')}, ${pick('registry_version', 'NULL')},
  title, summary, ${pick('intended_behavior', 'NULL')}, graph, settings, ${pick('is_from_registry', '0')},
  ${pick('max_concurrent_runs', 'NULL')}, ${overflowExpr}, ${pick('tags', "'[]'")}, created_at, updated_at
FROM workflows;
DROP TABLE workflows;
ALTER TABLE workflows_next RENAME TO workflows;
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS idx_workflows_workspace ON workflows(workspace_id);
`);
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
