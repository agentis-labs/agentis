/**
 * Migration registry — SQLite dialect.
 *
 * Migrations are inlined as string literals (not loaded from .sql files) so
 * the bundled CLI distribution works whether running via tsx, tsc-compiled
 * dist/, or npm-tarball'd. There is no file resolution at runtime.
 *
 * v1.0.0 ships a single `init` migration: version 1 is the frozen release
 * schema (EMBEDDED_INIT_SQL). Subsequent feature releases append new
 * version entries here.
 *
 * Adding a migration:
 *   1. Pick the next never-issued version number. Versions remain reserved
 *      even if the release that introduced them is later removed from code.
 *   2. Add a new entry to SQLITE_MIGRATIONS with `version`, `name`, `sql`.
 *   3. The SQL must be idempotent (CREATE TABLE IF NOT EXISTS, etc.).
 *   4. Mirror the change in src/sqlite/schema.ts so drizzle stays in sync.
 *
 * Forward-only — V1 has no rollback infrastructure. For destructive changes,
 * ship a follow-up migration that re-creates the prior shape.
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
  // Pre-v1 builds issued versions 2 through 38. Existing workspaces still
  // carry those rows in schema_migrations, so those IDs cannot be reused.
  {
    version: 39,
    name: 'agent_memories',
    sql: `
CREATE TABLE IF NOT EXISTS agent_memories (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  section      TEXT NOT NULL DEFAULT 'Notes',
  content      TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories(agent_id, workspace_id);
`,
  },
  {
    version: 40,
    name: 'brain_subsystem',
    sql: `
ALTER TABLE workspaces ADD COLUMN embedding_provider_type TEXT NOT NULL DEFAULT 'hashing';
ALTER TABLE workspaces ADD COLUMN embedding_provider_config TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workspaces ADD COLUMN brain_settings TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id          TEXT,
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
  scope_id          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS memory_episodes (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id           TEXT,
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

CREATE TABLE IF NOT EXISTS workflow_baselines (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id             TEXT,
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

CREATE TABLE IF NOT EXISTS dataset_imports (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id          TEXT,
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

CREATE TABLE IF NOT EXISTS session_moments (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id       TEXT,
  content      TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.6,
  embedding    TEXT,
  promoted_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS peer_profiles (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  peer_type    TEXT NOT NULL,
  peer_id      TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  embedding    TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS peer_profile_conclusions (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_peer_id   TEXT NOT NULL,
  observer_peer_id  TEXT NOT NULL,
  content           TEXT NOT NULL,
  source_session_id TEXT,
  confidence        REAL NOT NULL DEFAULT 0.7,
  embedding         TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cognitive_promotion_queue (
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

CREATE TABLE IF NOT EXISTS brain_quality_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id       TEXT,
  agent_id     TEXT,
  event_type   TEXT NOT NULL,
  atom_id      TEXT,
  ability_id   TEXT,
  run_id       TEXT,
  delta        REAL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

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

`,
  },
  {
    version: 41,
    name: 'brain_scoped_intelligence_tables',
    sql: `
CREATE TABLE IF NOT EXISTS workspace_memory (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id        TEXT,
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
CREATE TABLE IF NOT EXISTS evaluator_examples (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id          TEXT,
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
CREATE TABLE IF NOT EXISTS memory_promotion_events (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id              TEXT,
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
CREATE TABLE IF NOT EXISTS rolling_baseline_snapshots (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id                TEXT,
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
CREATE TABLE IF NOT EXISTS promoted_patterns (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id         TEXT,
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
`,
  },
  {
    version: 42,
    name: 'brain_columns_reconcile',
    sql: `
ALTER TABLE knowledge_links ADD COLUMN context_split INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_links ADD COLUMN resolved_at TEXT;
ALTER TABLE memory_episodes ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memory_episodes ADD COLUMN managed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memory_episodes ADD COLUMN pinned_at TEXT;
ALTER TABLE memory_episodes ADD COLUMN last_accessed_at TEXT;
ALTER TABLE memory_episodes ADD COLUMN is_disputed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_episodes ADD COLUMN dispute_reason TEXT;
ALTER TABLE memory_episodes ADD COLUMN dispute_resolved_at TEXT;
ALTER TABLE memory_episodes ADD COLUMN dispute_snoozed_until TEXT;
ALTER TABLE memory_episodes ADD COLUMN context_condition TEXT;
ALTER TABLE memory_episodes ADD COLUMN compressed_from TEXT;
ALTER TABLE memory_episodes ADD COLUMN compression_tier INTEGER;
ALTER TABLE peer_profiles ADD COLUMN peer_card TEXT NOT NULL DEFAULT '[]';
ALTER TABLE peer_profiles ADD COLUMN last_dream_at TEXT;
ALTER TABLE peer_profile_conclusions ADD COLUMN conclusion_type TEXT NOT NULL DEFAULT 'deductive';
ALTER TABLE peer_profile_conclusions ADD COLUMN volatility_class TEXT NOT NULL DEFAULT 'contextual';
ALTER TABLE peer_profile_conclusions ADD COLUMN supporting_session_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE peer_profile_conclusions ADD COLUMN superseded_by_id TEXT;
ALTER TABLE peer_profile_conclusions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE brain_quality_events ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    version: 43,
    name: 'brain_intelligence_plane',
    sql: `
ALTER TABLE kb_chunks ADD COLUMN embedding TEXT;
ALTER TABLE kb_chunks ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_chunks ADD COLUMN last_accessed_at TEXT;
ALTER TABLE knowledge_links ADD COLUMN valid_from TEXT;
ALTER TABLE knowledge_links ADD COLUMN invalid_at TEXT;

CREATE TABLE IF NOT EXISTS user_notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT,
  content    TEXT NOT NULL,
  note_type  TEXT NOT NULL DEFAULT 'note',
  embedding  TEXT,
  tags       TEXT NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL DEFAULT 'user_typed',
  agent_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_user_notes_user ON user_notes(user_id, updated_at);

CREATE TABLE IF NOT EXISTS user_links (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  relation    TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0.6,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS personal_brain_grants (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'read',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, agent_id)
);

`,
  },
  {
    version: 44,
    name: 'abilities',
    sql: `
-- Abilities — compiled behavioral specialization units (docs/brain/ABILITIES.md).
-- Workspace-scoped pool; semantic relevance + optional pinning decide injection.
CREATE TABLE IF NOT EXISTS abilities (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  description       TEXT,
  domain_tag        TEXT,
  icon_emoji        TEXT DEFAULT '⚡',
  author_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  compiled_prompt   TEXT,
  specs             TEXT NOT NULL DEFAULT '{}',
  rules_always      TEXT NOT NULL DEFAULT '[]',
  rules_never       TEXT NOT NULL DEFAULT '[]',
  tool_hints        TEXT NOT NULL DEFAULT '[]',
  domain_embedding  TEXT,
  example_count     INTEGER NOT NULL DEFAULT 0,
  knowledge_count   INTEGER NOT NULL DEFAULT 0,
  compile_status    TEXT NOT NULL DEFAULT 'pending',
  last_compiled_at  TEXT,
  compile_error     TEXT,
  is_public         INTEGER NOT NULL DEFAULT 0,
  hub_slug          TEXT,
  hub_version       TEXT NOT NULL DEFAULT '1.0.0',
  install_count     INTEGER NOT NULL DEFAULT 0,
  token_budget      INTEGER,
  version           TEXT NOT NULL DEFAULT '1.0.0',
  kb_document_id    TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_abilities_workspace ON abilities(workspace_id, compile_status);
CREATE INDEX IF NOT EXISTS idx_abilities_hub_slug ON abilities(hub_slug);

CREATE TABLE IF NOT EXISTS ability_examples (
  id                TEXT PRIMARY KEY,
  ability_id        TEXT NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,
  input_text        TEXT NOT NULL,
  output_text       TEXT NOT NULL,
  input_media_url   TEXT,
  media_description TEXT,
  quality_score     REAL NOT NULL DEFAULT 0.8,
  source            TEXT NOT NULL DEFAULT 'user_curated',
  embedding         TEXT,
  origin_run_id     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ability_examples_ability ON ability_examples(ability_id);

CREATE TABLE IF NOT EXISTS ability_knowledge (
  id                TEXT PRIMARY KEY,
  ability_id        TEXT NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,
  kb_chunk_id       TEXT,
  title             TEXT,
  content           TEXT NOT NULL,
  context_prefix    TEXT,
  embedding         TEXT,
  source_type       TEXT NOT NULL DEFAULT 'document',
  source_url        TEXT,
  importance_score  REAL NOT NULL DEFAULT 0.5,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ability_knowledge_ability ON ability_knowledge(ability_id);

CREATE TABLE IF NOT EXISTS agent_ability_pins (
  agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ability_id        TEXT NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (agent_id, ability_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_ability_pins_agent ON agent_ability_pins(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_ability_pins_ability ON agent_ability_pins(ability_id);
`,
  },
  {
    version: 45,
    name: 'ability_compile_stage',
    sql: `
-- Stage tracking + cancel support for the ability compile pipeline.
-- compile_stage: human-readable phase ("embedding_examples", "synthesizing_persona", etc).
-- compile_cancel_requested: set when the user clicks Cancel; the worker checks
-- between stages and bails to compile_status='failed' with error "cancelled".
ALTER TABLE abilities ADD COLUMN compile_stage TEXT;
ALTER TABLE abilities ADD COLUMN compile_cancel_requested INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 46,
    name: 'cognitive_promotion_queue_repair',
    sql: `
-- Repair migration for workspaces that reached a later schema version before
-- the durable promotion queue table existed locally.
CREATE TABLE IF NOT EXISTS cognitive_promotion_queue (
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
`,
  },
  {
    version: 47,
    name: 'ability_compile_stuck_repair',
    sql: `
-- Any ability left in "compiling" before the queue repair had no durable job
-- to drain. Mark those rows retryable instead of leaving the UI spinning.
UPDATE abilities
SET compile_status = 'failed',
    compile_stage = NULL,
    compile_cancel_requested = 0,
    compile_error = 'Compile queue was repaired. Click Compile again.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE compile_status = 'compiling';
`,
  },
  {
    version: 48,
    name: 'agent_space_tag',
    sql: `
ALTER TABLE agents ADD COLUMN domain_tag TEXT;
`,
  },
  {
    version: 49,
    name: 'spaces_entity',
    sql: `
CREATE TABLE IF NOT EXISTS domains (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  description  TEXT,
  color_hex    TEXT,
  icon_emoji   TEXT,
  manager_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

ALTER TABLE agents ADD COLUMN domain_id TEXT REFERENCES domains(id) ON DELETE SET NULL;
ALTER TABLE workflows ADD COLUMN domain_id TEXT REFERENCES domains(id) ON DELETE SET NULL;
`,
  },
  {
    version: 50,
    name: 'extension_kv',
    sql: `
-- Workspace-scoped extension KV store (EXTENSIONS-AND-LISTENER-10X §2.5).
-- Backs listener-source extensions that maintain rolling state across runs.
CREATE TABLE IF NOT EXISTS extension_kv (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT,
  PRIMARY KEY (workspace_id, extension_id, key)
);
CREATE INDEX IF NOT EXISTS idx_extension_kv_expiry ON extension_kv(expires_at) WHERE expires_at IS NOT NULL;
`,
  },
  {
    version: 51,
    name: 'retire_agent_memories',
    sql: `
-- Retire the standalone agent_memories store. Agent-private memory is now a
-- scope of the canonical brain: memory_episodes rows with scope_id = agentId.
-- This removes the duplicate backend so an agent's explicit notes, failure
-- reflections, and auto-promoted run lessons all live in one place and are
-- retrieved by the same dispatch context as the rest of the brain.
INSERT INTO memory_episodes (
  id, workspace_id, scope_id, agent_id, type, title, summary, source,
  confidence, importance, trust, tags, entities, metadata,
  status, managed, is_disputed, created_at, updated_at
)
SELECT
  id, workspace_id, agent_id, agent_id, 'distilled_lesson', section, content, 'agent_write',
  '0.7', '0.6', '0.7', tags, '[]',
  json_object('section', section, 'privateScope', 'agent', 'migratedFrom', 'agent_memories'),
  'active', 1, 0, created_at, created_at
FROM agent_memories;

DROP TABLE agent_memories;
`,
  },
  {
    version: 52,
    name: 'abilities_command_mode_columns',
    sql: `
-- Abilities V2: command-mode + gating columns the schema/code reference but
-- which never had a migration (the base table is v44; v45 added the compile
-- pipeline columns). Backfills existing databases so build/boot stops failing
-- with "no such column: abilities.mode".
ALTER TABLE abilities ADD COLUMN mode TEXT NOT NULL DEFAULT 'compiled';
ALTER TABLE abilities ADD COLUMN slash_command TEXT;
ALTER TABLE abilities ADD COLUMN command_dispatch TEXT;
ALTER TABLE abilities ADD COLUMN command_tool_name TEXT;
ALTER TABLE abilities ADD COLUMN env_keys TEXT NOT NULL DEFAULT '[]';
ALTER TABLE abilities ADD COLUMN env_secret_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE abilities ADD COLUMN gate TEXT;
ALTER TABLE abilities ADD COLUMN min_relevance_score REAL;
ALTER TABLE abilities ADD COLUMN preferred_model TEXT;
`,
  },
  {
    version: 53,
    name: 'peer_profiles_backfill',
    sql: `
-- Peer-profile tables (Brain discourse) were added to the already-shipped v40
-- migration body, so databases that recorded v40 BEFORE that edit never got the
-- table — every chat turn then warned "no such table: peer_profiles". Recreate
-- both at their full current shape (v40 base + v42 columns). Idempotent: a no-op
-- where they already exist.
CREATE TABLE IF NOT EXISTS peer_profiles (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  peer_type     TEXT NOT NULL,
  peer_id       TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  embedding     TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  peer_card     TEXT NOT NULL DEFAULT '[]',
  last_dream_at TEXT
);
CREATE TABLE IF NOT EXISTS peer_profile_conclusions (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_peer_id          TEXT NOT NULL,
  observer_peer_id         TEXT NOT NULL,
  content                  TEXT NOT NULL,
  source_session_id        TEXT,
  confidence               REAL NOT NULL DEFAULT 0.7,
  embedding                TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  conclusion_type          TEXT NOT NULL DEFAULT 'deductive',
  volatility_class         TEXT NOT NULL DEFAULT 'contextual',
  supporting_session_count INTEGER NOT NULL DEFAULT 1,
  superseded_by_id         TEXT,
  status                   TEXT NOT NULL DEFAULT 'active'
);
`,
  },
  {
    version: 54,
    name: 'chat_context_hot_path_indexes',
    sql: `
-- Per-chat-turn context assembly filters workflow_runs/approval_requests by
-- (workspace_id, status). Without these indexes that was a full scan that grew
-- with run history, compounding orchestrator latency over time. Covering
-- created_at lets the "active runs / pending approvals, newest first, limit N"
-- queries run index-only.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_ws_status_created ON workflow_runs (workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_approval_requests_ws_status_created ON approval_requests (workspace_id, status, created_at);
`,
  },
  {
    version: 55,
    name: 'specialist_ability_loadouts',
    sql: `
-- Phase 3 (SPECIALISTS-10X): abilities become a specialist's professional DNA.
-- A loadout is a versioned relation between a specialist functional role and an
-- ability: required (always injected), preferred (boosted), optional (normal
-- semantic), or forbidden (never injected for this role). Keyed by role string
-- (not agentId) so it applies to every materialized agent carrying that role.
CREATE TABLE IF NOT EXISTS specialist_ability_loadouts (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role                TEXT NOT NULL,
  ability_id          TEXT NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL DEFAULT 'preferred',
  priority            INTEGER NOT NULL DEFAULT 0,
  min_relevance_score REAL,
  conflict_policy     TEXT NOT NULL DEFAULT 'specialist_wins',
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_specialist_loadout_unique ON specialist_ability_loadouts (workspace_id, role, ability_id);
CREATE INDEX IF NOT EXISTS idx_specialist_loadout_role ON specialist_ability_loadouts (workspace_id, role);
`,
  },
  {
    version: 56,
    name: 'specialist_profiles',
    sql: `
-- Phase 1 (SPECIALISTS-10X): the durable expert definition for a functional
-- role — identity, runtime contract, generated A2A-style card, status, version.
-- One profile per (workspace, role); the materialized agent rows are instances.
CREATE TABLE IF NOT EXISTS specialist_profiles (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role                    TEXT NOT NULL,
  name                    TEXT NOT NULL,
  title                   TEXT,
  description             TEXT,
  identity_prompt         TEXT,
  responsibility_contract TEXT,
  boundaries              TEXT,
  -- draft | ready | degraded | archived
  status                  TEXT NOT NULL DEFAULT 'draft',
  -- model policy, autonomy, budget, session/artifact policy (JSON)
  runtime_profile         TEXT NOT NULL DEFAULT '{}',
  -- generated SpecialistCard (JSON), refreshed on compile
  card                    TEXT,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_by              TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_specialist_profile_role ON specialist_profiles (workspace_id, role);
`,
  },
  {
    version: 57,
    name: 'specialist_mind',
    sql: `
-- Phase 2 (SPECIALISTS-10X): a specialist's MIND — curated, multimodal source
-- material distilled into retrievable atoms. One mind per (workspace, role).
CREATE TABLE IF NOT EXISTS specialist_minds (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role              TEXT NOT NULL,
  summary           TEXT,
  retrieval_policy  TEXT NOT NULL DEFAULT '{}',
  distilled_context TEXT,
  embedding         TEXT,
  quality_score     REAL NOT NULL DEFAULT 0.5,
  freshness_score   REAL NOT NULL DEFAULT 1.0,
  provenance_score  REAL NOT NULL DEFAULT 0.5,
  -- ingesting | extracting | embedding | ready
  status            TEXT NOT NULL DEFAULT 'ready',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_specialist_mind_role ON specialist_minds (workspace_id, role);

CREATE TABLE IF NOT EXISTS specialist_mind_sources (
  id           TEXT PRIMARY KEY,
  mind_id      TEXT NOT NULL REFERENCES specialist_minds(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- text | url | file | image | audio | video | run | brain_atom | ability
  kind         TEXT NOT NULL DEFAULT 'text',
  title        TEXT,
  uri          TEXT,
  -- workspace | private | external (prompt-injection trust level)
  trust        TEXT NOT NULL DEFAULT 'workspace',
  license      TEXT,
  -- pending | extracting | ready | failed
  status       TEXT NOT NULL DEFAULT 'ready',
  raw_excerpt  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_specialist_mind_sources_mind ON specialist_mind_sources (mind_id);

CREATE TABLE IF NOT EXISTS specialist_mind_atoms (
  id           TEXT PRIMARY KEY,
  mind_id      TEXT NOT NULL REFERENCES specialist_minds(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id    TEXT REFERENCES specialist_mind_sources(id) ON DELETE SET NULL,
  -- fact | preference | rule | visual_pattern | anti_pattern | example | decision
  atom_type    TEXT NOT NULL DEFAULT 'fact',
  content      TEXT NOT NULL,
  embedding    TEXT,
  confidence   REAL NOT NULL DEFAULT 0.7,
  tags         TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_specialist_mind_atoms_mind ON specialist_mind_atoms (mind_id);

CREATE TABLE IF NOT EXISTS specialist_mind_media (
  id           TEXT PRIMARY KEY,
  mind_id      TEXT NOT NULL REFERENCES specialist_minds(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id    TEXT REFERENCES specialist_mind_sources(id) ON DELETE CASCADE,
  mime_type    TEXT,
  storage_ref  TEXT,
  caption      TEXT,
  ocr_text     TEXT,
  palette      TEXT NOT NULL DEFAULT '[]',
  layout_notes TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  embedding    TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_specialist_mind_media_mind ON specialist_mind_media (mind_id);
`,
  },
  {
    version: 58,
    name: 'specialist_runtime_router_eval',
    sql: `
-- SPECIALISTS-10X completion slice: first-class registry templates,
-- materialized instances, demand-router traces, specialist run observability,
-- and the evaluation/learning flywheel.
CREATE TABLE IF NOT EXISTS specialist_templates (
  id                      TEXT PRIMARY KEY,
  slug                    TEXT NOT NULL,
  name                    TEXT NOT NULL,
  description             TEXT,
  category                TEXT NOT NULL DEFAULT 'platform',
  default_identity        TEXT NOT NULL DEFAULT '{}',
  recommended_abilities   TEXT NOT NULL DEFAULT '[]',
  required_tools          TEXT NOT NULL DEFAULT '[]',
  default_runtime_profile TEXT NOT NULL DEFAULT '{}',
  starter_mind_sources    TEXT NOT NULL DEFAULT '[]',
  creation_questions      TEXT NOT NULL DEFAULT '[]',
  eval_pack               TEXT NOT NULL DEFAULT '[]',
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_specialist_templates_slug ON specialist_templates (slug);

CREATE TABLE IF NOT EXISTS specialist_instances (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  specialist_profile_id TEXT REFERENCES specialist_profiles(id) ON DELETE SET NULL,
  mode                  TEXT NOT NULL DEFAULT 'durable',
  parent_agent_id       TEXT REFERENCES agents(id) ON DELETE SET NULL,
  reports_to            TEXT REFERENCES agents(id) ON DELETE SET NULL,
  lease_expires_at      TEXT,
  last_used_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_specialist_instances_agent ON specialist_instances (workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_specialist_instances_role ON specialist_instances (workspace_id, role);

CREATE TABLE IF NOT EXISTS specialist_routing_decisions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task                TEXT NOT NULL,
  modality            TEXT NOT NULL DEFAULT 'text',
  desired_topology    TEXT,
  selected_role       TEXT NOT NULL,
  selected_agent_id   TEXT,
  topology            TEXT NOT NULL,
  score               REAL NOT NULL DEFAULT 0,
  explanation         TEXT NOT NULL,
  context_summary     TEXT NOT NULL DEFAULT '{}',
  constraints         TEXT NOT NULL DEFAULT '{}',
  created_by          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_specialist_routing_ws_created ON specialist_routing_decisions (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_specialist_routing_role ON specialist_routing_decisions (workspace_id, selected_role);

CREATE TABLE IF NOT EXISTS specialist_runs (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  routing_decision_id TEXT REFERENCES specialist_routing_decisions(id) ON DELETE SET NULL,
  role                TEXT NOT NULL,
  agent_id            TEXT,
  topology            TEXT NOT NULL DEFAULT 'direct',
  status              TEXT NOT NULL DEFAULT 'planned',
  task                TEXT NOT NULL,
  artifact_policy     TEXT NOT NULL DEFAULT '{}',
  budget_policy       TEXT NOT NULL DEFAULT '{}',
  trace               TEXT NOT NULL DEFAULT '[]',
  output_summary      TEXT,
  artifact_id         TEXT,
  started_at          TEXT,
  finished_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_specialist_runs_ws_created ON specialist_runs (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_specialist_runs_role ON specialist_runs (workspace_id, role);

CREATE TABLE IF NOT EXISTS specialist_eval_profiles (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  rubric       TEXT NOT NULL DEFAULT 'Quality, correctness, usefulness, safety.',
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_specialist_eval_profile_role ON specialist_eval_profiles (workspace_id, role);

CREATE TABLE IF NOT EXISTS specialist_eval_cases (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  eval_profile_id TEXT NOT NULL REFERENCES specialist_eval_profiles(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  name            TEXT NOT NULL,
  input           TEXT NOT NULL,
  expected        TEXT,
  rubric          TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_specialist_eval_cases_role ON specialist_eval_cases (workspace_id, role);

CREATE TABLE IF NOT EXISTS specialist_eval_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  eval_case_id    TEXT NOT NULL REFERENCES specialist_eval_cases(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'completed',
  score           REAL NOT NULL DEFAULT 0,
  output          TEXT,
  reasoning       TEXT,
  promoted_atom_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_specialist_eval_runs_role ON specialist_eval_runs (workspace_id, role, created_at);

CREATE TABLE IF NOT EXISTS specialist_quality_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info',
  summary      TEXT NOT NULL,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_specialist_quality_role ON specialist_quality_events (workspace_id, role, created_at);
`,
  },
  {
    version: 59,
    name: 'session_moments_backfill',
    // session_moments was added into the already-released v40 block AFTER many
    // workspaces had recorded v40 as applied, so it never ran on those DBs —
    // chat then logs "no such table: session_moments" every turn during memory
    // capture. (peer_profiles had the same problem and got its own v53 backfill.)
    // This is the proper fix: a NEW versioned, idempotent migration so existing
    // databases get the table. Never edit a shipped migration's SQL again.
    sql: `
CREATE TABLE IF NOT EXISTS session_moments (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id       TEXT,
  content      TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.6,
  embedding    TEXT,
  promoted_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_moments_session ON session_moments (workspace_id, session_id);
`,
  },
  {
    version: 60,
    name: 'workflow_content_hash',
    // NATIVE-ADVANCEMENT Task 2 (divergence fingerprint). SHA-256 of the
    // canonical graph, written on every create/update. Nullable: existing
    // workflows backfill their hash on the next save. Not a security boundary.
    sql: `
ALTER TABLE workflows ADD COLUMN content_hash TEXT;
`,
  },
  {
    version: 61,
    name: 'abilities_10x_depth_eval_activations',
    // ABILITIES-10X — make the Ability the LoRA-style add-on primitive:
    //   • depth: the earned specialization rung (d0_instinct … d4_conductor).
    //   • visibility: private | workspace | unlisted | hub.
    //   • content_hash: drives the Ability Cache + prefix-cache ordering.
    //   • origin_json: which creation on-ramp produced it (provenance).
    //   • execution_policy_json / routing_policy_json: D3/D4 behavioral policy.
    // Plus two lean tables — ability-scoped self-eval evidence and the
    // activation ledger (the free flywheel). No weights, no GPU, no training jobs.
    sql: `
ALTER TABLE abilities ADD COLUMN depth TEXT NOT NULL DEFAULT 'd0_instinct';
ALTER TABLE abilities ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE abilities ADD COLUMN content_hash TEXT;
ALTER TABLE abilities ADD COLUMN origin_json TEXT;
ALTER TABLE abilities ADD COLUMN execution_policy_json TEXT;
ALTER TABLE abilities ADD COLUMN routing_policy_json TEXT;

CREATE TABLE IF NOT EXISTS ability_eval_runs (
  id TEXT PRIMARY KEY,
  ability_id TEXT NOT NULL REFERENCES abilities(id) ON DELETE CASCADE,
  workspace_id TEXT,
  kind TEXT NOT NULL DEFAULT 'self_eval',
  score REAL NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  case_count INTEGER NOT NULL DEFAULT 0,
  failures_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ability_eval_runs_ability ON ability_eval_runs(ability_id, created_at);

CREATE TABLE IF NOT EXISTS ability_activations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  model TEXT,
  ability_ids_json TEXT NOT NULL DEFAULT '[]',
  conflicts_resolved_json TEXT NOT NULL DEFAULT '[]',
  outcome TEXT,
  quality_score REAL,
  consent_scope TEXT NOT NULL DEFAULT 'workspace_private',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ability_activations_ws ON ability_activations(workspace_id, created_at);
`,
  },
  {
    version: 62,
    name: 'pacer_feynman_indexes',
    // BRAIN PACER + FEYNMAN — make the two new hot reads cheap:
    //   • Phase 3 graduation counts `atom_injected` events per atom
    //     (retrieval-frequency signal).
    //   • Phase 4 Feynman counts `node_failure` events per workspace
    //     (repeated-failure trigger).
    // Both are JSON-payload reads gated by (atom_id|workspace_id, event_type),
    // so two composite indexes cover them. Idempotent; no data change.
    sql: `
CREATE INDEX IF NOT EXISTS idx_brain_quality_events_atom_type
  ON brain_quality_events(atom_id, event_type);
CREATE INDEX IF NOT EXISTS idx_brain_quality_events_ws_type_created
  ON brain_quality_events(workspace_id, event_type, created_at);
`,
  },
  {
    version: 63,
    name: 'cora_organizational_intelligence',
    // CORA — the Workspace Brain's continuous organizational reasoning engine
    // (docs/brain/AGENTIS_ORGANIZATIONAL_INTELLIGENCE_ARCHITECTURE.md).
    // Engineering tables only; the user-facing surface is the Brain "Sources"
    // tab. Physical layout is deliberately leaner than the RFC's logical list:
    //   • learning briefs fold into cora_source_connections.learning_brief_json
    //   • entity aliases fold into cora_entities.aliases_json
    //   • access policies fold into per-row access_policy_json
    //   • onboarding/feedback events ride cora_audit_events
    // Evidence is append-only: UNIQUE(source_object_id, content_hash) makes
    // replay idempotent (RFC §7.5). Claim conflicts carry dispute_link_id so
    // contradictions surface through the EXISTING dispute system instead of a
    // parallel one (RFC §10.5).
    sql: `
CREATE TABLE IF NOT EXISTS cora_owner_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT,
  name TEXT,
  intent TEXT,
  operating_shape TEXT NOT NULL DEFAULT 'personal_project',
  charter TEXT,
  onboarding_state TEXT NOT NULL DEFAULT 'pending',
  defaults_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cora_owner_profiles_ws ON cora_owner_profiles(workspace_id);

CREATE TABLE IF NOT EXISTS cora_source_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connect',
  credential_id TEXT,
  included_scopes_json TEXT NOT NULL DEFAULT '[]',
  excluded_scopes_json TEXT NOT NULL DEFAULT '[]',
  learning_brief_json TEXT NOT NULL DEFAULT '{}',
  information_defaults_json TEXT NOT NULL DEFAULT '{}',
  retention_policy TEXT NOT NULL DEFAULT 'standard',
  reasoning_mode TEXT NOT NULL DEFAULT 'adaptive',
  schedule_json TEXT NOT NULL DEFAULT '{}',
  health_json TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_source_connections_ws ON cora_source_connections(workspace_id, status);

CREATE TABLE IF NOT EXISTS cora_sync_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cora_source_connections(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'incremental',
  status TEXT NOT NULL DEFAULT 'queued',
  cursor TEXT,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  counts_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_sync_runs_conn ON cora_sync_runs(connection_id, created_at);

CREATE TABLE IF NOT EXISTS cora_source_objects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cora_source_connections(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  title TEXT,
  native_url TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  lifecycle_at TEXT,
  current_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cora_source_objects_identity
  ON cora_source_objects(workspace_id, connection_id, external_id);

CREATE TABLE IF NOT EXISTS cora_evidence_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_object_id TEXT NOT NULL REFERENCES cora_source_objects(id) ON DELETE CASCADE,
  predecessor_version_id TEXT,
  source_version_id TEXT,
  content_hash TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  security_labels_json TEXT NOT NULL DEFAULT '[]',
  boundary_json TEXT NOT NULL DEFAULT '{}',
  acl_json TEXT NOT NULL DEFAULT '{}',
  valid_from TEXT,
  valid_until TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cora_evidence_versions_idempotent
  ON cora_evidence_versions(source_object_id, content_hash);
CREATE INDEX IF NOT EXISTS cora_evidence_versions_ws ON cora_evidence_versions(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS cora_source_principals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cora_source_connections(id) ON DELETE CASCADE,
  external_principal_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'person',
  display_name TEXT,
  email TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cora_source_principals_identity
  ON cora_source_principals(workspace_id, connection_id, external_principal_id);

CREATE TABLE IF NOT EXISTS cora_entities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'other',
  name TEXT NOT NULL,
  domain TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  attributes_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_entities_ws ON cora_entities(workspace_id, kind, status);

CREATE TABLE IF NOT EXISTS cora_identity_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES cora_entities(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES cora_source_principals(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'review',
  supporting_json TEXT NOT NULL DEFAULT '[]',
  conflicting_json TEXT NOT NULL DEFAULT '[]',
  reviewed_by TEXT,
  valid_from TEXT,
  valid_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_identity_links_entity ON cora_identity_links(entity_id, status);

CREATE TABLE IF NOT EXISTS cora_claims (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_entity_id TEXT,
  subject_ref_json TEXT NOT NULL DEFAULT '{}',
  predicate TEXT NOT NULL,
  object_json TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'observation',
  status TEXT NOT NULL DEFAULT 'candidate',
  confidence REAL NOT NULL DEFAULT 0,
  confidence_json TEXT NOT NULL DEFAULT '{}',
  authority_json TEXT NOT NULL DEFAULT '{}',
  access_policy_json TEXT NOT NULL DEFAULT '{}',
  protected_domain INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_until TEXT,
  reasoning_version TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_claims_ws_status ON cora_claims(workspace_id, status);
CREATE INDEX IF NOT EXISTS cora_claims_subject ON cora_claims(subject_entity_id, predicate);

CREATE TABLE IF NOT EXISTS cora_claim_evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES cora_claims(id) ON DELETE CASCADE,
  evidence_version_id TEXT NOT NULL REFERENCES cora_evidence_versions(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'supports',
  directness REAL NOT NULL DEFAULT 1,
  locator_json TEXT NOT NULL DEFAULT '{}',
  independence_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_claim_evidence_claim ON cora_claim_evidence(claim_id, role);

CREATE TABLE IF NOT EXISTS cora_claim_conflicts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dispute_link_id TEXT,
  claim_ids_json TEXT NOT NULL DEFAULT '[]',
  active_claim_id TEXT,
  resolution TEXT NOT NULL DEFAULT 'unresolved',
  consequentiality TEXT NOT NULL DEFAULT 'normal',
  rationale_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_claim_conflicts_ws ON cora_claim_conflicts(workspace_id, resolution);

CREATE TABLE IF NOT EXISTS cora_model_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL DEFAULT '{}',
  claim_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  snapshot_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  access_policy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_model_artifacts_ws ON cora_model_artifacts(workspace_id, kind, status);

CREATE TABLE IF NOT EXISTS cora_model_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  predecessor_id TEXT,
  status TEXT NOT NULL DEFAULT 'building',
  claim_set_hash TEXT,
  entity_graph_hash TEXT,
  reasoning_version TEXT,
  source_coverage_json TEXT NOT NULL DEFAULT '{}',
  built_at TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_model_snapshots_ws ON cora_model_snapshots(workspace_id, status);

CREATE TABLE IF NOT EXISTS cora_learning_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT,
  source_connection_ids_json TEXT NOT NULL DEFAULT '[]',
  stages_json TEXT NOT NULL DEFAULT '[]',
  reasoning_mode TEXT NOT NULL DEFAULT 'adaptive',
  daily_budget_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cora_learning_plans_ws ON cora_learning_plans(workspace_id);

CREATE TABLE IF NOT EXISTS cora_agent_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'agent_decides',
  allowed_sources_json TEXT NOT NULL DEFAULT '["*"]',
  allowed_domains_json TEXT NOT NULL DEFAULT '["*"]',
  max_confidentiality TEXT NOT NULL DEFAULT 'internal',
  allowed_audiences_json TEXT NOT NULL DEFAULT '["private"]',
  protected_domain_policy TEXT NOT NULL DEFAULT 'deny',
  token_budget_per_run INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cora_agent_grants_agent ON cora_agent_grants(workspace_id, agent_id);

CREATE TABLE IF NOT EXISTS cora_behavior_influences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  grant_id TEXT,
  source_claim_ids_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'context',
  interaction_audience TEXT NOT NULL DEFAULT 'private',
  protected_domain INTEGER NOT NULL DEFAULT 0,
  activation TEXT NOT NULL DEFAULT 'automatic',
  rendered_instruction TEXT NOT NULL,
  precedence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_behavior_influences_agent ON cora_behavior_influences(workspace_id, agent_id, status);

CREATE TABLE IF NOT EXISTS cora_migration_candidates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  observed_process_artifact_id TEXT,
  supporting_claim_ids_json TEXT NOT NULL DEFAULT '[]',
  current_systems_json TEXT NOT NULL DEFAULT '[]',
  recurrence REAL NOT NULL DEFAULT 0,
  determinism REAL NOT NULL DEFAULT 0,
  data_readiness REAL NOT NULL DEFAULT 0,
  expected_value REAL NOT NULL DEFAULT 0,
  operational_risk REAL NOT NULL DEFAULT 0,
  reversibility REAL NOT NULL DEFAULT 0,
  recommended_target TEXT NOT NULL DEFAULT 'keep_external',
  status TEXT NOT NULL DEFAULT 'observing',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_migration_candidates_ws ON cora_migration_candidates(workspace_id, status);

CREATE TABLE IF NOT EXISTS cora_audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor TEXT NOT NULL DEFAULT 'system',
  agent_id TEXT,
  event_type TEXT NOT NULL,
  subject_kind TEXT,
  subject_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_audit_events_ws ON cora_audit_events(workspace_id, event_type, created_at);
`,
  },
  {
    version: 64,
    name: 'cora_investigations_access_requests',
    // CORA second slice (RFC §11.2 + §9.5):
    //   • cora_investigations — bounded Feynman reasoning jobs with grounding
    //     scores; publish a cited result, a disputed result, or an explicit no-op.
    //   • cora_access_requests — the `human_approval` grant mode's request
    //     queue: what the agent wants to know, why, and the owner's decision
    //     (once / run / session / standing, with expiry).
    sql: `
CREATE TABLE IF NOT EXISTS cora_investigations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  requester_json TEXT NOT NULL DEFAULT '{}',
  scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  explanation TEXT,
  findings_json TEXT NOT NULL DEFAULT '[]',
  gaps_json TEXT NOT NULL DEFAULT '[]',
  evidence_version_ids_json TEXT NOT NULL DEFAULT '[]',
  claim_ids_json TEXT NOT NULL DEFAULT '[]',
  grounding REAL NOT NULL DEFAULT 0,
  model_versions_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_investigations_ws ON cora_investigations(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS cora_access_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  purpose TEXT NOT NULL,
  requested_domains_json TEXT NOT NULL DEFAULT '[]',
  interaction_audience TEXT NOT NULL DEFAULT 'private',
  status TEXT NOT NULL DEFAULT 'pending',
  decision_scope TEXT,
  decided_by TEXT,
  decided_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS cora_access_requests_ws ON cora_access_requests(workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS cora_access_requests_agent ON cora_access_requests(agent_id, status);
`,
  },
  {
    version: 65,
    name: 'runtime_native_sessions',
    sql: `
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'chat',
  runtime_profile_id TEXT,
  runtime_session_id TEXT NOT NULL,
  process_generation INTEGER NOT NULL DEFAULT 1,
  selected_model TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_sessions_owner
  ON runtime_sessions(workspace_id, agent_id, session_key, execution_mode);
CREATE INDEX IF NOT EXISTS runtime_sessions_agent
  ON runtime_sessions(workspace_id, agent_id, last_used_at);
`,
  },
  {
    version: 66,
    name: 'embedding_identity',
    // Brain 10x §B1.2 — every embedding-bearing row records WHICH model produced
    // its vector and at WHAT dimension, so retrieval can compare (model,dims)
    // instead of length alone. `needs_reembed` flags rows whose stored vector no
    // longer matches the workspace's configured provider, so the maintenance
    // sweep can re-embed them instead of silently degrading to lexical.
    sql: `
ALTER TABLE memory_episodes ADD COLUMN embedding_model TEXT;
ALTER TABLE memory_episodes ADD COLUMN embedding_dims INTEGER;
ALTER TABLE memory_episodes ADD COLUMN needs_reembed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_memory ADD COLUMN embedding TEXT;
ALTER TABLE workspace_memory ADD COLUMN embedding_model TEXT;
ALTER TABLE workspace_memory ADD COLUMN embedding_dims INTEGER;
ALTER TABLE workspace_memory ADD COLUMN needs_reembed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_notes ADD COLUMN embedding_model TEXT;
ALTER TABLE user_notes ADD COLUMN embedding_dims INTEGER;
ALTER TABLE user_notes ADD COLUMN needs_reembed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_moments ADD COLUMN embedding_model TEXT;
ALTER TABLE session_moments ADD COLUMN embedding_dims INTEGER;
ALTER TABLE session_moments ADD COLUMN needs_reembed INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS memory_episodes_needs_reembed
  ON memory_episodes(workspace_id, needs_reembed);
`,
  },
  {
    version: 67,
    name: 'unified_substrate_governing',
    // Brain 10x §B4 (dual-read stage, NON-DESTRUCTIVE) — memory_episodes becomes
    // the canonical substrate. `governing` marks operator-authored atoms that
    // must inject on every dispatch (the constitutional tier), replacing the
    // separate workspace_memory-only scan. `applies_to` carries scope-affinity
    // links (agent/workflow ids) for the narrow-write scope model (§B7.3). Both
    // additive + reversible; the workspace_memory → episodes backfill and the
    // eventual table drop are deferred destructive stages gated on a DB backup.
    sql: `
ALTER TABLE memory_episodes ADD COLUMN governing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_episodes ADD COLUMN applies_to TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS memory_episodes_governing
  ON memory_episodes(workspace_id, governing);
`,
  },
  {
    version: 68,
    name: 'remove_builtin_specialists',
    sql: `
DELETE FROM specialist_templates
  WHERE category = 'platform'
     OR slug IN ('planner','researcher','coder','reviewer','analyst','writer','monitor','architect','debugger','deployer');
DELETE FROM specialist_ability_loadouts
  WHERE role IN ('planner','researcher','coder','reviewer','analyst','writer','monitor','architect','debugger','deployer');
DELETE FROM specialist_minds
  WHERE role IN ('planner','researcher','coder','reviewer','analyst','writer','monitor','architect','debugger','deployer');
DELETE FROM specialist_profiles
  WHERE role IN ('planner','researcher','coder','reviewer','analyst','writer','monitor','architect','debugger','deployer');
DELETE FROM specialist_eval_profiles
  WHERE role IN ('planner','researcher','coder','reviewer','analyst','writer','monitor','architect','debugger','deployer');
DELETE FROM specialist_instances
  WHERE role IN ('planner','researcher','coder','reviewer','analyst','writer','monitor','architect','debugger','deployer');
DELETE FROM specialist_routing_decisions
  WHERE selected_role IN ('planner','researcher','coder','reviewer','analyst','writer','monitor','architect','debugger','deployer');
DELETE FROM specialist_runs
  WHERE role IN ('planner','researcher','coder','reviewer','analyst','writer','monitor','architect','debugger','deployer');
DELETE FROM agents
  WHERE role IN ('planner','researcher','coder','reviewer','analyst','writer','monitor','architect','debugger','deployer')
    AND json_extract(config, '$.specialist') = 1
    AND COALESCE(json_extract(config, '$.specialistSource'), 'platform') = 'platform';
`,
  },
  {
    version: 69,
    name: 'collapse_workspace_memory_into_episodes',
    // Brain 10x §B4 (DESTRUCTIVE — operator-sanctioned, post-backup) — fold the
    // typed workspace_memory plane into the canonical memory_episodes substrate.
    // Rows copy id-preserving with a `plane:workspace_memory` tag + a metadata
    // discriminator (memoryKind/memorySource/provenance) so the typed MemoryStore
    // facade reconstructs the kind/source contract. kind→type and source→episode
    // source are mapped; operator rules become `governing`. embedding is reset
    // (needs_reembed=1) so the spine re-embeds with the workspace provider.
    // Idempotent copy (NOT EXISTS), then drop the table.
    sql: `
INSERT INTO memory_episodes (
  id, workspace_id, scope_id, workflow_id, run_id, agent_id, type, title, summary, details, source,
  confidence, importance, trust, tags, entities, outcome_status, embedding, embedding_model, embedding_dims, needs_reembed,
  governing, applies_to, metadata, reinforced_at, archived_at, superseded_by, status, managed, pinned_at, last_accessed_at,
  is_disputed, dispute_reason, dispute_resolved_at, dispute_snoozed_until, context_condition, compressed_from, compression_tier,
  created_at, updated_at
)
SELECT
  wm.id, wm.workspace_id, wm.scope_id, NULL, NULL, NULL,
  CASE wm.kind WHEN 'rule' THEN 'decision' WHEN 'preference' THEN 'decision' WHEN 'fact' THEN 'observation' WHEN 'pattern' THEN 'success_pattern' ELSE 'distilled_lesson' END,
  wm.title, wm.content, NULL,
  CASE wm.source WHEN 'operator' THEN 'operator_write' WHEN 'seed' THEN 'seed' WHEN 'promotion' THEN 'run_promotion' WHEN 'agent' THEN 'agent_write' ELSE 'system_write' END,
  wm.trust, wm.importance, wm.trust,
  json_insert(CASE WHEN json_valid(wm.tags) THEN wm.tags ELSE '[]' END, '$[#]', 'plane:workspace_memory'),
  '[]',
  NULL, NULL, NULL, NULL, 1,
  CASE WHEN wm.source = 'operator' AND (wm.kind = 'rule' OR CAST(wm.importance AS REAL) >= 0.8) THEN 1 ELSE 0 END,
  '[]',
  json_object('plane', 'workspace_memory', 'memoryKind', wm.kind, 'memorySource', wm.source, 'provenance', CASE WHEN json_valid(wm.provenance) THEN json(wm.provenance) ELSE json('{}') END),
  wm.reinforced_at, NULL, NULL, 'active',
  CASE WHEN wm.source IN ('operator', 'seed', 'system') THEN 0 ELSE 1 END,
  NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL,
  wm.created_at, wm.updated_at
FROM workspace_memory wm
WHERE NOT EXISTS (SELECT 1 FROM memory_episodes me WHERE me.id = wm.id);
DROP TABLE workspace_memory;
`,
  },
  {
    version: 70,
    name: 'chat_plan_canvas',
    sql: `
ALTER TABLE conversations ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'chat';

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES conversation_messages(id) ON DELETE SET NULL,
  run_ids TEXT NOT NULL DEFAULT '[]',
  session_id TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  active_version INTEGER NOT NULL DEFAULT 1,
  approved_version INTEGER,
  decisions TEXT NOT NULL DEFAULT '[]',
  deviations TEXT NOT NULL DEFAULT '[]',
  verification TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS plans_conversation ON plans(workspace_id, conversation_id, updated_at);
CREATE INDEX IF NOT EXISTS plans_session ON plans(workspace_id, session_id);

CREATE TABLE IF NOT EXISTS plan_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(plan_id, version)
);
`,
  },
  {
    version: 71,
    name: 'rename_cora_to_grounding',
    // Brain 10x §B8 — "CORA" retired as a name. Internal understanding folded into
    // the Brain (facts, not claims); the claim/evidence/source machinery + its
    // tables are reserved for the future EXTERNAL-sources system, now named
    // "Grounding". Rename the 20 tables `cora_*` → `grounding_*`. SQLite's
    // ALTER TABLE … RENAME TO updates FK references in dependent tables
    // automatically (legacy_alter_table off by default), so this is safe.
    sql: `
ALTER TABLE cora_access_requests RENAME TO grounding_access_requests;
ALTER TABLE cora_agent_grants RENAME TO grounding_agent_grants;
ALTER TABLE cora_audit_events RENAME TO grounding_audit_events;
ALTER TABLE cora_behavior_influences RENAME TO grounding_behavior_influences;
ALTER TABLE cora_claim_conflicts RENAME TO grounding_claim_conflicts;
ALTER TABLE cora_claim_evidence RENAME TO grounding_claim_evidence;
ALTER TABLE cora_claims RENAME TO grounding_claims;
ALTER TABLE cora_entities RENAME TO grounding_entities;
ALTER TABLE cora_evidence_versions RENAME TO grounding_evidence_versions;
ALTER TABLE cora_identity_links RENAME TO grounding_identity_links;
ALTER TABLE cora_investigations RENAME TO grounding_investigations;
ALTER TABLE cora_learning_plans RENAME TO grounding_learning_plans;
ALTER TABLE cora_migration_candidates RENAME TO grounding_migration_candidates;
ALTER TABLE cora_model_artifacts RENAME TO grounding_model_artifacts;
ALTER TABLE cora_model_snapshots RENAME TO grounding_model_snapshots;
ALTER TABLE cora_owner_profiles RENAME TO grounding_owner_profiles;
ALTER TABLE cora_source_connections RENAME TO grounding_source_connections;
ALTER TABLE cora_source_objects RENAME TO grounding_source_objects;
ALTER TABLE cora_source_principals RENAME TO grounding_source_principals;
ALTER TABLE cora_sync_runs RENAME TO grounding_sync_runs;
`,
  },
  {
    version: 72,
    name: 'brain_working_set_and_shared_axis',
    // Brain 10x §C2 — sleep-time precomputed working set (Tier-0 cache): one row
    // per (workspace, scope) holding the precomputed top durable atoms so the
    // injector can serve a scope's core knowledge at zero retrieval cost.
    // §C7 — `shared` axis on every atom: 1 = visible to the whole team, 0 =
    // private to its scope/owner. Powers the privacy-scoped team brain.
    sql: `
CREATE TABLE IF NOT EXISTS brain_working_set (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id TEXT,
  atoms TEXT NOT NULL DEFAULT '[]',
  atom_count INTEGER NOT NULL DEFAULT 0,
  built_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS brain_working_set_scope
  ON brain_working_set(workspace_id, scope_id);
ALTER TABLE memory_episodes ADD COLUMN shared INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS memory_episodes_shared
  ON memory_episodes(workspace_id, shared);
`,
  },
  {
    version: 73,
    name: 'observability_events',
    sql: `
CREATE TABLE IF NOT EXISTS observability_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'workspace',
  scope_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT,
  actor_type TEXT,
  actor_id TEXT,
  target_type TEXT,
  target_id TEXT,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  node_id TEXT,
  approval_id TEXT REFERENCES approval_requests(id) ON DELETE SET NULL,
  correlation_id TEXT,
  parent_event_id TEXT,
  progress TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  raw_payload_redacted TEXT NOT NULL DEFAULT '{}',
  source_event TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(workspace_id, sequence_number)
);
CREATE INDEX IF NOT EXISTS observability_events_workspace_created
  ON observability_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS observability_events_workspace_sequence
  ON observability_events(workspace_id, sequence_number);
CREATE INDEX IF NOT EXISTS observability_events_run_sequence
  ON observability_events(run_id, sequence_number);
CREATE INDEX IF NOT EXISTS observability_events_agent_sequence
  ON observability_events(agent_id, sequence_number);
CREATE INDEX IF NOT EXISTS observability_events_workflow_sequence
  ON observability_events(workflow_id, sequence_number);
CREATE INDEX IF NOT EXISTS observability_events_scope_sequence
  ON observability_events(scope_type, scope_id, sequence_number);
`,
  },
  {
    version: 74,
    name: 'durable_task_spine',
    sql: `
PRAGMA foreign_keys = OFF;
CREATE TABLE IF NOT EXISTS plans_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES conversation_messages(id) ON DELETE SET NULL,
  run_ids TEXT NOT NULL DEFAULT '[]',
  session_id TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  active_version INTEGER NOT NULL DEFAULT 1,
  approved_version INTEGER,
  decisions TEXT NOT NULL DEFAULT '[]',
  deviations TEXT NOT NULL DEFAULT '[]',
  verification TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO plans_next (
  id, workspace_id, conversation_id, message_id, run_ids, session_id, title, objective, status,
  active_version, approved_version, decisions, deviations, verification, created_at, updated_at
)
SELECT
  id,
  workspace_id,
  conversation_id,
  message_id,
  CASE WHEN json_valid(coalesce(run_ids, '[]')) THEN run_ids ELSE '[]' END,
  session_id,
  title,
  objective,
  status,
  active_version,
  approved_version,
  CASE WHEN json_valid(coalesce(decisions, '[]')) THEN decisions ELSE '[]' END,
  CASE WHEN json_valid(coalesce(deviations, '[]')) THEN deviations ELSE '[]' END,
  CASE WHEN verification IS NOT NULL AND json_valid(verification) THEN verification ELSE NULL END,
  created_at,
  updated_at
FROM plans;
DROP TABLE plans;
ALTER TABLE plans_next RENAME TO plans;
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS plans_conversation ON plans(workspace_id, conversation_id, updated_at);
CREATE INDEX IF NOT EXISTS plans_session ON plans(workspace_id, session_id);
`,
  },
  {
    version: 75,
    name: 'channel_conversation_scope',
    sql: `
ALTER TABLE conversations ADD COLUMN channel_connection_id TEXT REFERENCES channel_connections(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN channel_chat_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations(workspace_id, agent_id, channel_connection_id, channel_chat_id, archived_at);
`,
  },
  {
    version: 76,
    name: 'approval_request_payload',
    sql: `
ALTER TABLE approval_requests ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    // The issues feature (IssueService + /v1/issues) shipped its schema.ts tables
    // and the issue_prefix / issue_id columns (added via the embedded idempotent
    // layer) but never a migration to CREATE the tables. Result: every workspace
    // hit "no such table: issues" on each /v1/issues poll. This creates them.
    version: 77,
    name: 'issues_feature',
    sql: `
CREATE TABLE IF NOT EXISTS issues (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignee_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
  linked_workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  active_run_id      TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  identifier         TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  status             TEXT NOT NULL DEFAULT 'backlog',
  priority           TEXT NOT NULL DEFAULT 'medium',
  labels             TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_issues_workspace ON issues(workspace_id, status);

CREATE TABLE IF NOT EXISTS workspace_counters (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  counter_name  TEXT NOT NULL,
  counter_value INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, counter_name)
);
`,
  },
  {
    version: 78,
    name: 'knowledge_chunks_recall_index',
    sql: `
-- The Brain recall hot path (KnowledgeStore candidate scan) filters
-- knowledge_chunks by (workspace_id, scope_id) and orders by updated_at DESC,
-- capped at CANDIDATE_SCAN_LIMIT. Until now the table carried only its
-- primary-key autoindex, so every recall was a full table scan + transient
-- sort that grew linearly with corpus size — invisible on small dev databases,
-- a cliff on real ones. memory_episodes already had its equivalents; this
-- closes the gap. Mirrored in src/sqlite/schema.ts (knowledgeChunks).
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_scope_recency
  ON knowledge_chunks (workspace_id, scope_id, updated_at);
`,
  },
  {
    version: 79,
    name: 'workflow_repair_checkpoints',
    sql: `
CREATE TABLE IF NOT EXISTS workflow_repair_checkpoints (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_id     TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  incident_id     TEXT NOT NULL,
  plan_id         TEXT NOT NULL,
  revision_before INTEGER NOT NULL,
  revision_after  INTEGER NOT NULL,
  graph_before    TEXT NOT NULL,
  graph_after     TEXT NOT NULL,
  patch           TEXT NOT NULL,
  rolled_back_at  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workflow_repair_checkpoints_run
  ON workflow_repair_checkpoints (run_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_repair_checkpoints_plan
  ON workflow_repair_checkpoints (run_id, plan_id);
`,
  },
  {
    version: 80,
    name: 'subdomains_and_workflow_owner',
    sql: `
-- Manager-owned org structure: a Subdomain is a domains row nested under a parent
-- Domain (parent_domain_id), with its manager_id pointing at the responsible
-- specialist. owner_agent_id gives a workflow a direct specialist owner. Both
-- are idempotent ADD COLUMNs (execMigrationSql tolerates duplicate-column when
-- the embedded drift path in src/sqlite/index.ts added them first). Mirrored in
-- src/sqlite/schema.ts (domains.parentDomainId, workflows.ownerAgentId).
ALTER TABLE domains ADD COLUMN parent_domain_id TEXT REFERENCES domains(id) ON DELETE SET NULL;
ALTER TABLE workflows ADD COLUMN owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_domains_parent ON domains(workspace_id, parent_domain_id);
CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(workspace_id, owner_agent_id);
`,
  },
  {
    version: 81,
    name: 'workflow_scoped_knowledge_bases',
    sql: `
-- Knowledge bases can be shared by the workspace (NULL scope) or belong to
-- one workflow Brain. The workspace management view still lists both; runtime
-- retrieval and the workflow Brain use the scope to keep context precise.
ALTER TABLE knowledge_bases ADD COLUMN scope_id TEXT REFERENCES workflows(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_scope ON knowledge_bases(workspace_id, scope_id);
`,
  },
  {
    version: 82,
    name: 'agentic_apps',
    sql: `
-- Agentic App = first-class deployable unit (AGENTIC-APPS-10X-MASTERPLAN §3).
-- An App owns workflows (workflows.app_id, nullable = full back-compat: a bare
-- workflow is an App-of-one). Surfaces (§4) and datastore (§5) land in later
-- migrations and reference apps(id). Mirrored in src/sqlite/schema.ts
-- (apps, appMembers, workflows.appId).
CREATE TABLE IF NOT EXISTS apps (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug             TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  version          TEXT NOT NULL DEFAULT '0.1.0',
  status           TEXT NOT NULL DEFAULT 'draft',
  entry_surface_id TEXT,
  icon             TEXT,
  manifest_json    TEXT NOT NULL DEFAULT '{}',
  policy_json      TEXT NOT NULL DEFAULT '{}',
  created_by       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_workspace_slug ON apps(workspace_id, slug);

CREATE TABLE IF NOT EXISTS app_members (
  app_id   TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'worker',
  PRIMARY KEY (app_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_app_members_agent ON app_members(agent_id);

ALTER TABLE workflows ADD COLUMN app_id TEXT REFERENCES apps(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_workflows_app ON workflows(workspace_id, app_id);
`,
  },
  {
    version: 83,
    name: 'app_datastore',
    sql: `
-- App Datastore (AGENTIC-APPS-10X-MASTERPLAN §5) — typed collections + records.
-- NOT the Brain: exact, structured, transactional rows. Records are validated
-- against the collection's field schema on write; V1 filters via json_extract
-- on data_json (a later pass projects indexed fields into generated columns).
-- Mirrored in src/sqlite/schema.ts (appCollections, appRecords).
CREATE TABLE IF NOT EXISTS app_collections (
  id           TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  schema_json  TEXT NOT NULL,
  policy_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_collections_app_name ON app_collections(app_id, name);

CREATE TABLE IF NOT EXISTS app_records (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES app_collections(id) ON DELETE CASCADE,
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  data_json     TEXT NOT NULL DEFAULT '{}',
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_records_collection ON app_records(collection_id, updated_at DESC);
`,
  },
  {
    version: 84,
    name: 'app_surfaces',
    sql: `
-- AG-UI surfaces (AGENTIC-APPS-10X-MASTERPLAN §4). An agent-authored ViewNode
-- tree + declared actions, owned by an App (not coupled to one workflow as the
-- legacy WorkflowGraph.surfaces JSON was). Mirrored in src/sqlite/schema.ts
-- (appSurfaces).
CREATE TABLE IF NOT EXISTS app_surfaces (
  id           TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'page',
  view_json    TEXT,
  actions_json TEXT NOT NULL DEFAULT '[]',
  shareable    INTEGER NOT NULL DEFAULT 0,
  revision     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_surfaces_app_name ON app_surfaces(app_id, name);
`,
  },
  {
    version: 85,
    name: 'app_lifecycle_snapshots',
    sql: `
-- App lifecycle snapshots (AGENTIC-SYSTEMS-ARCHITECTURE §9): captured before
-- upgrade so rollback restores both the manifest definition and live collection
-- rows. Rows are app-scoped and bounded by the lifecycle service.
CREATE TABLE IF NOT EXISTS app_lifecycle_snapshots (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id           TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version          TEXT NOT NULL,
  manifest_json    TEXT NOT NULL,
  collections_json TEXT NOT NULL DEFAULT '[]',
  reason           TEXT NOT NULL DEFAULT 'upgrade',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_app_lifecycle_snapshots_app ON app_lifecycle_snapshots(workspace_id, app_id, created_at);
`,
  },
  {
    version: 86,
    name: 'app_hub_ready_seams',
    sql: `
-- Hub-ready provenance: installed apps remain ordinary App rows while keeping
-- enough origin metadata for future Hub upgrade/fork flows.
ALTER TABLE apps ADD COLUMN source_json TEXT;
ALTER TABLE apps ADD COLUMN installed_checksum TEXT;

-- Indexed App datastore groundwork: fields marked \`indexed\` project into this
-- sidecar so V1 can accelerate common equality/inclusion filters without
-- schema-changing per-field generated columns.
CREATE TABLE IF NOT EXISTS app_record_index (
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES app_collections(id) ON DELETE CASCADE,
  record_id     TEXT NOT NULL REFERENCES app_records(id) ON DELETE CASCADE,
  field_key     TEXT NOT NULL,
  value_text    TEXT,
  value_number  REAL,
  value_boolean INTEGER,
  PRIMARY KEY (collection_id, record_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_app_record_index_text
  ON app_record_index(collection_id, field_key, value_text);
CREATE INDEX IF NOT EXISTS idx_app_record_index_number
  ON app_record_index(collection_id, field_key, value_number);
CREATE INDEX IF NOT EXISTS idx_app_record_index_boolean
  ON app_record_index(collection_id, field_key, value_boolean);

-- App environments are manifest snapshots for dev/staging/prod promotion. They
-- do not create a second runtime model; deploying/promoting still goes through
-- the same AppManifest -> App rows path.
CREATE TABLE IF NOT EXISTS app_environments (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'dev',
  manifest_json         TEXT NOT NULL,
  source_environment_id TEXT,
  promoted_at           TEXT,
  created_by            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_environments_app_name
  ON app_environments(workspace_id, app_id, name);
CREATE INDEX IF NOT EXISTS idx_app_environments_app
  ON app_environments(workspace_id, app_id, kind);
`,
  },
  {
    version: 87,
    name: 'app_lifecycle_origin_checksum',
    sql: `
-- Keep the original installed artifact receipt with lifecycle snapshots.
-- A workspace may have renamed the local slug on install, so recomputing from
-- the runtime manifest would not always recover the Hub/local artifact checksum.
ALTER TABLE app_lifecycle_snapshots ADD COLUMN installed_checksum TEXT;
`,
  },
  {
    version: 88,
    name: 'app_domain_and_owner',
    sql: `
-- Apps as the org primitive: an App is placed under a Domain (or Subdomain) and
-- owned by a specialist, mirroring workflows.domain_id / workflows.owner_agent_id.
-- Its workflows inherit this assignment at dispatch (resolveResponsibleSpecialist
-- app fallback) when they have no own owner/domain. Mirrored in
-- src/sqlite/schema.ts (apps.spaceId, apps.ownerAgentId) and the index.ts drift path.
ALTER TABLE apps ADD COLUMN domain_id TEXT REFERENCES domains(id) ON DELETE SET NULL;
ALTER TABLE apps ADD COLUMN owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_apps_domain ON apps(workspace_id, domain_id);
CREATE INDEX IF NOT EXISTS idx_apps_owner ON apps(workspace_id, owner_agent_id);
`,
  },
  {
    version: 89,
    name: 'memory_episodes_scope_recency_index',
    sql: `
-- §0.1 — the dispatch read path (loadAtoms) filters memory_episodes by
-- (workspace_id, scope_id) + archived_at IS NULL and orders by updated_at DESC.
-- Without this it is a per-workspace table scan on every recall; the prior v78
-- comment claiming the index existed was wrong (only the needs_reembed index
-- was ever created). Covering index for the scope + recency access pattern.
CREATE INDEX IF NOT EXISTS idx_memory_episodes_scope_recency
  ON memory_episodes(workspace_id, scope_id, updated_at);
`,
  },
  {
    version: 90,
    name: 'artifacts_app_and_origin',
    sql: `
-- Assets §1 — make artifacts groupable by what generated them. app_id binds an
-- artifact to its producing App (for the App "Data & Assets" view); origin is the
-- coarse source class (agent | app | workflow | channel | manual). Backfill origin
-- from the strongest existing signal. Mirrored in src/sqlite/schema.ts +
-- the index.ts drift path.
ALTER TABLE artifacts ADD COLUMN app_id TEXT REFERENCES apps(id) ON DELETE SET NULL;
ALTER TABLE artifacts ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
UPDATE artifacts SET origin = CASE
  WHEN run_id IS NOT NULL OR workflow_id IS NOT NULL THEN 'workflow'
  WHEN agent_id IS NOT NULL THEN 'agent'
  ELSE 'manual'
END;
CREATE INDEX IF NOT EXISTS idx_artifacts_app ON artifacts(workspace_id, app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_origin ON artifacts(workspace_id, origin, created_at);
`,
  },
  {
    version: 91,
    name: 'issues_scheduling',
    sql: `
-- Live Workspace §C — issues become the schedulable backlog. scheduled_for is
-- the ISO time the assigned agent should auto-start (picked up by the due
-- sweep); recurrence_cron reschedules it after each fire. Mirrored in
-- src/sqlite/schema.ts + the index.ts drift path.
ALTER TABLE issues ADD COLUMN scheduled_for TEXT;
ALTER TABLE issues ADD COLUMN recurrence_cron TEXT;
CREATE INDEX IF NOT EXISTS idx_issues_scheduled ON issues(workspace_id, scheduled_for);
`,
  },
  {
    version: 92,
    name: 'knowledge_bases_polymorphic_scope',
    sql: `
-- Knowledge scope is now polymorphic: a scoped Knowledge brain is owned by a
-- Workflow OR an Agentic App (App Brain → Knowledge binds scope_id = app.id).
-- The old FK pinned scope_id to workflows(id), so an App id raised a FK error
-- (surfaced as a 500 on create / "Workflow not found" path). Rebuild the table
-- to drop that FK; scope ownership is validated in the route against both tables.
-- Mirrored in src/sqlite/schema.ts (scopeId loses .references) + index.ts drift.
PRAGMA foreign_keys = OFF;
CREATE TABLE knowledge_bases_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  embedding_model TEXT NOT NULL DEFAULT 'lexical-v1',
  embedding_dimension INTEGER NOT NULL DEFAULT 0,
  chunking_config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO knowledge_bases_next (
  id, workspace_id, scope_id, name, description, embedding_model, embedding_dimension, chunking_config, created_at, updated_at
)
SELECT id, workspace_id, scope_id, name, description, embedding_model, embedding_dimension, chunking_config, created_at, updated_at
FROM knowledge_bases;
DROP TABLE knowledge_bases;
ALTER TABLE knowledge_bases_next RENAME TO knowledge_bases;
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_scope ON knowledge_bases(workspace_id, scope_id);
`,
  },
  {
    version: 93,
    name: 'conversation_permission_mode',
    sql: `
-- Per-conversation permission mode (Claude-Code style): 'ask' confirms mutating
-- actions, 'plan' proposes a plan and blocks mutations (reuses execution_mode
-- enforcement), 'auto' bypasses confirmation. Sticky per thread; flipped by the
-- chat composer toggle or by slash commands (/ask /plan /auto) over channels.
-- Mirrored in src/sqlite/schema.ts + embedded-sql.ts + index.ts drift.
ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask';
`,
  },
  {
    version: 94,
    name: 'blackboard_entries',
    sql: `
-- Blackboard — durable, identity-tagged inter-agent shared state
-- (AGENT-COOPERATION-10X). Promotes the run-scoped scratchpad/channel bus into
-- a persisted store so a convergence loop's cross-iteration memory survives an
-- API restart and is fully auditable. Every entry records WHO (agent) on WHICH
-- runtime wrote it, and WHICH iteration produced it, so an operator can read a
-- multi-runtime negotiation. Mirrored in src/sqlite/schema.ts (blackboardEntries).
CREATE TABLE IF NOT EXISTS blackboard_entries (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  namespace        TEXT NOT NULL DEFAULT 'run',   -- converge.stateKey | 'run'
  kind             TEXT NOT NULL,                  -- fact | message | claim | artifact_ref
  key              TEXT,                           -- KV key for facts
  channel          TEXT,                           -- channel name for messages
  author_agent_id  TEXT,
  author_runtime   TEXT,                           -- opus | codex | cursor | …
  author_label     TEXT,                           -- display name
  iteration        INTEGER NOT NULL DEFAULT 0,
  confidence       REAL,                           -- 0..1 for claims
  supersedes       TEXT,                           -- id of the entry this revises
  value            TEXT,                           -- JSON
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_blackboard_run ON blackboard_entries(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_blackboard_run_ns ON blackboard_entries(run_id, namespace);
`,
  },
  {
    version: 95,
    name: 'living_apps_channel_conversation_app_id',
    sql: `
-- Living Apps Phase 0 — the App owns the relationship. A channel connection and
-- a conversation can now belong to an Agentic App, so an inbound turn runs in
-- the App's context (its datastore, actions, and operating doctrine) and the
-- live thread is visible on the App's surfaces. Nullable + ON DELETE SET NULL,
-- so every existing channel/conversation keeps working untouched.
-- Mirrored in src/sqlite/schema.ts (channelConnections.appId / conversations.appId)
-- + the idempotent column-drift path in index.ts. Plain TEXT (no inline FK):
-- channel_connections + conversations are created in the embedded baseline, so the
-- drift adds this column BEFORE the apps table exists (apps is a later migration) —
-- an inline REFERENCES apps(id) would fail with "no such table: apps". The schema's
-- Drizzle .references() carries the ORM relation; app deletion degrades gracefully.
ALTER TABLE channel_connections ADD COLUMN app_id TEXT;
ALTER TABLE conversations ADD COLUMN app_id TEXT;
CREATE INDEX IF NOT EXISTS idx_channel_connections_app ON channel_connections(app_id);
CREATE INDEX IF NOT EXISTS idx_conversations_app ON conversations(app_id);
`,
  },
  {
    version: 96,
    name: 'living_apps_conversation_handoff',
    sql: `
-- Living Apps Phase 2 — operator handoff. 'human' parks the resident agent so an
-- operator can drive the thread (take over); null/'agent' = the agent answers.
-- Mirrored in src/sqlite/schema.ts (conversations.handoffState) + index.ts drift.
ALTER TABLE conversations ADD COLUMN handoff_state TEXT;
`,
  },
  {
    version: 97,
    name: 'living_apps_app_contacts',
    sql: `
-- Living Apps Phase 3 — the relationship entity. One row per contact an App
-- talks to, unifying a person across channels (peer_id) and carrying pipeline
-- state (stage/goal) + the proactivity clock (next_touch_at → the follow-up
-- sweep). Mirrored in src/sqlite/schema.ts (appContacts).
CREATE TABLE IF NOT EXISTS app_contacts (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  channel_kind    TEXT,
  handle          TEXT,
  peer_id         TEXT,
  display_name    TEXT,
  stage           TEXT,
  goal            TEXT,
  data_json       TEXT NOT NULL DEFAULT '{}',
  last_touch_at   TEXT,
  next_touch_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_contacts_handle ON app_contacts(app_id, channel_kind, handle);
CREATE INDEX IF NOT EXISTS idx_app_contacts_due ON app_contacts(workspace_id, next_touch_at);
CREATE INDEX IF NOT EXISTS idx_app_contacts_app ON app_contacts(app_id, stage);
`,
  },
  {
    version: 98,
    name: 'living_apps_conversation_participants',
    sql: `
-- Living Apps Phase 2 (G1) — multi-party threads. ADDITIVE: conversations.agent_id
-- stays the singular PRIMARY participant; this join layers more parties beside it
-- (customer + resident agent + escalation specialist + human operator in ONE
-- thread). An active 'specialist' agent participant becomes the inbound responder
-- (warm handoff). New table → inline FK to conversations is fine (it exists by now).
-- Mirrored in src/sqlite/schema.ts (conversationParticipants).
CREATE TABLE IF NOT EXISTS conversation_participants (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  participant_type  TEXT NOT NULL,
  participant_id    TEXT,
  role              TEXT NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1,
  joined_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  left_at           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_participants_party
  ON conversation_participants(conversation_id, participant_type, participant_id);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_conversation
  ON conversation_participants(conversation_id, active);

-- Backfill: seed the primary agent participant for existing App conversations.
INSERT INTO conversation_participants (id, conversation_id, participant_type, participant_id, role, active, joined_at)
SELECT
  lower(hex(randomblob(16))),
  c.id, 'agent', c.agent_id, 'primary', 1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM conversations c
WHERE c.app_id IS NOT NULL AND c.agent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM conversation_participants p
    WHERE p.conversation_id = c.id AND p.participant_type = 'agent' AND p.participant_id = c.agent_id
  );
`,
  },
  {
    version: 99,
    name: 'living_apps_contact_outcome',
    sql: `
-- Living Apps Phase M2 (G10) — the conversational learning loop. A resident App
-- relationship reaches an OUTCOME (won | lost | abandoned); recording it is what
-- lets the agent deposit a graded lesson and graduate winning patterns into an
-- ability. ADDITIVE: plain TEXT columns on app_contacts (no inline FK — even
-- though app_contacts is post-baseline, we keep the safe pattern). NULL = no
-- outcome yet (every existing row behaves exactly as before).
-- Mirrored in src/sqlite/schema.ts (appContacts.outcome / outcomeAt).
ALTER TABLE app_contacts ADD COLUMN outcome TEXT;
ALTER TABLE app_contacts ADD COLUMN outcome_at TEXT;
`,
  },
  {
    version: 100,
    name: 'living_apps_channel_turn_queue',
    sql: `
-- Living Apps Phase 5 (G2) — durable channel turns at scale. The inbound
-- dispatcher was fire-and-forget, in-process: a 24/7 desk dropped turns on
-- restart with no backpressure or resumption. This table makes a channel turn a
-- durable, at-least-once job: the ChannelTurnInput payload is stored verbatim, a
-- polling worker claims pending rows, runs the turn, and marks them done. A crash
-- mid-flight (lease expiry) re-picks the row; dedup_key (the inbound
-- conversation-message id) makes enqueue idempotent so a redelivered webhook
-- never doubles a turn. New table → inline FKs are fine (conversations/workspaces
-- exist by v100). Mirrored in src/sqlite/schema.ts (channelTurnQueue).
CREATE TABLE IF NOT EXISTS channel_turn_queue (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  app_id           TEXT,
  dedup_key        TEXT,
  payload          TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  leased_at        TEXT,
  last_attempt_at  TEXT,
  scheduled_for    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fail_reason      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Idempotency: a given inbound message enqueues at most one turn.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_turn_dedup ON channel_turn_queue(dedup_key);
-- Poller scan: pending rows whose backoff has elapsed, oldest first.
CREATE INDEX IF NOT EXISTS idx_channel_turn_poll ON channel_turn_queue(status, scheduled_for);
-- Per-conversation serialization bucket.
CREATE INDEX IF NOT EXISTS idx_channel_turn_conversation ON channel_turn_queue(conversation_id, status);
`,
  },
  {
    version: 104,
    name: 'living_apps_conversation_needs_attention',
    sql: `
-- Living Apps Phase 2 — "needs-you" flags. A resident agent FLAGS (it does not
-- interrupt) when a thread needs the operator — "Ana's ready to buy, wants a
-- discount I can't approve" — and the App console surfaces a count + a ◆ marker.
-- ADDITIVE: plain INTEGER/TEXT on conversations (no inline FK — both columns are
-- on the embedded baseline table; 0 = not flagged, every existing row unchanged).
-- Mirrored in src/sqlite/schema.ts (conversations.needsAttention/needsAttentionReason)
-- + index.ts drift. v101/v102/v103 reserved for parallel agents.
ALTER TABLE conversations ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN needs_attention_reason TEXT;
`,
  },
];
