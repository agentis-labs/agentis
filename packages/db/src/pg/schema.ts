/**
 * Postgres dialect — Agentis standard mode.
 *
 * Activated when AGENTIS_DATABASE_URL is set. Uses the `postgres` driver +
 * Drizzle's pg-core dialect. Schema mirrors the SQLite version with native
 * types (`uuid`, `jsonb`, `timestamptz`, `boolean`).
 *
 * NOTE: Standard mode is opt-in. Embedded mode is the default for V1
 * (V1-SPEC §3.1). This module is loaded lazily by db/factory.ts only when
 * AGENTIS_DATABASE_URL is present, so the SQLite-only path doesn't pull in
 * `postgres` at runtime.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  integer,
  boolean,
  bigint,
  real,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

const baseTimestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 64 }).notNull().unique(),
  email: text('email'),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(true),
  ...baseTimestamps(),
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 120 }).notNull(),
  description: text('description'),
  imageUrl: text('image_url'),
  defaultAmbientId: uuid('default_ambient_id'),
  ...baseTimestamps(),
});

export const ambients = pgTable('ambients', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  kind: text('kind').notNull().default('local'),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  ...baseTimestamps(),
});

// The remaining tables follow the same name-and-shape mapping as
// sqlite/schema.ts. They are stubbed here for parity; flesh out as standard
// mode is exercised. Embedded mode is the V1 launch path (V1-SPEC §3.1).
//
// DEBT: full PG schema parity. Triggered when:
//   - First operator runs in standard mode end-to-end, OR
//   - Hub publish flow needs server-side PG behavior (jsonb operators).

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hubEntryId: text('hub_entry_id'),
  hubVersion: text('hub_version'),
  /** Agentic App that owns this workflow (AGENTIC-APPS-10X §3). Null = bare workflow. */
  appId: uuid('app_id').references(() => apps.id, { onDelete: 'set null' }),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  graph: jsonb('graph').notNull(),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  isPublishedToHub: boolean('is_published_to_hub').notNull().default(false),
  ...baseTimestamps(),
});

// ── Agentic Apps (AGENTIC-APPS-10X-MASTERPLAN §3/§4/§5) ──────────────────────
// Mirrored here on creation per §10.4 ("every new table ships on both paths").
// The wider ~40-table PG parity remains deferred debt (see note above); these
// are PG-portable by design — the only non-portable bit is the AppDatastore's
// json_extract filter, isolated for a mechanical swap to jsonb operators.

export const apps = pgTable('apps', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  slug: varchar('slug', { length: 120 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description').notNull().default(''),
  version: varchar('version', { length: 64 }).notNull().default('0.1.0'),
  status: text('status').notNull().default('draft'),
  entrySurfaceId: text('entry_surface_id'),
  icon: text('icon'),
  // Org placement (workflows inherit). FK targets live in the wider deferred PG
  // parity set, so these are plain uuids in the stub (enforced in SQLite).
  domainId: uuid('domain_id'),
  ownerAgentId: uuid('owner_agent_id'),
  manifestJson: jsonb('manifest_json').notNull().default(sql`'{}'::jsonb`),
  policyJson: jsonb('policy_json').notNull().default(sql`'{}'::jsonb`),
  sourceJson: jsonb('source_json'),
  installedChecksum: text('installed_checksum'),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ...baseTimestamps(),
});

export const appMembers = pgTable('app_members', {
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull(),
  role: text('role').notNull().default('worker'),
});

export const appCollections = pgTable('app_collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  schemaJson: jsonb('schema_json').notNull(),
  policyJson: jsonb('policy_json').notNull().default(sql`'{}'::jsonb`),
  ...baseTimestamps(),
});

export const appRecords = pgTable('app_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  collectionId: uuid('collection_id').notNull().references(() => appCollections.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  dataJson: jsonb('data_json').notNull().default(sql`'{}'::jsonb`),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by'),
  ...baseTimestamps(),
});

export const appRecordIndex = pgTable('app_record_index', {
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  collectionId: uuid('collection_id').notNull().references(() => appCollections.id, { onDelete: 'cascade' }),
  recordId: uuid('record_id').notNull().references(() => appRecords.id, { onDelete: 'cascade' }),
  fieldKey: varchar('field_key', { length: 64 }).notNull(),
  valueText: text('value_text'),
  valueNumber: real('value_number'),
  valueBoolean: boolean('value_boolean'),
}, (table) => ({
  pk: primaryKey({ columns: [table.collectionId, table.recordId, table.fieldKey] }),
  lookupText: index('idx_app_record_index_text').on(table.collectionId, table.fieldKey, table.valueText),
  lookupNumber: index('idx_app_record_index_number').on(table.collectionId, table.fieldKey, table.valueNumber),
  lookupBoolean: index('idx_app_record_index_boolean').on(table.collectionId, table.fieldKey, table.valueBoolean),
}));

export const appSurfaces = pgTable('app_surfaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  kind: text('kind').notNull().default('page'),
  viewJson: jsonb('view_json'),
  actionsJson: jsonb('actions_json').notNull().default(sql`'[]'::jsonb`),
  shareable: boolean('shareable').notNull().default(false),
  revision: integer('revision').notNull().default(0),
  ...baseTimestamps(),
});

export const appLifecycleSnapshots = pgTable('app_lifecycle_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  version: varchar('version', { length: 64 }).notNull(),
  manifestJson: jsonb('manifest_json').notNull(),
  installedChecksum: text('installed_checksum'),
  collectionsJson: jsonb('collections_json').notNull().default(sql`'[]'::jsonb`),
  reason: text('reason').notNull().default('upgrade'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appEnvironments = pgTable('app_environments', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  kind: text('kind').notNull().default('dev'),
  manifestJson: jsonb('manifest_json').notNull(),
  sourceEnvironmentId: uuid('source_environment_id'),
  promotedAt: timestamp('promoted_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  appName: uniqueIndex('idx_app_environments_app_name').on(table.workspaceId, table.appId, table.name),
  byApp: index('idx_app_environments_app').on(table.workspaceId, table.appId, table.kind),
}));

export const workflowRuns = pgTable('workflow_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  workflowId: uuid('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  status: text('status').notNull().default('CREATED'),
  runState: jsonb('run_state').notNull(),
  replanCount: integer('replan_count').notNull().default(0),
  triggerId: uuid('trigger_id'),
  parentRunId: uuid('parent_run_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ...baseTimestamps(),
});

export const ledgerEvents = pgTable('ledger_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ambientId: uuid('ambient_id').references(() => ambients.id, { onDelete: 'set null' }),
  runId: uuid('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  sequenceNumber: bigint('sequence_number', { mode: 'number' }).notNull(),
  eventType: text('event_type').notNull(),
  nodeId: text('node_id'),
  taskId: text('task_id'),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
