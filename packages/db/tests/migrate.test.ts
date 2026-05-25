import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  runSqliteMigrations,
  getSqliteMigrationStatus,
  SQLITE_MIGRATIONS,
} from '../src/index.js';
import { openSqlite } from '../src/sqlite/index.js';
import { EMBEDDED_INIT_SQL } from '../src/sqlite/embedded-sql.js';

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentis-db-test-'));
  return join(dir, 'data.db');
}

describe('runSqliteMigrations', () => {
  it('applies all registered migrations on a fresh database', () => {
    const path = tempDbPath();
    const sqlite = new Database(path);
    try {
      const result = runSqliteMigrations(sqlite);
      expect(result.applied.length).toBe(SQLITE_MIGRATIONS.length);
      // Status reflects applied set, no pending.
      const status = getSqliteMigrationStatus(sqlite);
      expect(status.applied.map((a) => a.version)).toEqual(
        SQLITE_MIGRATIONS.map((m) => m.version),
      );
      expect(status.pending).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('is idempotent — second invocation applies nothing', () => {
    const path = tempDbPath();
    const sqlite = new Database(path);
    try {
      runSqliteMigrations(sqlite);
      const second = runSqliteMigrations(sqlite);
      expect(second.applied).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('backfills version 1 when an old database has core tables but no schema_migrations', () => {
    // Simulate a database initialised by a pre-runner build: tables exist,
    // schema_migrations does not.
    const path = tempDbPath();
    const sqlite = new Database(path);
    try {
      sqlite.exec(EMBEDDED_INIT_SQL);
      // Sanity: schema_migrations is not present yet.
      const before = sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`,
        )
        .get();
      expect(before).toBeUndefined();

      const result = runSqliteMigrations(sqlite);
      // Version 1 is backfilled, then newer forward migrations are applied.
      expect(result.applied.map((m) => m.version)).toEqual(
        SQLITE_MIGRATIONS.filter((m) => m.version > 1).map((m) => m.version),
      );

      const status = getSqliteMigrationStatus(sqlite);
      expect(status.applied.map((a) => a.version)).toEqual(
        SQLITE_MIGRATIONS.map((m) => m.version),
      );
    } finally {
      sqlite.close();
    }
  });

  it('applies new migrations after historical migration ids from older builds', () => {
    const path = tempDbPath();
    const sqlite = new Database(path);
    try {
      sqlite.exec(EMBEDDED_INIT_SQL);
      sqlite.exec(`
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO schema_migrations (version, name) VALUES (1, 'init'), (2, 'company_os_layer');
`);

      const memoryMigration = SQLITE_MIGRATIONS.find((migration) => migration.name === 'agent_memories');
      expect(memoryMigration?.version).toBeGreaterThan(38);
      expect(
        sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_memories'`).get(),
      ).toBeUndefined();

      const result = runSqliteMigrations(sqlite);
      expect(result.applied.map((migration) => migration.name)).toContain('agent_memories');
      expect(
        sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_memories'`).get(),
      ).toBeDefined();
    } finally {
      sqlite.close();
    }
  });

  it('openSqlite wires the runner — schema_migrations is present after open', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path });
    try {
      const status = getSqliteMigrationStatus(sqlite);
      expect(status.applied.map((a) => a.version)).toContain(1);
      expect(status.pending).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('migrate:false on openSqlite skips the runner entirely', () => {
    const path = tempDbPath();
    const { sqlite } = openSqlite({ path, migrate: false });
    try {
      const tables = sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
        .get();
      expect(tables).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it('normalizes a legacy NOT-NULL-without-default workflows.concurrency_overflow column', () => {
    const path = tempDbPath();

    // 1. Reproduce the exact legacy drift: concurrency_overflow NOT NULL, no default.
    const legacy = new Database(path);
    legacy.exec(`
CREATE TABLE workflows (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  ambient_id            TEXT,
  user_id               TEXT NOT NULL,
  registry_entry_id     TEXT,
  registry_version      TEXT,
  title                 TEXT NOT NULL,
  summary               TEXT,
  intended_behavior     TEXT,
  graph                 TEXT NOT NULL,
  settings              TEXT NOT NULL DEFAULT '{}',
  is_from_registry      INTEGER NOT NULL DEFAULT 0,
  max_concurrent_runs   INTEGER,
  concurrency_overflow  TEXT NOT NULL,
  tags                  TEXT NOT NULL DEFAULT '[]',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);
    legacy
      .prepare('INSERT INTO workflows (id, workspace_id, user_id, title, graph, concurrency_overflow) VALUES (?,?,?,?,?,?)')
      .run('wf-legacy', 'ws-1', 'user-1', 'Legacy WF', '{}', 'queue');
    // Confirm the legacy constraint actually bites when the column is omitted.
    expect(() =>
      legacy
        .prepare('INSERT INTO workflows (id, workspace_id, user_id, title, graph) VALUES (?,?,?,?,?)')
        .run('wf-fail', 'ws-1', 'user-1', 'Should fail', '{}'),
    ).toThrow(/NOT NULL constraint failed: workflows\.concurrency_overflow/);
    legacy.close();

    // 2. Open through the runtime path — runs the embedded migrations incl. the rebuild.
    const { sqlite } = openSqlite({ path });
    try {
      const col = (sqlite.prepare("PRAGMA table_info('workflows')").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((c) => c.name === 'concurrency_overflow');
      expect(col?.notnull).toBe(1);
      expect(col?.dflt_value?.replace(/'/g, '')).toBe('queue');

      // Legacy row survives the rebuild.
      const legacyRow = sqlite.prepare("SELECT concurrency_overflow AS v FROM workflows WHERE id = 'wf-legacy'").get() as { v: string };
      expect(legacyRow.v).toBe('queue');

      // Inserting WITHOUT the column now succeeds and defaults to 'queue'
      // (FK off to isolate the column behaviour from parent-row requirements).
      sqlite.pragma('foreign_keys = OFF');
      sqlite
        .prepare('INSERT INTO workflows (id, workspace_id, user_id, title, graph) VALUES (?,?,?,?,?)')
        .run('wf-new', 'ws-1', 'user-1', 'New WF', '{}');
      const newRow = sqlite.prepare("SELECT concurrency_overflow AS v FROM workflows WHERE id = 'wf-new'").get() as { v: string };
      expect(newRow.v).toBe('queue');
    } finally {
      sqlite.close();
    }
  });
});
