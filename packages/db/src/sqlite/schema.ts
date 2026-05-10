/**
 * SQLite schema — Agentis embedded mode.
 *
 * Conventions:
 *  - Primary keys are TEXT UUIDs generated at the application layer
 *    (crypto.randomUUID()) for parity with PostgreSQL's `uuid` column.
 *  - JSON columns use `text({ mode: 'json' })`. SQLite stores JSON as TEXT;
 *    application code MUST treat reads as already-parsed values.
 *  - Timestamps are stored as ISO-8601 TEXT for sortability and zero-friction
 *    parity with PostgreSQL `timestamptz` columns. Default value is computed
 *    in `defaultTimestamps()` because better-sqlite3's CURRENT_TIMESTAMP
 *    omits timezone offset.
 *  - Every workspace-scoped row carries `workspace_id` and `user_id`. This is
 *    the multi-tenancy isolation contract; every query must filter by
 *    workspace, every API route must verify ownership.
 */

import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

const isoNow = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

const baseTimestamps = () => ({
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Users (single operator in V1; team = V2)
// ────────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email'),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(true),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// Workspaces & ambients
// ────────────────────────────────────────────────────────────

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  defaultAmbientId: text('default_ambient_id'),
  ...baseTimestamps(),
});

export const ambients = sqliteTable('ambients', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** local | dev | staging | prod | fleet | custom */
  kind: text('kind').notNull().default('local'),
  settings: text('settings', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// OpenClaw Gateways
// ────────────────────────────────────────────────────────────

export const openclawGateways = sqliteTable('openclaw_gateways', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  gatewayUrl: text('gateway_url').notNull(),
  deviceTokenCredentialId: text('device_token_credential_id'),
  /** connected | degraded | disconnected | error */
  status: text('status').notNull().default('disconnected'),
  lastHeartbeatAt: text('last_heartbeat_at'),
  lastSyncAt: text('last_sync_at'),
  healthSnapshot: text('health_snapshot', { mode: 'json' }).notNull().default(sql`'{}'`),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// Credentials (encrypted at rest with AES-256-GCM in CredentialVault)
// ────────────────────────────────────────────────────────────

export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  credentialType: text('credential_type').notNull(),
  /** AES-256-GCM ciphertext, base64; iv + ciphertext + tag concatenated. */
  encryptedValue: text('encrypted_value').notNull(),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// Agents
// ────────────────────────────────────────────────────────────

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  gatewayId: text('gateway_id').references(() => openclawGateways.id, { onDelete: 'set null' }),
  packageId: text('package_id'),
  name: text('name').notNull(),
  /** openclaw | claude_code | http */
  adapterType: text('adapter_type').notNull(),
  capabilityTags: text('capability_tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** Adapter-specific config; validated by adapter schema before connect(). */
  config: text('config', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** online | busy | offline | error */
  status: text('status').notNull().default('offline'),
  lastHeartbeatAt: text('last_heartbeat_at'),
  currentTaskId: text('current_task_id'),
  colorHex: text('color_hex'),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// Skills & packages
// ────────────────────────────────────────────────────────────

export const agentPackages = sqliteTable('agent_packages', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  registryEntryId: text('registry_entry_id'),
  name: text('name').notNull(),
  version: text('version').notNull(),
  manifest: text('manifest', { mode: 'json' }).notNull(),
  /** App Canvas: instance system-composition graph (AppGraph JSON, nullable). */
  appGraph: text('app_graph', { mode: 'json' }),
  installedAt: text('installed_at').notNull().default(isoNow() as unknown as string),
});

export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  packageId: text('package_id').references(() => agentPackages.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  version: text('version').notNull(),
  /** builtin | node_worker | docker_sandbox */
  runtime: text('runtime').notNull(),
  manifest: text('manifest', { mode: 'json' }).notNull(),
  ...baseTimestamps(),
});

export const skillExecutions = sqliteTable('skill_executions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  skillId: text('skill_id')
    .notNull()
    .references(() => skills.id, { onDelete: 'cascade' }),
  runId: text('run_id'),
  taskId: text('task_id'),
  status: text('status').notNull(),
  durationMs: integer('duration_ms'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull().default(isoNow() as unknown as string),
  finishedAt: text('finished_at'),
});

// ────────────────────────────────────────────────────────────
// Workflows, runs, run-state snapshots, tasks
// ────────────────────────────────────────────────────────────

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  registryEntryId: text('registry_entry_id'),
  registryVersion: text('registry_version'),
  title: text('title').notNull(),
  summary: text('summary'),
  graph: text('graph', { mode: 'json' }).notNull(),
  settings: text('settings', { mode: 'json' }).notNull().default(sql`'{}'`),
  isFromRegistry: integer('is_from_registry', { mode: 'boolean' }).notNull().default(false),
  ...baseTimestamps(),
});

export const triggers = sqliteTable('triggers', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** manual | cron | webhook | persistent_listener */
  triggerType: text('trigger_type').notNull(),
  config: text('config', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** active | paused | error */
  status: text('status').notNull().default('paused'),
  lastFiredAt: text('last_fired_at'),
  /** HMAC secret for webhook triggers, base64. Never returned over the wire. */
  webhookSecret: text('webhook_secret'),
  ...baseTimestamps(),
});

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  /** CREATED | PLANNING | RUNNING | WAITING | COMPLETED | FAILED | CANCELLED */
  status: text('status').notNull().default('CREATED'),
  runState: text('run_state', { mode: 'json' }).notNull(),
  replanCount: integer('replan_count').notNull().default(0),
  triggerId: text('trigger_id').references(() => triggers.id, { onDelete: 'set null' }),
  /** When this run was forked from a previous one (replay-from-node). */
  parentRunId: text('parent_run_id'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  ...baseTimestamps(),
});

