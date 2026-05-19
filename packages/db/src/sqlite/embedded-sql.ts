/**
 * Embedded migration SQL.
 *
 * Inlined as a string literal so the embedded driver works whether Agentis
 * is run via tsx (dev), tsc-compiled (built dist/), or bundled into the CLI.
 * If you change this, also update src/sqlite/migrations/0000_init.sql for
 * generators that consume the .sql file directly (e.g. drizzle-kit).
 */
export const EMBEDDED_INIT_SQL = String.raw`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT,
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  is_admin        INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL,
  default_ambient_id  TEXT,
  issue_prefix        TEXT NOT NULL DEFAULT 'AGT',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, slug)
);

CREATE TABLE IF NOT EXISTS ambients (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'local',
  settings     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ambients_workspace ON ambients(workspace_id);

CREATE TABLE IF NOT EXISTS spaces (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT,
  icon_glyph   TEXT,
  team_id      TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_spaces_workspace ON spaces(workspace_id);

CREATE TABLE IF NOT EXISTS openclaw_gateways (
  id                          TEXT PRIMARY KEY,
  workspace_id                TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id                  TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id                     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  gateway_url                 TEXT NOT NULL,
  device_token_credential_id  TEXT,
  status                      TEXT NOT NULL DEFAULT 'disconnected',
  last_heartbeat_at           TEXT,
  last_sync_at                TEXT,
  health_snapshot             TEXT NOT NULL DEFAULT '{}',
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_gateways_workspace ON openclaw_gateways(workspace_id);

CREATE TABLE IF NOT EXISTS credentials (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id        TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  credential_type   TEXT NOT NULL,
  encrypted_value   TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_credentials_workspace ON credentials(workspace_id);

CREATE TABLE IF NOT EXISTS agent_packages (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id    TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registry_entry_id  TEXT,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  manifest      TEXT NOT NULL,
  app_graph     TEXT,                                          -- App Canvas: instance system-composition graph (JSON, nullable)
  installed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id          TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gateway_id          TEXT REFERENCES openclaw_gateways(id) ON DELETE SET NULL,
  package_id          TEXT REFERENCES agent_packages(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  space_id            TEXT,
  adapter_type        TEXT NOT NULL,
  capability_tags     TEXT NOT NULL DEFAULT '[]',
  config              TEXT NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'offline',
  last_heartbeat_at   TEXT,
  current_task_id     TEXT,
  color_hex           TEXT,
  instructions        TEXT,
  avatar_glyph        TEXT,
  runtime_model       TEXT,
  role                TEXT,
  reports_to          TEXT REFERENCES agents(id) ON DELETE SET NULL,
  is_paused           INTEGER NOT NULL DEFAULT 0,
  monthly_budget_cents INTEGER,
  current_month_spend_cents INTEGER NOT NULL DEFAULT 0,
  budget_reset_day    INTEGER NOT NULL DEFAULT 1,
  canvas_position     TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agents_gateway ON agents(gateway_id);
CREATE INDEX IF NOT EXISTS idx_agents_reports_to ON agents(workspace_id, reports_to);
CREATE UNIQUE INDEX IF NOT EXISTS agents_workspace_orchestrator ON agents(workspace_id) WHERE role = 'orchestrator';

CREATE TABLE IF NOT EXISTS skills (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id    TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id    TEXT REFERENCES agent_packages(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  version       TEXT NOT NULL,
  runtime       TEXT NOT NULL,
  manifest      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_skills_workspace ON skills(workspace_id);
CREATE INDEX IF NOT EXISTS idx_skills_slug ON skills(workspace_id, slug);

CREATE TABLE IF NOT EXISTS skill_executions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id      TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  run_id        TEXT,
  task_id       TEXT,
  status        TEXT NOT NULL,
  duration_ms   INTEGER,
  error_code    TEXT,
  error_message TEXT,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_executions_run ON skill_executions(run_id);

CREATE TABLE IF NOT EXISTS workflows (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id            TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registry_entry_id     TEXT,
  registry_version      TEXT,
  title                 TEXT NOT NULL,
  summary               TEXT,
  graph                 TEXT NOT NULL,
  settings              TEXT NOT NULL DEFAULT '{}',
  is_from_registry      INTEGER NOT NULL DEFAULT 0,
  max_concurrent_runs   INTEGER,
  concurrency_overflow  TEXT,
  tags                  TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workflows_workspace ON workflows(workspace_id);

CREATE TABLE IF NOT EXISTS triggers (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id      TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_type    TEXT NOT NULL,
  config          TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'paused',
  last_fired_at   TEXT,
  webhook_secret  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_triggers_workflow ON triggers(workflow_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
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
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_workspace_created ON workflow_runs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_run_snapshots (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  run_state       TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_run_seq ON workflow_run_snapshots(run_id, sequence_number DESC);

CREATE TABLE IF NOT EXISTS workflow_run_queue (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ambient_id      TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  trigger_id      TEXT REFERENCES triggers(id) ON DELETE SET NULL,
  inputs          TEXT NOT NULL DEFAULT '{}',
  initial_state   TEXT,
  graph_snapshot  TEXT,
  enqueued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  scheduled_at    TEXT,
  priority        INTEGER NOT NULL DEFAULT 0,
  reason          TEXT NOT NULL,
  parent_run_id   TEXT,
  chain_depth     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_queue_pending ON workflow_run_queue(workflow_id, status, scheduled_at, priority, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_workflow_run_queue_workspace ON workflow_run_queue(workspace_id, status, enqueued_at);

CREATE TABLE IF NOT EXISTS node_execution_cache (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id         TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  output          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at      TEXT NOT NULL,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  byte_size       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, workflow_id, node_id, input_hash)
);
CREATE INDEX IF NOT EXISTS idx_cache_expiry ON node_execution_cache(expires_at);

CREATE TABLE IF NOT EXISTS workflow_event_subscriptions (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  target_workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  source_node_id    TEXT,
  filter_expression TEXT,
  input_mapping     TEXT NOT NULL DEFAULT '{}',
  coalesce_policy   TEXT NOT NULL DEFAULT 'always_enqueue',
  catchup_policy    TEXT NOT NULL DEFAULT 'enqueue_missed_with_cap:5',
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_event_sub_source ON workflow_event_subscriptions(source_workflow_id, enabled);
CREATE INDEX IF NOT EXISTS idx_event_sub_target ON workflow_event_subscriptions(target_workflow_id, enabled);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger_id      TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  scheduled_at    TEXT NOT NULL,
  last_fired_at   TEXT,
  missed_fires    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_schedule_due ON schedule_runs(status, scheduled_at);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id      TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id),
  node_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  executor_type   TEXT NOT NULL,
  executor_ref    TEXT NOT NULL,
  capability_tags TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'PENDING',
  input_data      TEXT NOT NULL DEFAULT '{}',
  output_data     TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);

CREATE TABLE IF NOT EXISTS ledger_events (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id      TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  run_id          TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  event_type      TEXT NOT NULL,
  node_id         TEXT,
  task_id         TEXT,
  payload         TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_run_seq ON ledger_events(run_id, sequence_number);

CREATE TABLE IF NOT EXISTS activity_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id    TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  summary       TEXT NOT NULL,
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_ws_created ON activity_events(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS approval_requests (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id        TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id            TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
  task_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  gateway_id        TEXT REFERENCES openclaw_gateways(id) ON DELETE SET NULL,
  source            TEXT NOT NULL,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  confidence        INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending',
  resolution_reason TEXT,
  resolved_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approval_requests(workspace_id, status);

CREATE TABLE IF NOT EXISTS conversations (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id            TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mirrored_session_id   TEXT,
  unread_count          INTEGER NOT NULL DEFAULT 0,
  last_message_at       TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_agent ON conversations(workspace_id, agent_id);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_type         TEXT NOT NULL,
  author_id           TEXT,
  session_message_id  TEXT,
  body                TEXT NOT NULL,
  metadata            TEXT NOT NULL DEFAULT '{}',
  delivery_status     TEXT NOT NULL DEFAULT 'sent',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS rooms (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id           TEXT,
  kind              TEXT NOT NULL DEFAULT 'custom',
  name              TEXT NOT NULL,
  description       TEXT,
  is_team_default   INTEGER NOT NULL DEFAULT 0,
  visibility        TEXT NOT NULL DEFAULT 'workspace',
  pinned_at         TEXT,
  last_message_at   TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_rooms_workspace_last ON rooms(workspace_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS room_agents (
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  added_by   TEXT,
  PRIMARY KEY (room_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_room_agents_agent ON room_agents(agent_id);

CREATE TABLE IF NOT EXISTS room_messages (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_type   TEXT NOT NULL,
  author_id     TEXT,
  content_type  TEXT NOT NULL DEFAULT 'text',
  content       TEXT NOT NULL DEFAULT '{}',
  reply_to_id   TEXT,
  mentions      TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_room_messages_room_time ON room_messages(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS installed_registry_artifacts (
  id                            TEXT PRIMARY KEY,
  workspace_id                  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id                    TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id                       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id                      TEXT NOT NULL,
  entry_type                    TEXT NOT NULL,
  version                       TEXT NOT NULL,
  sha256                        TEXT NOT NULL,
  local_resource_id             TEXT NOT NULL,
  permissions_acknowledged_at   TEXT NOT NULL,
  installed_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_registry_install_ws ON installed_registry_artifacts(workspace_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                TEXT PRIMARY KEY,
  trigger_id        TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_id       TEXT NOT NULL UNIQUE,
  received_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status            TEXT NOT NULL,
  response_run_id   TEXT
);

CREATE TABLE IF NOT EXISTS channel_connections (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id        TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  name              TEXT NOT NULL,
  token_encrypted   TEXT NOT NULL,
  webhook_secret    TEXT,
  settings          TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'active',
  last_event_at     TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_channel_conn_ws ON channel_connections(workspace_id);
CREATE INDEX IF NOT EXISTS idx_channel_conn_agent ON channel_connections(agent_id);

CREATE TABLE IF NOT EXISTS channel_deliveries (
  id                        TEXT PRIMARY KEY,
  connection_id             TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id               TEXT NOT NULL,
  received_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  conversation_message_id   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_delivery_conn_external ON channel_deliveries(connection_id, external_id);
-- Package library (PackagerService)
CREATE TABLE IF NOT EXISTS library_packages (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id   TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  version      TEXT NOT NULL DEFAULT '1.0.0',
  kind         TEXT NOT NULL,
  description  TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  contents     TEXT NOT NULL DEFAULT '{}',
  source_id    TEXT,
  source_kind  TEXT,
  checksum     TEXT,
  remote_id    TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_library_packages_ws ON library_packages(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_library_packages_slug ON library_packages(workspace_id, slug);

-- Knowledge bases, documents, chunks
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,
  embedding_model     TEXT NOT NULL DEFAULT 'lexical-v1',
  embedding_dimension INTEGER NOT NULL DEFAULT 0,
  chunking_config     TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_ws ON knowledge_bases(workspace_id);

CREATE TABLE IF NOT EXISTS kb_documents (
  id                TEXT PRIMARY KEY,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  mime_type         TEXT NOT NULL DEFAULT 'text/plain',
  status            TEXT NOT NULL DEFAULT 'pending',
  token_count       INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  archived_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_documents_kb ON kb_documents(knowledge_base_id);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL DEFAULT 0,
  content           TEXT NOT NULL,
  metadata          TEXT NOT NULL DEFAULT '{}',
  token_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(knowledge_base_id);

-- ── Fleet / Organization layer (v12) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS teams (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id   TEXT NOT NULL REFERENCES ambients(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  description  TEXT,
  icon_glyph   TEXT,
  color_hex    TEXT,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_teams_workspace ON teams(workspace_id);

CREATE TABLE IF NOT EXISTS team_context (
  id                    TEXT PRIMARY KEY,
  team_id               TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operating_principles  TEXT NOT NULL DEFAULT '',
  constraints           TEXT NOT NULL DEFAULT '',
  handoffs              TEXT NOT NULL DEFAULT '',
  success_metrics       TEXT NOT NULL DEFAULT '',
  escalation_rules      TEXT NOT NULL DEFAULT '',
  shared_prompt         TEXT NOT NULL DEFAULT '',
  updated_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_team_context_team ON team_context(team_id);
`;
