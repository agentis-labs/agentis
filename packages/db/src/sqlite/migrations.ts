/**
 * Migration registry — SQLite dialect.
 *
 * Migrations are inlined as string literals (not loaded from .sql files) so
 * the bundled CLI distribution works whether running via tsx, tsc-compiled
 * dist/, or npm-tarball'd. There is no file resolution at runtime.
 *
 * Adding a migration:
 *   1. Pick the next version number (monotonic, no gaps).
 *   2. Add a new entry to SQLITE_MIGRATIONS with `version`, `name`, `sql`.
 *   3. The SQL must be idempotent against partial application and re-runs
 *      where reasonable (CREATE TABLE IF NOT EXISTS, ALTER TABLE wrapped in
 *      a defensive try/catch via DO blocks where applicable, etc.).
 *   4. Mirror the change in src/sqlite/schema.ts so drizzle stays in sync.
 *
 * Forward-only — V1 has no rollback infrastructure (REFACTORING.md P2). For
 * destructive changes, ship a follow-up migration that re-creates the prior
 * shape rather than rolling back.
 */

import { EMBEDDED_INIT_SQL } from './embedded-sql.js';

export interface Migration {
  /** Monotonic version. The first migration is 1, not 0. */
  readonly version: number;
  /** Short identifier shown in `agentis migrate --dry-run`. */
  readonly name: string;
  /** SQL applied inside a single transaction. */
  readonly sql: string;
}

