
-- Connection-level pragmas (journal_mode, foreign_keys) are applied by
-- openSqlite() on the connection, not here: journal_mode = WAL cannot run
-- inside the transaction that wraps a versioned migration.
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
  external_id               TEXT NOT NULL,
  received_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  conversation_message_id   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_delivery_conn_external ON channel_deliveries(connection_id, external_id);

-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Agent-First runtime tables (AGENT-FIRST-ARCHITECTURE.md Â§18)
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- App Knowledge Wedge â€” Agentis 1.1
-- docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

-- Per-item recovery table â€” sibling to dataset_imports (Agentis 1.1.1).
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

-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Memory Architecture â€” Agentis Memory OS
-- docs/memory/MEMORY-ARCHITECTURE.md
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
