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

  // PackagerService: agent personality fields.
  addColumn('agents', 'instructions', 'TEXT');
  addColumn('agents', 'avatar_glyph', 'TEXT');
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
  addColumn('workflows', 'concurrency_overflow', 'TEXT');
  addColumn('workflows', 'tags', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('workflows', 'intended_behavior', 'TEXT');
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
  addColumn('app_instances', 'space_id', 'TEXT REFERENCES spaces(id) ON DELETE SET NULL');
  addColumn('app_instances', 'intended_behavior', 'TEXT');
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

  // ── AGENTIS-PLATFORM-10X: 5-layer app model ─────────────────────────────
  // Owning-app pointer on workflows (data_write node resolves appId from here).
  addColumn('workflows', 'app_id', 'TEXT');
  // Deploy layer columns on app instances (§Layer 5).
  addColumn('app_instances', 'deploy_target', "TEXT NOT NULL DEFAULT 'local'");
  addColumn('app_instances', 'deploy_status', "TEXT NOT NULL DEFAULT 'stopped'");
  addColumn('app_instances', 'api_key_hash', 'TEXT');
  addColumn('knowledge_bases', 'app_id', 'TEXT REFERENCES app_instances(id) ON DELETE CASCADE');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_bases_scope ON knowledge_bases(workspace_id, app_id, created_at DESC)');
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

CREATE TABLE IF NOT EXISTS app_data_tables (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES app_instances(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  physical_name TEXT NOT NULL,
  description TEXT,
  schema_json TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_data_tables_app_name ON app_data_tables(app_id, name);
`);
  // async_jobs was created in migration v7 without priority or leased_at;
  // migration v30 drops and recreates it, but the embedded path uses CREATE TABLE IF NOT EXISTS
  // which is a no-op for pre-existing databases. Patch the drift here.
  addColumn('async_jobs', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
  addColumn('async_jobs', 'leased_at', 'TEXT');

  // ── Brain & Abilities Replan (docs/BRAIN-ABILITIES-REPLAN.md) ───────────
  // B5/B6 — atom lifecycle + managed/protected flags on the promotion target.
  addColumn('memory_episodes', 'status', "TEXT NOT NULL DEFAULT 'active'");
  addColumn('memory_episodes', 'managed', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('memory_episodes', 'pinned_at', 'TEXT');
  addColumn('memory_episodes', 'last_accessed_at', 'TEXT');
  addColumn('memory_episodes', 'is_disputed', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('memory_episodes', 'dispute_reason', 'TEXT');
  addColumn('memory_episodes', 'dispute_resolved_at', 'TEXT');
  addColumn('memory_episodes', 'dispute_snoozed_until', 'TEXT');
  addColumn('memory_episodes', 'context_condition', 'TEXT');
  addColumn('memory_episodes', 'compressed_from', 'TEXT');
  addColumn('memory_episodes', 'compression_tier', 'INTEGER');
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_memory_episodes_status ON memory_episodes(workspace_id, status, confidence)',
  );
  addColumn('knowledge_links', 'context_split', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('knowledge_links', 'resolved_at', 'TEXT');
  // B4 / U5 — per-workspace embedding provider + auxiliary adapter config.
  addColumn('workspaces', 'embedding_provider_type', "TEXT NOT NULL DEFAULT 'hashing'");
  addColumn('workspaces', 'embedding_provider_config', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('workspaces', 'auxiliary_adapter_config', 'TEXT');
  addColumn('workspaces', 'brain_settings', "TEXT NOT NULL DEFAULT '{}'");
  // Patch legacy Phase 1/2 tables before the CREATE INDEX statements below.
  // `CREATE TABLE IF NOT EXISTS` is a no-op for existing DBs, but indexes still
  // compile against the live table shape.
  addColumn('brain_promotion_queue', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
  addColumn('brain_promotion_queue', 'payload', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('brain_promotion_queue', 'status', "TEXT NOT NULL DEFAULT 'pending'");
  addColumn('brain_promotion_queue', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('brain_promotion_queue', 'last_attempt_at', 'TEXT');
  addColumn('brain_promotion_queue', 'fail_reason', 'TEXT');
  addColumn('brain_promotion_queue', 'created_at', 'TEXT');
  addColumn('brain_promotion_queue', 'updated_at', 'TEXT');
  addColumn('agent_abilities', 'workflow_id', 'TEXT');
  addColumn('agent_abilities', 'team_role', 'TEXT');
  addColumn('agent_abilities', 'version', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('agent_abilities', 'confidence', 'REAL NOT NULL DEFAULT 0.5');
  addColumn('agent_abilities', 'status', "TEXT NOT NULL DEFAULT 'active'");
  addColumn('peer_representations', 'peer_card', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('peer_representations', 'last_dream_at', 'TEXT');
  addColumn('peer_representation_conclusions', 'conclusion_type', "TEXT NOT NULL DEFAULT 'deductive'");
  addColumn('peer_representation_conclusions', 'volatility_class', "TEXT NOT NULL DEFAULT 'contextual'");
  addColumn('peer_representation_conclusions', 'supporting_session_count', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('peer_representation_conclusions', 'superseded_by_id', 'TEXT');
  addColumn('peer_representation_conclusions', 'status', "TEXT NOT NULL DEFAULT 'active'");
  // BL10 / Appendix B — durable promotion queue.
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS brain_promotion_queue (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_type       TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'normal',
  payload         TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  fail_reason     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bpq_pending ON brain_promotion_queue(workspace_id, priority, created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS brain_quality_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id       TEXT,
  agent_id     TEXT,
  event_type   TEXT NOT NULL,
  atom_id      TEXT,
  ability_id   TEXT,
  run_id       TEXT,
  delta        REAL,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bqe_workspace_type ON brain_quality_events(workspace_id, event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS brain_forget_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  topic TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',
  status TEXT NOT NULL DEFAULT 'pending',
  matches TEXT NOT NULL DEFAULT '{}',
  counts TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  executed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_brain_forget_requests_workspace
  ON brain_forget_requests(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_abilities (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id             TEXT,
  workflow_id          TEXT,
  team_role            TEXT,
  title                TEXT NOT NULL,
  content              TEXT NOT NULL,
  tags                 TEXT NOT NULL DEFAULT '[]',
  version              INTEGER NOT NULL DEFAULT 1,
  parent_ability_id    TEXT,
  changelog            TEXT NOT NULL DEFAULT '[]',
  confidence           REAL NOT NULL DEFAULT 0.5,
  reinforce_count      INTEGER NOT NULL DEFAULT 0,
  usage_count          INTEGER NOT NULL DEFAULT 0,
  source               TEXT NOT NULL,
  derived_from_package TEXT,
  derived_from_run_ids TEXT NOT NULL DEFAULT '[]',
  assertions           TEXT NOT NULL DEFAULT '[]',
  managed              INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'active',
  pinned_at            TEXT,
  last_used_at         TEXT,
  embedding            TEXT,
  context_atoms        TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_abilities_agent ON agent_abilities(agent_id, status, confidence);
CREATE INDEX IF NOT EXISTS idx_abilities_workflow ON agent_abilities(workflow_id, team_role, status);
CREATE INDEX IF NOT EXISTS idx_abilities_lineage ON agent_abilities(agent_id, title, version);

CREATE TABLE IF NOT EXISTS workspace_user_profiles (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_ws_user ON workspace_user_profiles(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS peer_representations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  peer_type    TEXT NOT NULL,
  peer_id      TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  peer_card    TEXT NOT NULL DEFAULT '[]',
  last_dream_at TEXT,
  embedding    TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_representations_unique ON peer_representations(workspace_id, peer_type, peer_id);

CREATE TABLE IF NOT EXISTS peer_representation_conclusions (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_peer_id   TEXT NOT NULL,
  observer_peer_id  TEXT NOT NULL,
  content           TEXT NOT NULL,
  source_session_id TEXT,
  confidence        REAL NOT NULL DEFAULT 0.7,
  conclusion_type   TEXT NOT NULL DEFAULT 'deductive',
  volatility_class  TEXT NOT NULL DEFAULT 'contextual',
  supporting_session_count INTEGER NOT NULL DEFAULT 1,
  superseded_by_id  TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  embedding         TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_peer_conclusions_subject ON peer_representation_conclusions(workspace_id, subject_peer_id, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_peer_conclusions_active ON peer_representation_conclusions(workspace_id, subject_peer_id, status, conclusion_type);

CREATE TABLE IF NOT EXISTS agent_peer_cards (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  observer_peer_id  TEXT NOT NULL,
  subject_peer_id   TEXT NOT NULL,
  subject_peer_type TEXT NOT NULL DEFAULT 'user',
  summary           TEXT NOT NULL DEFAULT '',
  peer_card         TEXT NOT NULL DEFAULT '[]',
  embedding         TEXT,
  last_dream_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_peer_cards_unique ON agent_peer_cards(workspace_id, observer_peer_id, subject_peer_id);

CREATE TABLE IF NOT EXISTS session_atoms (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id       TEXT,
  content      TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.6,
  embedding    TEXT,
  promoted_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_atoms_session ON session_atoms(session_id, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_session_atoms_expiry ON session_atoms(workspace_id, expires_at);

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
  addColumn('peer_representations', 'peer_card', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('peer_representations', 'last_dream_at', 'TEXT');
  addColumn('peer_representation_conclusions', 'conclusion_type', "TEXT NOT NULL DEFAULT 'deductive'");
  addColumn('peer_representation_conclusions', 'volatility_class', "TEXT NOT NULL DEFAULT 'contextual'");
  addColumn('peer_representation_conclusions', 'supporting_session_count', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('peer_representation_conclusions', 'superseded_by_id', 'TEXT');
  addColumn('peer_representation_conclusions', 'status', "TEXT NOT NULL DEFAULT 'active'");
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_peer_conclusions_active ON peer_representation_conclusions(workspace_id, subject_peer_id, status, conclusion_type)');
  addColumn('brain_quality_events', 'metadata', "TEXT NOT NULL DEFAULT '{}'");
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
