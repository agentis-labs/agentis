/**
 * Database handle factory.
 *
 * Picks the dialect based on environment, opens the connection, and returns
 * a thin handle the rest of the app uses. The two dialects expose the SAME
 * logical schema names, so any code that imports `schema` from this module
 * is dialect-agnostic.
 *
 * V1 default: SQLite at `{dataDir}/data.db`. Standard mode (Postgres) is
 * opt-in via AGENTIS_DATABASE_URL.
 */

import { join } from 'node:path';
import { detectMode } from '@agentis/db';
import { openSqlite, schema as sqliteSchema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AgentisEnv } from './env.js';
import { AgentisError } from '@agentis/core';

export interface DbHandle {
  mode: 'embedded' | 'standard';
  /** SQLite handle for embedded mode. Postgres adds a sibling field later. */
  sqlite?: AgentisSqliteDb;
  schema: typeof sqliteSchema;
  close: () => Promise<void>;
}

export async function openDatabase(env: AgentisEnv): Promise<DbHandle> {
  const mode = detectMode({
    AGENTIS_MODE: env.AGENTIS_MODE,
    AGENTIS_DATABASE_URL: env.AGENTIS_DATABASE_URL,
  });

  if (mode === 'embedded') {
    const path = join(env.AGENTIS_DATA_DIR, 'data.db');
    const { db, sqlite } = openSqlite({ path });
    return {
      mode,
      sqlite: db,
      schema: sqliteSchema,
      close: async () => {
        sqlite.close();
      },
    };
  }

  // Standard mode is partially scaffolded; the engine + services target the
  // sqlite handle in V1. Switching the engine to dialect-agnostic helpers is
  // tracked as DEBT in DECISIONS.md.
  throw new AgentisError(
    'INTERNAL_ERROR',
    'Standard (Postgres) mode is scaffolded but the engine wiring is not complete in V1. Set AGENTIS_MODE=embedded for now.',
  );
}
