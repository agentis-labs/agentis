-- ─────────────────────────────────────────────────────────────
-- Agentis embedded-mode initial schema.
-- Hand-authored to keep `npx agentis@latest up` self-sufficient
-- without invoking drizzle-kit at runtime. Mirrors src/sqlite/schema.ts.
-- ─────────────────────────────────────────────────────────────

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
  app_graph     TEXT,
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
  adapter_type        TEXT NOT NULL,
  capability_tags     TEXT NOT NULL DEFAULT '[]',
  config              TEXT NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'offline',
  last_heartbeat_at   TEXT,
  current_task_id     TEXT,
  color_hex           TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agents_gateway ON agents(gateway_id);

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
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'CREATED',
  run_state       TEXT NOT NULL,
  replan_count    INTEGER NOT NULL DEFAULT 0,
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
  external_id               TEXT NOT NULL UNIQUE,
  received_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  conversation_message_id   TEXT
);
