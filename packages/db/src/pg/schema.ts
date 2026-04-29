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
  title: varchar('title', { length: 255 }).notNull(),
  summary: text('summary'),
  graph: jsonb('graph').notNull(),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  isPublishedToHub: boolean('is_published_to_hub').notNull().default(false),
  ...baseTimestamps(),
});

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