export const workflowRunSnapshots = sqliteTable('workflow_run_snapshots', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => workflowRuns.id, { onDelete: 'cascade' }),
  /** Monotonic counter of ledger events at snapshot time; used for recovery. */
  sequenceNumber: integer('sequence_number').notNull(),
  runState: text('run_state', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  nodeId: text('node_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  /** agent | skill | subflow | router */
  executorType: text('executor_type').notNull(),
  /** agentId, skillId, workflowId, or router id. */
  executorRef: text('executor_ref').notNull(),
  capabilityTags: text('capability_tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  status: text('status').notNull().default('PENDING'),
  inputData: text('input_data', { mode: 'json' }).notNull().default(sql`'{}'`),
  outputData: text('output_data', { mode: 'json' }),
  error: text('error'),
  ...baseTimestamps(),
});

// ────────────────────────────────────────────────────────────
// Ledger — append-only event log per run.
// Indexed by (run_id, sequence_number); see migrations/0000_init.sql.
// ────────────────────────────────────────────────────────────

export const ledgerEvents = sqliteTable('ledger_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  runId: text('run_id')
    .notNull()
    .references(() => workflowRuns.id, { onDelete: 'cascade' }),
  /** Monotonic per-run sequence. Replay reads in this order. */
  sequenceNumber: integer('sequence_number').notNull(),
  eventType: text('event_type').notNull(),
  nodeId: text('node_id'),
  taskId: text('task_id'),
  payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Activity, approvals, conversations
// ────────────────────────────────────────────────────────────

export const activityEvents = sqliteTable('activity_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  /** user | agent | gateway | system */
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  summary: text('summary').notNull(),
  metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const approvalRequests = sqliteTable('approval_requests', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => workflowRuns.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  gatewayId: text('gateway_id').references(() => openclawGateways.id, { onDelete: 'set null' }),
  /** checkpoint | openclaw_exec | package_install | credential_access */
  source: text('source').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  confidence: integer('confidence'),
  /** pending | approved | rejected | expired | cancelled */
  status: text('status').notNull().default('pending'),
  resolutionReason: text('resolution_reason'),
  resolvedAt: text('resolved_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  /** OpenClaw Gateway session id when mirrored; null for Agentis-originated threads. */
  mirroredSessionId: text('mirrored_session_id'),
  unreadCount: integer('unread_count').notNull().default(0),
  lastMessageAt: text('last_message_at'),
  ...baseTimestamps(),
});

export const conversationMessages = sqliteTable('conversation_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** operator | agent | system */
  authorType: text('author_type').notNull(),
  authorId: text('author_id'),
  /** Reference to the OpenClaw session.message id when mirrored. */
  sessionMessageId: text('session_message_id'),
  body: text('body').notNull(),
  metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** sent | delivered | failed | mirrored */
  deliveryStatus: text('delivery_status').notNull().default('sent'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Skill registry
// ───────────────────────────────────────────────────────────

export const installedRegistryArtifacts = sqliteTable('installed_registry_artifacts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  entryId: text('entry_id').notNull(),
  /** workflow | skill | agent_package | workflow_template */
  entryType: text('entry_type').notNull(),
  version: text('version').notNull(),
  sha256: text('sha256').notNull(),
  localResourceId: text('local_resource_id').notNull(),
  /** Required: operator must explicitly acknowledge the permission summary. */
  permissionsAcknowledgedAt: text('permissions_acknowledged_at').notNull(),
  installedAt: text('installed_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Webhook deliveries (idempotency + replay defense)
// ────────────────────────────────────────────────────────────

export const webhookDeliveries = sqliteTable('webhook_deliveries', {
  id: text('id').primaryKey(),
  triggerId: text('trigger_id')
    .notNull()
    .references(() => triggers.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Idempotency key derived from x-agentis-delivery or HMAC of body+ts. */
  deliveryId: text('delivery_id').notNull().unique(),
  receivedAt: text('received_at').notNull().default(isoNow() as unknown as string),
  status: text('status').notNull(),
  responseRunId: text('response_run_id'),
});

// ────────────────────────────────────────────────────────────
// Channel bridge — Telegram/Discord/etc. (V1-SPEC §0.3 #24, §11)
// ────────────────────────────────────────────────────────────

export const channelConnections = sqliteTable('channel_connections', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: text('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Routes inbound channel messages into this agent's conversation. */
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  /** telegram | discord */
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  /** Bot token, AES-256-GCM encrypted via CredentialVault. Never returned. */
  tokenEncrypted: text('token_encrypted').notNull(),
  /** Inbound HMAC / Telegram secret_token shared secret. Never returned. */
  webhookSecret: text('webhook_secret'),
  /** Adapter-specific JSON (e.g. { defaultChatId } for outbound). */
  settings: text('settings', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** active | paused | error */
  status: text('status').notNull().default('active'),
  lastEventAt: text('last_event_at'),
  lastError: text('last_error'),
  ...baseTimestamps(),
});

export const channelDeliveries = sqliteTable('channel_deliveries', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id')
    .notNull()
    .references(() => channelConnections.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Adapter-issued unique id (Telegram update_id, Discord message id, etc.). */
  externalId: text('external_id').notNull().unique(),
  receivedAt: text('received_at').notNull().default(isoNow() as unknown as string),
  conversationMessageId: text('conversation_message_id'),
});

// ────────────────────────────────────────────────────────────
// Agent-First runtime (AGENT-FIRST-ARCHITECTURE.md §18)
// ────────────────────────────────────────────────────────────

/** App runtime contracts — Plane 1.
 *  Snapshotted at run start so an in-flight run is immune to mid-run package edits. */
export const appRuntimeContracts = sqliteTable('app_runtime_contracts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Optional pointer to an installed package. Null = ad hoc workflow contract. */
  packageId: text('package_id'),
  packageVersion: text('package_version'),
  /** AppRuntimeContract JSON. */
  contract: text('contract', { mode: 'json' }).notNull(),
  /** Hash of the contract JSON for cache lookups + replay anchors. */
  contractHash: text('contract_hash').notNull(),
  ...baseTimestamps(),
});

/** Per-run evaluator verdicts — Plane 6.
 *  Records every evaluator stage outcome so policy decisions are auditable. */
export const runEvaluations = sqliteTable('run_evaluations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  nodeId: text('node_id'),
  evaluatorId: text('evaluator_id').notNull(),
  /** schema | rule | rubric | llm — which tier produced the verdict. */
  tier: text('tier').notNull(),
  verdict: text('verdict').notNull(), // pass | fail | partial
  score: text('score'), // 0..1 stored as text for precision parity with PG numeric
  details: text('details', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** Cost incurred by this evaluation in cents (LLM tier only). */
  costCents: integer('cost_cents').notNull().default(0),
  evaluatedAt: text('evaluated_at').notNull().default(isoNow() as unknown as string),
});

/** Policy engine decisions — Plane 6.
 *  Captures the runtime policy verdict (allow/warn/pause/escalate/degrade/fail). */
export const runPolicyEvents = sqliteTable('run_policy_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  /** dispatch | retry | replan | terminal | budget | escalation */
  trigger: text('trigger').notNull(),
  /** allow | warn | pause | escalate | degrade | fail */
  decision: text('decision').notNull(),
  reason: text('reason').notNull(),
  context: text('context', { mode: 'json' }).notNull().default(sql`'{}'`),
  decidedAt: text('decided_at').notNull().default(isoNow() as unknown as string),
});

/** Per-node turn state — Plane 3 (multi-turn agent_task).
 *  Externalizes the turn loop so the run JSON does not bloat with raw transcripts. */
export const turnState = sqliteTable('turn_state', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  nodeId: text('node_id').notNull(),
  turnIndex: integer('turn_index').notNull(),
  /** working memory summary, kept compact for the next turn's prompt */
  summary: text('summary'),
  /** Raw turn payload — last response, tool results, evaluator status. */
  payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** Active blockers preventing forward progress (escalation triggers). */
  blockers: text('blockers', { mode: 'json' }).notNull().default(sql`'[]'`),
  costCents: integer('cost_cents').notNull().default(0),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

/** App baseline snapshots — Plane 8.
 *  Aggregated only after N successful runs; never written from a single run. */
export const appBaselineSnapshots = sqliteTable('app_baseline_snapshots', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** App identity (package id) or workflow id when no package. */
  appId: text('app_id').notNull(),
  costCentsP50: integer('cost_cents_p50'),
  costCentsP95: integer('cost_cents_p95'),
  latencyMsP50: integer('latency_ms_p50'),
  latencyMsP95: integer('latency_ms_p95'),
  /** 0..1 stored as text for precision. */
  evaluatorPassRate: text('evaluator_pass_rate'),
  outputCompletenessRate: text('output_completeness_rate'),
  /** Sample window metadata. */
  runCount: integer('run_count').notNull(),
  firstRunAt: text('first_run_at').notNull(),
  lastRunAt: text('last_run_at').notNull(),
  capturedAt: text('captured_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// App Knowledge Wedge — Agentis 1.1 (docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md)
//
// Six tables that materialise the four intelligence classes:
//   - knowledge_chunks            (Class 1 seed knowledge + Class 2 imported docs)
//   - app_memory                  (Class 1 seed memory + Class 4 promoted memory)
//   - app_evaluator_examples      (Class 3 evaluator examples)
//   - dataset_imports             (Class 2 ingestion jobs + impact preview)
//   - workflow_baselines          (per-workflow rolling baselines)
//   - app_promoted_patterns       (Class 4 distilled execution patterns)
//
// All tables are workspace-scoped and key off `app_id` (a string identifier
// that maps to either an installed package id or a workflow id when no
// package is involved — same convention as `app_baseline_snapshots`).
// ────────────────────────────────────────────────────────────

/** Knowledge plane storage: seeds (on activation) + ingested document chunks. */
export const knowledgeChunks = sqliteTable('knowledge_chunks', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** App identity (package id) or workflow id when no package. */
  appId: text('app_id').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  /** Tokenised content, used by the V1 lexical retriever. JSON array of strings. */
  contentTokens: text('content_tokens', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** seed | import | promotion. */
  source: text('source').notNull(),
  /** Provenance — package version, dataset key, ingestion job id, etc. */
  provenance: text('provenance', { mode: 'json' }).notNull().default(sql`'{}'`),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** Reserved for vector retrieval. JSON array of floats — null on lexical-only path. */
  embedding: text('embedding', { mode: 'json' }),
  /** 0..1 stored as text for precision. */
  trust: text('trust').notNull().default('1'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

/** App memory: typed episodes (facts, preferences, patterns, rules, lessons). */
export const appMemory = sqliteTable('app_memory', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull(),
  /** fact | preference | pattern | rule | lesson. */
  kind: text('kind').notNull(),
  /** seed | promotion | operator. */
  source: text('source').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  trust: text('trust').notNull().default('1'),
  /** 0..1 stored as text. */
  importance: text('importance').notNull().default('0.5'),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  provenance: text('provenance', { mode: 'json' }).notNull().default(sql`'{}'`),
  reinforcedAt: text('reinforced_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

/** Class 3: persisted evaluator examples sourced from seeds, imports, runs. */
export const appEvaluatorExamples = sqliteTable('app_evaluator_examples', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull(),
  evaluatorKey: text('evaluator_key').notNull(),
  /** seed | import | operator | promotion. */
  source: text('source').notNull(),
  input: text('input', { mode: 'json' }).notNull(),
  expected: text('expected', { mode: 'json' }).notNull(),
  /** pass | fail. */
  verdict: text('verdict').notNull(),
  score: text('score'),
  reason: text('reason'),
  /** Optional run that produced this example (operator-confirmed verdicts). */
  originRunId: text('origin_run_id'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Dataset ingestion jobs — class 2 import lifecycle.
 *
 * One row per `(app_id, dataset_key, run)`. Items are tracked aggregate-only
 * to keep V1 simple; if granular per-item recovery is needed, add a sibling
 * `dataset_import_items` table later.
 */
export const datasetImports = sqliteTable('dataset_imports', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull(),
  datasetKey: text('dataset_key').notNull(),
  /** pending | parsing | chunking | indexing | completed | failed | cancelled. */
  status: text('status').notNull(),
  sourceMeta: text('source_meta', { mode: 'json' }).notNull().default(sql`'{}'`),
  totalItems: integer('total_items').notNull().default(0),
  processedItems: integer('processed_items').notNull().default(0),
  storedItems: integer('stored_items').notNull().default(0),
  errors: text('errors', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** Filled in once status === 'completed'. */
  impact: text('impact', { mode: 'json' }),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Per-workflow rolling baselines — distinct from `app_baseline_snapshots`
 * (which is the Plane 8 cross-app aggregate).
 *
 * Each row is one snapshot in a versioned series; the latest row per
 * `(app_id, workflow_id)` is the active baseline.
 */
export const workflowBaselines = sqliteTable('workflow_baselines', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull(),
  workflowId: text('workflow_id').notNull(),
  /** seed | derived. */
  source: text('source').notNull(),
  p50DurationMs: integer('p50_duration_ms'),
  p95DurationMs: integer('p95_duration_ms'),
  /** 0..1 stored as text. */
  successRate: text('success_rate'),
  costCentsPerRun: integer('cost_cents_per_run'),
  sampleSize: integer('sample_size').notNull().default(0),
  windowStart: text('window_start').notNull(),
  windowEnd: text('window_end').notNull(),
  capturedAt: text('captured_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Per-item row for granular ingestion recovery (Agentis 1.1.1).
 *
 * One row per parsed item inside a dataset import job. Items are identified
 * by their content hash so the pipeline can skip already-completed rows when
 * the operator re-uploads the same file via the /resume endpoint.
 *
 * This table is a sibling to `dataset_imports` — aggregate counters on the
 * job row stay as-is; this table adds row-level granularity.
 */
export const datasetImportItems = sqliteTable('dataset_import_items', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Parent ingestion job. */
  importJobId: text('import_job_id')
    .notNull()
    .references(() => datasetImports.id, { onDelete: 'cascade' }),
  /** 0-indexed position in the parsed payload. */
  itemIndex: integer('item_index').notNull(),
  /** pending | completed | failed | skipped. */
  status: text('status').notNull().default('pending'),
  /** SHA-256 hex of the item's content — dedup key for resume. */
  contentHash: text('content_hash').notNull(),
  /** ID of the record written to the target store (first chunk's id). */
  storedId: text('stored_id'),
  /** Error message if status === 'failed'. */
  error: text('error'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

// ────────────────────────────────────────────────────────────
// Memory Architecture — Agentis Memory OS
// docs/memory/MEMORY-ARCHITECTURE.md
//
// Five tables that materialise the memory layers beyond the wedge:
//   - working_memory_entries   (Layer 1: typed scratchpad — durable variant)
//   - memory_episodes          (Layer 3: durable runtime episodes)
//   - memory_promotion_events  (Layer 3 audit trail)
//   - rolling_baseline_snapshots (Layer 4: rolling-window baselines)
//
// The wedge tables (`knowledge_chunks`, `app_memory`, `app_evaluator_examples`,
// `workflow_baselines`, `app_promoted_patterns`) cover Layers 2 and 4 already.
// ────────────────────────────────────────────────────────────

/**
 * Layer 1 — durable working memory entries.
 *
 * The in-process scratchpad lives in memory; this table persists important
 * working entries (working summaries, plans, blockers) so they survive
 * process restarts and can be inspected post-mortem.
 */
export const workingMemoryEntries = sqliteTable('working_memory_entries', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  /** run | agent | subflow | turn | eval | artifact | system. */
  namespace: text('namespace').notNull(),
  /** working_plan | working_summary | pending_questions | tool_result_cache | artifact_draft | evaluation_state | turn_history | blocker | note. */
  kind: text('kind').notNull(),
  /** Stable identifier within (namespace, kind). E.g. agentId, taskId. */
  entryKey: text('entry_key').notNull(),
  payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  tokenEstimate: integer('token_estimate').notNull().default(0),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Layer 3 — Runtime episodic memory.
 *
 * Distinct from `app_memory` (which holds typed knowledge: facts/rules/patterns).
 * `memory_episodes` holds execution-derived lessons: decisions, failures,
 * recoveries, success patterns, approvals, evaluator outcomes, etc.
 */
export const memoryEpisodes = sqliteTable('memory_episodes', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** App scope. NULL = workspace-global. */
  appId: text('app_id'),
  workflowId: text('workflow_id'),
  runId: text('run_id'),
  agentId: text('agent_id'),
  /** decision | failure | recovery | success_pattern | approval | evaluator_outcome | incident | artifact_outcome | distilled_lesson. */
  type: text('type').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  details: text('details'),
  /** run_promotion | agent_write | operator_write | evaluator_write | system_write. */
  source: text('source').notNull(),
  /** 0..1 stored as text for precision (matches the wedge's convention). */
  confidence: text('confidence').notNull().default('0.5'),
  importance: text('importance').notNull().default('0.5'),
  trust: text('trust').notNull().default('0.5'),
  tags: text('tags', { mode: 'json' }).notNull().default(sql`'[]'`),
  entities: text('entities', { mode: 'json' }).notNull().default(sql`'[]'`),
  /** good | bad | mixed | NULL. */
  outcomeStatus: text('outcome_status'),
  /** Reserved for vector retrieval. JSON array of floats. */
  embedding: text('embedding', { mode: 'json' }),
  metadata: text('metadata', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** When the episode was last reinforced (re-promoted or re-confirmed). */
  reinforcedAt: text('reinforced_at'),
  /** When the episode was archived. NULL = active. */
  archivedAt: text('archived_at'),
  /** ID of an episode that supersedes this one (NULL = current). */
  supersededBy: text('superseded_by'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Memory promotion audit trail (§10).
 *
 * One row per promotion candidate decision (promoted/rejected/merged/superseded).
 * Lets operators see exactly why a given episode landed in durable memory
 * and what was filtered out.
 */
export const memoryPromotionEvents = sqliteTable('memory_promotion_events', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: text('app_id'),
  runId: text('run_id'),
  candidateTitle: text('candidate_title').notNull(),
  candidatePayload: text('candidate_payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** evaluator_failure_summary | approval_rationale | replay_root_cause | tool_failure_pattern | winning_output_pattern | final_artifact_validation | operator_distillation | agent_proposal. */
  candidateSource: text('candidate_source').notNull(),
  /** promoted | rejected | merged | superseded. */
  decision: text('decision').notNull(),
  /** human_approved | evaluator_validated | repeated_pattern | major_failure | major_success | importance_threshold | operator_written | duplicate | low_importance | low_confidence. */
  reason: text('reason').notNull(),
  /** Episode that was created or updated (NULL on rejection). */
  episodeId: text('episode_id'),
  /** 0..1 score at decision time. */
  score: text('score').notNull().default('0'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Layer 4 — Rolling-window baseline snapshots.
 *
 * Each row is one rolling-window view (rolling_7d / rolling_30d / rolling_90d)
 * of a workflow's performance. The latest row per (workflowId, window) is
 * the active baseline for that window.
 *
 * Distinct from `workflow_baselines` (which is the wedge's seed/derived per-window-anonymous
 * snapshot) and `app_baseline_snapshots` (Plane 8 cross-app aggregate).
 */
export const rollingBaselineSnapshots = sqliteTable('rolling_baseline_snapshots', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: text('app_id'),
  workflowId: text('workflow_id').notNull(),
  /** rolling_7d | rolling_30d | rolling_90d. */
  window: text('window').notNull(),
  /** 0..1 stored as text. */
  successRate: text('success_rate').notNull().default('0'),
  p50LatencyMs: integer('p50_latency_ms').notNull().default(0),
  p95LatencyMs: integer('p95_latency_ms').notNull().default(0),
  avgCostMicros: integer('avg_cost_micros').notNull().default(0),
  /** Stored as text (allows fractional averages: 1.5 replays/run). */
  avgReplayCount: text('avg_replay_count').notNull().default('0'),
  avgApprovalCount: text('avg_approval_count').notNull().default('0'),
  evaluatorPassRate: text('evaluator_pass_rate').notNull().default('0'),
  sampleSize: integer('sample_size').notNull().default(0),
  windowStart: text('window_start').notNull(),
  windowEnd: text('window_end').notNull(),
  capturedAt: text('captured_at').notNull().default(isoNow() as unknown as string),
});

/**
 * Class 4: promoted execution intelligence — the compounding layer.
 *
 * Patterns are written here only when promotion thresholds are met. Each
 * pattern has confidence + trust + evidence count so retrieval can rank
 * confidently and the UI can show provenance.
 */
export const appPromotedPatterns = sqliteTable('app_promoted_patterns', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: text('app_id').notNull(),
  /** successful_playbook | failure_with_fix | approved_output_pattern | business_rule | recurring_exception. */
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  /** Schema depends on kind. */
  payload: text('payload', { mode: 'json' }).notNull().default(sql`'{}'`),
  /** 0..1 stored as text. */
  confidence: text('confidence').notNull().default('0.5'),
  trust: text('trust').notNull().default('0.8'),
  evidenceCount: integer('evidence_count').notNull().default(1),
  provenance: text('provenance', { mode: 'json' }).notNull().default(sql`'{}'`),
  reinforcedAt: text('reinforced_at').notNull().default(isoNow() as unknown as string),
  createdAt: text('created_at').notNull().default(isoNow() as unknown as string),
  updatedAt: text('updated_at').notNull().default(isoNow() as unknown as string),
});
