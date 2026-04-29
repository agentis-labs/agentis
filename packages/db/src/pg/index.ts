/**
 * Standard-mode PostgreSQL driver. Loaded lazily by the factory only when
 * AGENTIS_DATABASE_URL is set.
 *
 * NOTE: PG schema parity with SQLite is partial in V1 (DEBT noted in
 * pg/schema.ts). Embedded mode is the launch path.
 */
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export type AgentisPgDb = PostgresJsDatabase<typeof schema>;

export interface PgOpenOptions {
  url: string;
  /** Maximum pool connections. Default 10. */
  max?: number;
}

export function openPg(options: PgOpenOptions): { db: AgentisPgDb; client: postgres.Sql } {
  const client = postgres(options.url, {
    max: options.max ?? 10,
    prepare: false,
  });
  const db = drizzle(client, { schema });
  return { db, client };
}

export { schema };
