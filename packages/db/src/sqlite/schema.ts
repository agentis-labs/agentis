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
