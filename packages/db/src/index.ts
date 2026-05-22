/**
 * @agentis/db — dual-dialect database access.
 *
 * Embedded mode (default): SQLite via better-sqlite3.
 *   `import { openSqlite } from '@agentis/db/sqlite'`
 *
 * Standard mode (opt-in): PostgreSQL via postgres-js.
 *   `import { openPg } from '@agentis/db/pg'`
 *
 * Use `detectMode(env)` to pick the right driver based on environment.
 *
 * The two schemas use the SAME logical column names. Application code
 * should reference columns through the chosen schema export, not by raw
 * string names, so the dialect swap stays type-safe.
 */

// Versioned migration runner surface (used by the `agentis migrate` CLI and
// tests). Re-exported here so `@agentis/db` consumers don't reach into deep
// module paths.
export { runSqliteMigrations, getSqliteMigrationStatus } from './migrate.js';
export type { MigrationStatus, RunSqliteMigrationsResult } from './migrate.js';
export { SQLITE_MIGRATIONS } from './sqlite/migrations.js';
export type { Migration } from './sqlite/migrations.js';

export type AgentisDbMode = 'embedded' | 'standard';

export interface ModeDetectionEnv {
  AGENTIS_MODE?: string;
  AGENTIS_DATABASE_URL?: string;
  AGENTIS_REDIS_URL?: string;
}

/**
 * Mode rule (V1-SPEC §3.1):
 *   - explicit AGENTIS_MODE wins.
 *   - else AGENTIS_DATABASE_URL present → standard.
 *   - else embedded.
 */
export function detectMode(env: ModeDetectionEnv = process.env): AgentisDbMode {
  const explicit = env.AGENTIS_MODE?.toLowerCase();
  if (explicit === 'standard' || explicit === 'embedded') {
    return explicit;
  }
  if (env.AGENTIS_DATABASE_URL && env.AGENTIS_DATABASE_URL.length > 0) {
    return 'standard';
  }
  return 'embedded';
}
