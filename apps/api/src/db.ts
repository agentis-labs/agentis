/**
 * Database handle factory.
 *
 * Picks the dialect based on environment, opens the connection, and returns
 * a thin handle the rest of the app uses. The two dialects expose the SAME
 * logical schema names, so any code that imports `schema` from this module
 * is dialect-agnostic.
 *
 * V1 runtime: local-first SQLite at `{dataDir}/data.db`. Standard/Postgres
 * configuration is detected so operators get a clear startup error instead
 * of a half-wired process.
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

  // V1 is intentionally local-first. The schema has standard-mode scaffolding,
  // but the engine, realtime promotion hooks, and service composition require
  // the embedded SQLite handle. Fail closed until the hosted runtime is wired
  // end-to-end.
  throw new AgentisError(
    'VALIDATION_FAILED',
    'Standard (Postgres) mode is scaffolded but the engine wiring is not complete in V1. Set AGENTIS_MODE=embedded for now.',
    {
      remediation: 'Unset AGENTIS_DATABASE_URL or set AGENTIS_MODE=embedded for the V1 local-first runtime.',
      details: { requestedMode: mode, supportedMode: 'embedded' },
    },
  );
}
