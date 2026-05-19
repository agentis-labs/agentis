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
 *   1. Pick the next version number (monotonic, no gaps).
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
];
