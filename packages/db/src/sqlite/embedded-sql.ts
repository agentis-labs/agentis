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

-- ────────────────────────────────────────────────────────────
-- Agent-First runtime tables (AGENT-FIRST-ARCHITECTURE.md §18)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_runtime_contracts (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id       TEXT,
  package_version  TEXT,
  contract         TEXT NOT NULL,
  contract_hash    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_contracts_ws ON app_runtime_contracts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_app_contracts_hash ON app_runtime_contracts(contract_hash);

CREATE TABLE IF NOT EXISTS run_evaluations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL,
  node_id       TEXT,
  evaluator_id  TEXT NOT NULL,
  tier          TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  score         TEXT,
  details       TEXT NOT NULL DEFAULT '{}',
  cost_cents    INTEGER NOT NULL DEFAULT 0,
  evaluated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_run_evals_run ON run_evaluations(run_id);
CREATE INDEX IF NOT EXISTS idx_run_evals_ws ON run_evaluations(workspace_id);

CREATE TABLE IF NOT EXISTS run_policy_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  decision      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  context       TEXT NOT NULL DEFAULT '{}',
  decided_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_run_policy_run ON run_policy_events(run_id);

CREATE TABLE IF NOT EXISTS turn_state (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  turn_index    INTEGER NOT NULL,
  summary       TEXT,
  payload       TEXT NOT NULL DEFAULT '{}',
  blockers      TEXT NOT NULL DEFAULT '[]',
  cost_cents    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_turn_state_run_node ON turn_state(run_id, node_id, turn_index);

CREATE TABLE IF NOT EXISTS app_baseline_snapshots (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id                   TEXT NOT NULL,
  cost_cents_p50           INTEGER,
  cost_cents_p95           INTEGER,
  latency_ms_p50           INTEGER,
  latency_ms_p95           INTEGER,
  evaluator_pass_rate      TEXT,
  output_completeness_rate TEXT,
  run_count                INTEGER NOT NULL,
  first_run_at             TEXT NOT NULL,
  last_run_at              TEXT NOT NULL,
  captured_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_baselines_ws_app ON app_baseline_snapshots(workspace_id, app_id);

-- ────────────────────────────────────────────────────────────
-- App Knowledge Wedge — Agentis 1.1
-- docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md
-- ────────────────────────────────────────────────────────────

-- Class 1 + Class 2: knowledge plane storage (seeds + ingested chunks).
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  content_tokens  TEXT NOT NULL DEFAULT '[]',
  source          TEXT NOT NULL,        -- seed | import | promotion
  provenance      TEXT NOT NULL DEFAULT '{}',
  tags            TEXT NOT NULL DEFAULT '[]',
  embedding       TEXT,                  -- reserved for vector retrieval
  trust           TEXT NOT NULL DEFAULT '1',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_ws_app ON knowledge_chunks(workspace_id, app_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_chunks(app_id, source);

-- Class 1 (memorySeeds) + Class 4 (promoted memory).
CREATE TABLE IF NOT EXISTS app_memory (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id        TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- fact | preference | pattern | rule | lesson
  source        TEXT NOT NULL,          -- seed | promotion | operator
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  trust         TEXT NOT NULL DEFAULT '1',
  importance    TEXT NOT NULL DEFAULT '0.5',
  tags          TEXT NOT NULL DEFAULT '[]',
  provenance    TEXT NOT NULL DEFAULT '{}',
  adapter_type  TEXT,
  global_confidence TEXT NOT NULL DEFAULT '0',
  reinforced_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_memory_ws_app ON app_memory(workspace_id, app_id);
CREATE INDEX IF NOT EXISTS idx_app_memory_kind ON app_memory(app_id, kind);

CREATE TABLE IF NOT EXISTS knowledge_links (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL,
  source_kind     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  target_kind     TEXT NOT NULL,
  relation        TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0.5,
  reinforce_count INTEGER NOT NULL DEFAULT 1,
  agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
  adapter_type    TEXT,
  run_id          TEXT,
  app_id          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_workspace ON knowledge_links(workspace_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_source ON knowledge_links(workspace_id, source_id, source_kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_target ON knowledge_links(workspace_id, target_id, target_kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_links_agent ON knowledge_links(workspace_id, agent_id);

-- Class 3: persisted evaluator examples (seeds + imports + promoted).
CREATE TABLE IF NOT EXISTS app_evaluator_examples (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL,
  evaluator_key   TEXT NOT NULL,
  source          TEXT NOT NULL,        -- seed | import | operator | promotion
  input           TEXT NOT NULL,
  expected        TEXT NOT NULL,
  verdict         TEXT NOT NULL,        -- pass | fail
  score           TEXT,
  reason          TEXT,
  origin_run_id   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_eval_examples_ws_app ON app_evaluator_examples(workspace_id, app_id);
CREATE INDEX IF NOT EXISTS idx_eval_examples_key ON app_evaluator_examples(app_id, evaluator_key);

-- Class 2: dataset ingestion jobs.
CREATE TABLE IF NOT EXISTS dataset_imports (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL,
  dataset_key     TEXT NOT NULL,
  status          TEXT NOT NULL,        -- pending | parsing | chunking | indexing | completed | failed | cancelled
  source_meta     TEXT NOT NULL DEFAULT '{}',
  total_items     INTEGER NOT NULL DEFAULT 0,
  processed_items INTEGER NOT NULL DEFAULT 0,
  stored_items    INTEGER NOT NULL DEFAULT 0,
  errors          TEXT NOT NULL DEFAULT '[]',
  impact          TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_dataset_imports_ws_app ON dataset_imports(workspace_id, app_id);
CREATE INDEX IF NOT EXISTS idx_dataset_imports_key ON dataset_imports(app_id, dataset_key);
CREATE INDEX IF NOT EXISTS idx_dataset_imports_status ON dataset_imports(status);

-- Per-workflow rolling baselines (seeds + derived snapshots).
CREATE TABLE IF NOT EXISTS workflow_baselines (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id             TEXT NOT NULL,
  workflow_id        TEXT NOT NULL,
  source             TEXT NOT NULL,     -- seed | derived
  space_id              TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  p50_duration_ms    INTEGER,
  p95_duration_ms    INTEGER,
  success_rate       TEXT,
  cost_cents_per_run INTEGER,
  sample_size        INTEGER NOT NULL DEFAULT 0,
  window_start       TEXT NOT NULL,
  window_end         TEXT NOT NULL,
  captured_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_baselines_ws_app ON workflow_baselines(workspace_id, app_id);
CREATE INDEX IF NOT EXISTS idx_workflow_baselines_wf ON workflow_baselines(workflow_id);

-- Per-item recovery table — sibling to dataset_imports (Agentis 1.1.1).
-- One row per parsed item; enables granular retry via the /resume endpoint.
CREATE TABLE IF NOT EXISTS dataset_import_items (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_job_id   TEXT NOT NULL REFERENCES dataset_imports(id) ON DELETE CASCADE,
  item_index      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | failed | skipped
  content_hash    TEXT NOT NULL,                    -- SHA-256 hex; dedup key for resume
  stored_id       TEXT,                             -- ID written to target store (first chunk)
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_item_job_idx ON dataset_import_items(import_job_id, item_index);
CREATE INDEX IF NOT EXISTS idx_import_items_job_status ON dataset_import_items(import_job_id, status);
CREATE INDEX IF NOT EXISTS idx_import_items_hash ON dataset_import_items(import_job_id, content_hash);

-- ────────────────────────────────────────────────────────────
-- Memory Architecture — Agentis Memory OS
-- docs/memory/MEMORY-ARCHITECTURE.md
-- ────────────────────────────────────────────────────────────

-- Layer 1: durable working memory entries (typed scratchpad).
CREATE TABLE IF NOT EXISTS working_memory_entries (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL,
  namespace       TEXT NOT NULL,    -- run | agent | subflow | turn | eval | artifact | system
  kind            TEXT NOT NULL,    -- working_plan | working_summary | pending_questions | tool_result_cache | artifact_draft | evaluation_state | turn_history | blocker | note
  entry_key       TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  token_estimate  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_working_mem_run_ns_kind_key
  ON working_memory_entries(run_id, namespace, kind, entry_key);
CREATE INDEX IF NOT EXISTS idx_working_mem_run ON working_memory_entries(run_id);

-- Layer 3: durable runtime episodes.
CREATE TABLE IF NOT EXISTS memory_episodes (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id           TEXT,
  workflow_id      TEXT,
  run_id           TEXT,
  agent_id         TEXT,
  type             TEXT NOT NULL,
  title            TEXT NOT NULL,
  summary          TEXT NOT NULL,
  details          TEXT,
  source           TEXT NOT NULL,
  confidence       TEXT NOT NULL DEFAULT '0.5',
  importance       TEXT NOT NULL DEFAULT '0.5',
  trust            TEXT NOT NULL DEFAULT '0.5',
  tags             TEXT NOT NULL DEFAULT '[]',
  entities         TEXT NOT NULL DEFAULT '[]',
  outcome_status   TEXT,
  embedding        TEXT,
  metadata         TEXT NOT NULL DEFAULT '{}',
  reinforced_at    TEXT,
  archived_at      TEXT,
  superseded_by    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_episodes_ws_app    ON memory_episodes(workspace_id, app_id);
CREATE INDEX IF NOT EXISTS idx_episodes_workflow  ON memory_episodes(workflow_id);
CREATE INDEX IF NOT EXISTS idx_episodes_run       ON memory_episodes(run_id);
CREATE INDEX IF NOT EXISTS idx_episodes_type      ON memory_episodes(workspace_id, type);
CREATE INDEX IF NOT EXISTS idx_episodes_archived  ON memory_episodes(workspace_id, archived_at);

-- Memory promotion audit trail.
CREATE TABLE IF NOT EXISTS memory_promotion_events (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id              TEXT,
  run_id              TEXT,
  candidate_title     TEXT NOT NULL,
  candidate_payload   TEXT NOT NULL DEFAULT '{}',
  candidate_source    TEXT NOT NULL,
  decision            TEXT NOT NULL,    -- promoted | rejected | merged | superseded
  reason              TEXT NOT NULL,
  episode_id          TEXT,
  score               TEXT NOT NULL DEFAULT '0',
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_promotion_events_ws   ON memory_promotion_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_promotion_events_run  ON memory_promotion_events(run_id);
CREATE INDEX IF NOT EXISTS idx_promotion_events_app  ON memory_promotion_events(app_id, created_at DESC);

-- Layer 4: rolling-window baseline snapshots.
CREATE TABLE IF NOT EXISTS rolling_baseline_snapshots (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id                TEXT,
  workflow_id           TEXT NOT NULL,
  window                TEXT NOT NULL,    -- rolling_7d | rolling_30d | rolling_90d
  success_rate          TEXT NOT NULL DEFAULT '0',
  p50_latency_ms        INTEGER NOT NULL DEFAULT 0,
  p95_latency_ms        INTEGER NOT NULL DEFAULT 0,
  avg_cost_micros       INTEGER NOT NULL DEFAULT 0,
  avg_replay_count      TEXT NOT NULL DEFAULT '0',
  avg_approval_count    TEXT NOT NULL DEFAULT '0',
  evaluator_pass_rate   TEXT NOT NULL DEFAULT '0',
  sample_size           INTEGER NOT NULL DEFAULT 0,
  window_start          TEXT NOT NULL,
  window_end            TEXT NOT NULL,
  captured_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_rolling_baseline_ws_wf
  ON rolling_baseline_snapshots(workspace_id, workflow_id);
CREATE INDEX IF NOT EXISTS idx_rolling_baseline_window
  ON rolling_baseline_snapshots(workflow_id, window, captured_at DESC);

-- Class 4: promoted execution intelligence.
CREATE TABLE IF NOT EXISTS app_promoted_patterns (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id         TEXT NOT NULL,
  kind           TEXT NOT NULL,         -- successful_playbook | failure_with_fix | approved_output_pattern | business_rule | recurring_exception
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  payload        TEXT NOT NULL DEFAULT '{}',
  confidence     TEXT NOT NULL DEFAULT '0.5',
  trust          TEXT NOT NULL DEFAULT '0.8',
  evidence_count INTEGER NOT NULL DEFAULT 1,
  provenance     TEXT NOT NULL DEFAULT '{}',
  reinforced_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_promoted_ws_app ON app_promoted_patterns(workspace_id, app_id);
CREATE INDEX IF NOT EXISTS idx_promoted_kind ON app_promoted_patterns(app_id, kind);

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

-- App instances (created by PackagerService.usePackage for agentis kind)
CREATE TABLE IF NOT EXISTS app_instances (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ambient_id          TEXT REFERENCES ambients(id) ON DELETE SET NULL,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id          TEXT REFERENCES library_packages(id) ON DELETE SET NULL,
  slug                TEXT NOT NULL,
  name                TEXT NOT NULL,
  version             TEXT NOT NULL DEFAULT '1.0.0',
  status              TEXT NOT NULL DEFAULT 'active',
  space_id            TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  entry_workflow_id   TEXT,
  package_contents    TEXT NOT NULL DEFAULT '{}',
  credential_bindings TEXT NOT NULL DEFAULT '{}',
  dataset_statuses    TEXT NOT NULL DEFAULT '[]',
  knowledge_base_ids  TEXT NOT NULL DEFAULT '{}',
  activated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paused_at           TEXT,
  last_run_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_instances_ws ON app_instances(workspace_id);
CREATE INDEX IF NOT EXISTS idx_app_instances_space ON app_instances(workspace_id, space_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_instances_slug ON app_instances(workspace_id, slug);

-- ─── App Output surface (APP-OUTPUT-REPLAN.md §5.3 + §5.6) ──────────────
CREATE TABLE IF NOT EXISTS app_thread_messages (
  id           TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES app_instances(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  content      TEXT NOT NULL,
  run_id       TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  approval_id  TEXT,
  operator_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_thread_messages_app ON app_thread_messages(app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_app_thread_messages_run ON app_thread_messages(run_id);

CREATE TABLE IF NOT EXISTS app_results (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES app_instances(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  output_key    TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  content       TEXT NOT NULL,
  summary       TEXT,
  triggered_by  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_results_app_created ON app_results(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_results_run ON app_results(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_results_run_key ON app_results(run_id, output_key);

CREATE VIRTUAL TABLE IF NOT EXISTS app_results_fts USING fts5(
  summary, content, content='app_results', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS app_results_fts_insert AFTER INSERT ON app_results BEGIN
  INSERT INTO app_results_fts(rowid, summary, content) VALUES (new.rowid, new.summary, new.content);
END;
CREATE TRIGGER IF NOT EXISTS app_results_fts_delete AFTER DELETE ON app_results BEGIN
  INSERT INTO app_results_fts(app_results_fts, rowid, summary, content) VALUES('delete', old.rowid, old.summary, old.content);
END;
CREATE TRIGGER IF NOT EXISTS app_results_fts_update AFTER UPDATE ON app_results BEGIN
  INSERT INTO app_results_fts(app_results_fts, rowid, summary, content) VALUES('delete', old.rowid, old.summary, old.content);
  INSERT INTO app_results_fts(rowid, summary, content) VALUES (new.rowid, new.summary, new.content);
END;

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

CREATE TABLE IF NOT EXISTS memory_entries (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      TEXT REFERENCES teams(id) ON DELETE SET NULL,
  agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_type  TEXT NOT NULL DEFAULT 'operator',
  source_id    TEXT,
  kind         TEXT NOT NULL DEFAULT 'note',
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  importance   INTEGER NOT NULL DEFAULT 5,
  confidence   REAL NOT NULL DEFAULT 1,
  tags         TEXT NOT NULL DEFAULT '[]',
  metadata     TEXT NOT NULL DEFAULT '{}',
  archived_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_entries_workspace ON memory_entries(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_team ON memory_entries(team_id);
`;
