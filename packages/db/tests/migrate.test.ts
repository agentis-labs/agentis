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
});