export const SQLITE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: EMBEDDED_INIT_SQL,
  },
  {
    version: 2,
    name: 'company_os_layer',
    sql: `
ALTER TABLE workspaces ADD COLUMN description TEXT;
ALTER TABLE workspaces ADD COLUMN brand_color TEXT;
ALTER TABLE workspaces ADD COLUMN logo_url TEXT;
ALTER TABLE workspaces ADD COLUMN issue_prefix TEXT NOT NULL DEFAULT 'AGT';
ALTER TABLE workspaces ADD COLUMN require_approval_for_agents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN attachment_max_bytes INTEGER NOT NULL DEFAULT 5242880;

ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE agents ADD COLUMN reports_to TEXT;
ALTER TABLE agents ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN monthly_budget_cents INTEGER;
ALTER TABLE agents ADD COLUMN current_month_spend_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN budget_reset_day INTEGER NOT NULL DEFAULT 1;

ALTER TABLE conversation_messages ADD COLUMN issue_id TEXT;

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  assignee_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  linked_workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  active_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'medium',
  labels TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS issue_relations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS workspace_counters (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  counter_name TEXT NOT NULL,
  counter_value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, counter_name)
);

CREATE TABLE IF NOT EXISTS budget_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'paused',
  concurrency_policy TEXT NOT NULL DEFAULT 'coalesce_if_active',
  catch_up_policy TEXT NOT NULL DEFAULT 'skip_missed',
  variables TEXT NOT NULL DEFAULT '{}',
  last_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS routine_triggers (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger_kind TEXT NOT NULL,
  cron_expression TEXT,
  webhook_secret TEXT,
  signing_mode TEXT NOT NULL DEFAULT 'hmac_sha256',
  status TEXT NOT NULL DEFAULT 'active',
  last_fired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS inbox_dismissals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_issues_workspace_identifier ON issues(workspace_id, identifier);
CREATE INDEX IF NOT EXISTS idx_issues_workspace_status ON issues(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_budget_events_workspace_agent ON budget_events(workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_routines_workspace ON routines(workspace_id);
CREATE INDEX IF NOT EXISTS idx_inbox_dismissals_lookup ON inbox_dismissals(workspace_id, user_id, item_key);
`,
  },
  {
    version: 3,
    name: 'sprint_a_hitl_pause_resume',
    sql: `
CREATE TABLE IF NOT EXISTS paused_runs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL,
  context_id    TEXT NOT NULL UNIQUE,
  snapshot_data TEXT NOT NULL,
  pause_data    TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'paused',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_paused_runs_run ON paused_runs(run_id, status);
CREATE INDEX IF NOT EXISTS idx_paused_runs_workspace ON paused_runs(workspace_id, status);

CREATE TABLE IF NOT EXISTS resume_queue (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL,
  form_data  TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_resume_queue_run ON resume_queue(run_id, status);
`,
  },
  {
    version: 4,
    name: 'sprint_b_data_knowledge_files',
    sql: `
CREATE TABLE IF NOT EXISTS workspace_table_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  columns TEXT NOT NULL DEFAULT '[]',
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workspace_table_definitions_workspace ON workspace_table_definitions(workspace_id, archived_at);

CREATE TABLE IF NOT EXISTS workspace_table_rows (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES workspace_table_definitions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  source_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workspace_table_rows_table ON workspace_table_rows(table_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workspace_table_rows_run ON workspace_table_rows(run_id);
CREATE INDEX IF NOT EXISTS idx_workspace_table_rows_agent ON workspace_table_rows(source_agent_id);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  embedding_model TEXT NOT NULL DEFAULT 'lexical-v1',
  embedding_dimension INTEGER NOT NULL DEFAULT 0,
  chunking_config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_workspace ON knowledge_bases(workspace_id);

CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  status TEXT NOT NULL DEFAULT 'ready',
  token_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_documents_kb ON kb_documents(knowledge_base_id, status);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(knowledge_base_id, chunk_index);

CREATE TABLE IF NOT EXISTS workspace_files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  source_document_id TEXT REFERENCES kb_documents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace ON workspace_files(workspace_id, created_at);
`,
  },
  {
    version: 5,
    name: 'sprint_c_deployments_mcp',
    sql: `
CREATE TABLE IF NOT EXISTS workflow_deployments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  ambient_id TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  graph_snapshot TEXT NOT NULL,
  input_schema TEXT NOT NULL DEFAULT '{}',
  output_schema TEXT NOT NULL DEFAULT '{}',
  api_key_hash TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'sync',
  public_access INTEGER NOT NULL DEFAULT 0,
  chat_enabled INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_deployments_workspace ON workflow_deployments(workspace_id, workflow_id, version);
CREATE INDEX IF NOT EXISTS idx_workflow_deployments_key ON workflow_deployments(api_key_hash);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  direction TEXT NOT NULL,
  url TEXT,
  auth_type TEXT NOT NULL DEFAULT 'none',
  api_key_encrypted TEXT,
  api_key_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_workspace ON mcp_servers(workspace_id, direction);

CREATE TABLE IF NOT EXISTS mcp_server_tools (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES workflow_deployments(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(server_id, tool_name)
);
CREATE INDEX IF NOT EXISTS idx_mcp_server_tools_server ON mcp_server_tools(server_id);
`,
  },
  {
    version: 6,
    name: 'sprint_d_run_observability',
    sql: `
ALTER TABLE workflow_runs ADD COLUMN block_data TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflow_runs ADD COLUMN trace_spans TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workflow_runs ADD COLUMN token_usage TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflow_runs ADD COLUMN cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_runs ADD COLUMN graph_snapshot_hash TEXT;
ALTER TABLE workflow_runs ADD COLUMN graph_snapshot TEXT;
`,
  },
  {
    version: 7,
    name: 'sprint_e_integration_reliability',
    sql: `
CREATE TABLE IF NOT EXISTS workflow_nodes (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  position TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(workflow_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow ON workflow_nodes(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_nodes_type ON workflow_nodes(workflow_id, type);

CREATE TABLE IF NOT EXISTS workflow_edges (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  edge_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  source_handle TEXT,
  target_handle TEXT,
  condition TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(workflow_id, edge_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_edges_workflow ON workflow_edges(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_edges_source ON workflow_edges(workflow_id, source_node_id);

CREATE TABLE IF NOT EXISTS workflow_subflows (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  subflow_id TEXT NOT NULL,
  type TEXT NOT NULL,
  node_ids TEXT NOT NULL DEFAULT '[]',
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(workflow_id, subflow_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_subflows_workflow ON workflow_subflows(workflow_id);

CREATE TABLE IF NOT EXISTS async_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_for TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_async_jobs_status ON async_jobs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_async_jobs_workspace ON async_jobs(workspace_id, created_at);
`,
  },
  {
    version: 8,
    name: 'fleet_command_layer',
    sql: `
ALTER TABLE agents ADD COLUMN instructions TEXT;
ALTER TABLE agents ADD COLUMN avatar_glyph TEXT;
ALTER TABLE agents ADD COLUMN runtime_model TEXT;
`,
  },
  {
    version: 9,
    name: 'engine_10x_foundation',
    sql: `
ALTER TABLE workflows ADD COLUMN max_concurrent_runs INTEGER;
ALTER TABLE workflows ADD COLUMN concurrency_overflow TEXT NOT NULL DEFAULT 'queue';
ALTER TABLE workflow_edges ADD COLUMN data_contract TEXT;

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
`,
  },
  {
    version: 10,
    name: 'approval_metadata',
    sql: `
ALTER TABLE approval_requests ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    version: 11,
    name: 'library_packages',
    sql: `
CREATE TABLE IF NOT EXISTS packages (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id    TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL DEFAULT '1.0.0',
  kind          TEXT NOT NULL,
  description   TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  contents      TEXT NOT NULL,
  source_id     TEXT,
  source_kind   TEXT,
  checksum      TEXT,
  remote_id     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_packages_workspace_slug ON packages(workspace_id, slug);
CREATE INDEX IF NOT EXISTS idx_packages_workspace_kind ON packages(workspace_id, kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_packages_remote ON packages(remote_id);
`,
  },
  {
    version: 12,
    name: 'fleet_organization_layer',
    sql: `
CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id TEXT NOT NULL REFERENCES ambients(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT,
  icon_glyph  TEXT,
  color_hex   TEXT,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_ambient ON teams(ambient_id);
CREATE INDEX IF NOT EXISTS idx_teams_workspace ON teams(workspace_id, updated_at DESC);

INSERT OR IGNORE INTO teams (id, workspace_id, ambient_id, user_id, name, slug, description, icon_glyph, color_hex, profile_json, created_at, updated_at)
SELECT
  a.id,
  a.workspace_id,
  a.id,
  a.user_id,
  a.name,
  lower(replace(replace(trim(a.name), ' ', '-'), '_', '-')),
  CASE WHEN a.kind = 'local' THEN 'Default local execution team.' ELSE a.kind || ' execution team.' END,
  CASE WHEN a.kind IN ('prod', 'production') THEN 'P' WHEN a.kind = 'staging' THEN 'S' WHEN a.kind IN ('dev', 'development') THEN 'D' ELSE 'T' END,
  NULL,
  json_object('ambientKind', a.kind, 'settings', json(a.settings)),
  a.created_at,
  a.updated_at
FROM ambients a;

CREATE TABLE IF NOT EXISTS team_context (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operating_principles TEXT NOT NULL DEFAULT '',
  constraints TEXT NOT NULL DEFAULT '',
  handoffs TEXT NOT NULL DEFAULT '',
  success_metrics TEXT NOT NULL DEFAULT '',
  escalation_rules TEXT NOT NULL DEFAULT '',
  shared_prompt TEXT NOT NULL DEFAULT '',
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_context_team ON team_context(team_id);
CREATE INDEX IF NOT EXISTS idx_team_context_workspace ON team_context(workspace_id, updated_at DESC);

INSERT OR IGNORE INTO team_context (id, team_id, workspace_id, user_id, operating_principles, constraints, handoffs, success_metrics, escalation_rules, shared_prompt, updated_by_user_id, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + abs(random()) % 4, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  t.id,
  t.workspace_id,
  t.user_id,
  '',
  '',
  '',
  '',
  '',
  '',
  t.user_id,
  t.created_at,
  t.updated_at
FROM teams t;

CREATE TABLE IF NOT EXISTS memory_entries (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id     TEXT REFERENCES teams(id) ON DELETE SET NULL,
  agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL DEFAULT 'operator',
  source_id   TEXT,
  kind        TEXT NOT NULL DEFAULT 'note',
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  importance  INTEGER NOT NULL DEFAULT 5,
  confidence  REAL NOT NULL DEFAULT 1,
  tags        TEXT NOT NULL DEFAULT '[]',
  metadata    TEXT NOT NULL DEFAULT '{}',
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_workspace_time ON memory_entries(workspace_id, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_team_time ON memory_entries(team_id, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_agent_time ON memory_entries(agent_id, archived_at, updated_at DESC);


ALTER TABLE approval_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'decision';
ALTER TABLE approval_requests ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approval_requests ADD COLUMN snoozed_until TEXT;
ALTER TABLE approval_requests ADD COLUMN dismissed_at TEXT;
ALTER TABLE approval_requests ADD COLUMN artifact_url TEXT;
UPDATE approval_requests SET kind = source WHERE kind = 'decision';
CREATE INDEX IF NOT EXISTS idx_approvals_plus_pending ON approval_requests(workspace_id, status, dismissed_at, snoozed_until, priority, created_at);
`,
  },
  {
    version: 13,
    name: 'agentis_ux_v2_artifacts_and_rooms',
    sql: `
-- ── Artifacts (V2 §5) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  workflow_id     TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  node_id         TEXT,
  type            TEXT NOT NULL DEFAULT 'document',
  title           TEXT NOT NULL,
  content         TEXT NOT NULL DEFAULT '',
  thumbnail_url   TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_time ON artifacts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(workspace_id, type, created_at DESC);

-- ── Rooms (V2 §6.3) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rooms (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id         TEXT REFERENCES teams(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'custom',
  name            TEXT NOT NULL,
  description     TEXT,
  is_team_default INTEGER NOT NULL DEFAULT 0,
  visibility      TEXT NOT NULL DEFAULT 'workspace',
  pinned_at       TEXT,
  last_message_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_rooms_workspace ON rooms(workspace_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_team ON rooms(team_id);

CREATE TABLE IF NOT EXISTS room_agents (
  room_id  TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  added_by TEXT NOT NULL DEFAULT 'system',
  PRIMARY KEY (room_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_room_agents_agent ON room_agents(agent_id);

CREATE TABLE IF NOT EXISTS room_messages (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_type  TEXT NOT NULL,
  author_id    TEXT,
  content_type TEXT NOT NULL DEFAULT 'text',
  content      TEXT NOT NULL DEFAULT '{}',
  reply_to_id  TEXT,
  mentions     TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_room_messages_room_time ON room_messages(room_id, created_at DESC);

-- ── Backfill: one default room per existing team ────────────────────
INSERT OR IGNORE INTO rooms (id, workspace_id, user_id, team_id, kind, name, description, is_team_default, visibility, last_message_at, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
  t.workspace_id,
  t.user_id,
  t.id,
  'team',
  t.name,
  'Default room for ' || t.name,
  1,
  'team',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM teams t
WHERE NOT EXISTS (
  SELECT 1 FROM rooms r WHERE r.team_id = t.id AND r.is_team_default = 1
);

-- ── Backfill: room_agents left empty; populated as agents join via API.
`,
  },
  {
    version: 14,
    name: 'webhook_event_log',
    sql: `
CREATE TABLE IF NOT EXISTS webhook_events (
  id              TEXT PRIMARY KEY,
  trigger_id      TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_id     TEXT,
  received_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  method          TEXT NOT NULL DEFAULT 'POST',
  headers         TEXT NOT NULL DEFAULT '{}',
  query           TEXT NOT NULL DEFAULT '{}',
  raw_body        TEXT NOT NULL DEFAULT '',
  payload         TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL,
  response_run_id TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_trigger_time ON webhook_events(trigger_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_workspace_time ON webhook_events(workspace_id, received_at DESC);
`,
  },
  {
    version: 18,
    name: 'agentis_app_runtime',
    sql: `
CREATE TABLE IF NOT EXISTS app_instances (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id            TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id            TEXT REFERENCES packages(id) ON DELETE SET NULL,
  slug                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  version               TEXT NOT NULL DEFAULT '1.0.0',
  status                TEXT NOT NULL DEFAULT 'setup',
  entry_workflow_id     TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  package_contents      TEXT NOT NULL,
  credential_bindings   TEXT NOT NULL DEFAULT '{}',
  dataset_statuses      TEXT NOT NULL DEFAULT '[]',
  knowledge_base_ids    TEXT NOT NULL DEFAULT '{}',
  activated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paused_at             TEXT,
  last_run_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_instances_workspace_slug ON app_instances(workspace_id, slug);
CREATE INDEX IF NOT EXISTS idx_app_instances_workspace_status ON app_instances(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_instances_package ON app_instances(package_id);

CREATE TABLE IF NOT EXISTS data_ingestion_jobs (
  id                        TEXT PRIMARY KEY,
  app_instance_id           TEXT NOT NULL REFERENCES app_instances(id) ON DELETE CASCADE,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dataset_key               TEXT NOT NULL,
  source_format             TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'pending',
  total_items               INTEGER NOT NULL DEFAULT 0,
  processed_items           INTEGER NOT NULL DEFAULT 0,
  error_items               INTEGER NOT NULL DEFAULT 0,
  byte_size                 INTEGER NOT NULL DEFAULT 0,
  chunk_count               INTEGER NOT NULL DEFAULT 0,
  embedding_count           INTEGER NOT NULL DEFAULT 0,
  estimated_completion_at   TEXT,
  error_message             TEXT,
  started_at                TEXT,
  completed_at              TEXT,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_data_ingestion_jobs_app_dataset ON data_ingestion_jobs(app_instance_id, dataset_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_ingestion_jobs_workspace_status ON data_ingestion_jobs(workspace_id, status, updated_at DESC);

UPDATE packages
SET kind = 'agentis',
    contents = '{"kind":"agentis","agents":[],"skills":[],"workflows":[],"integrations":[],"credentialSlots":[],"datasetSpecs":[],"knowledgeSeeds":[],"evaluatorRubrics":[],"workflowBaselines":[],"screenshotUrls":[],"crossAppDependencies":[]}',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE kind = 'bundle';

UPDATE packages
SET source_kind = 'agentis'
WHERE source_kind = 'bundle';
`,
  },
  {
    version: 19,
    name: 'agentis_app_spec_foundations',
    sql: `
ALTER TABLE workflow_runs ADD COLUMN trace_id TEXT;
ALTER TABLE ledger_events ADD COLUMN payload_hash TEXT;
ALTER TABLE ledger_events ADD COLUMN signature_pem TEXT;
ALTER TABLE ledger_events ADD COLUMN trace_id TEXT;

ALTER TABLE data_ingestion_jobs ADD COLUMN current_phase TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE data_ingestion_jobs ADD COLUMN progress_message TEXT;
ALTER TABLE data_ingestion_jobs ADD COLUMN source_hash TEXT;
ALTER TABLE data_ingestion_jobs ADD COLUMN preview_rows TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  subject_kind TEXT NOT NULL DEFAULT 'workspace',
  subject_id TEXT,
  effect TEXT NOT NULL DEFAULT 'allow',
  rules TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  priority INTEGER NOT NULL DEFAULT 0,
  last_evaluated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_policies_workspace_subject ON policies(workspace_id, subject_kind, subject_id, status, priority);

CREATE TABLE IF NOT EXISTS policy_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_id TEXT REFERENCES policies(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  node_id TEXT,
  subject_kind TEXT NOT NULL DEFAULT 'workspace',
  subject_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  input TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_policy_decisions_workspace_time ON policy_decisions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_policy_decisions_run ON policy_decisions(run_id);

CREATE TABLE IF NOT EXISTS eval_suites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_instance_id TEXT REFERENCES app_instances(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  dataset_key TEXT,
  rubric TEXT NOT NULL DEFAULT '{}',
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_eval_suites_workspace ON eval_suites(workspace_id, app_instance_id, workflow_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '{}',
  expected TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_eval_cases_suite ON eval_cases(suite_id, created_at);

CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_instance_id TEXT REFERENCES app_instances(id) ON DELETE SET NULL,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',
  score REAL NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  total_cases INTEGER NOT NULL DEFAULT 0,
  passed_cases INTEGER NOT NULL DEFAULT 0,
  failed_cases INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  metrics TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_eval_results_suite_time ON eval_results(suite_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_results_workspace ON eval_results(workspace_id, created_at DESC);
`,
  },
  {
    version: 20,
    name: 'workflow_tags',
    sql: `
ALTER TABLE workflows ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    version: 21,
    name: 'workflow_run_replay_flag',
    sql: `
ALTER TABLE workflow_runs ADD COLUMN is_replay INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 22,
    name: 'workflow_graph_revisions',
    sql: `
CREATE TABLE IF NOT EXISTS workflow_graph_revisions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  graph TEXT NOT NULL,
  reason TEXT NOT NULL,
  message TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_graph_revisions_number ON workflow_graph_revisions(workflow_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_workflow_graph_revisions_workflow ON workflow_graph_revisions(workspace_id, workflow_id, created_at DESC);
`,
  },
  {
    version: 23,
    name: 'agent_capability_version',
    sql: `
ALTER TABLE agents ADD COLUMN capability_version INTEGER NOT NULL DEFAULT 1;
`,
  },
  {
    version: 24,
    name: 'channel_agentic_flag',
    sql: `
ALTER TABLE channel_connections ADD COLUMN agentic INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 25,
    name: 'spaces',
    sql: `
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_spaces_workspace ON spaces(workspace_id, name);
ALTER TABLE app_instances ADD COLUMN space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_app_instances_space ON app_instances(space_id);
`,
  },
  {
    version: 26,
    name: 'collective_brain',
    sql: `
ALTER TABLE app_memory ADD COLUMN adapter_type TEXT;
ALTER TABLE app_memory ADD COLUMN global_confidence TEXT NOT NULL DEFAULT '0';
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
`,
  },
];
