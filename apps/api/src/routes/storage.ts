import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AgentisSqliteDb, AgentisSqliteRaw } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { RunCompactionService } from '../services/run/runCompactionService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';

export function buildStorageRoutes(deps: {
  db: AgentisSqliteDb;
  sqliteRaw: AgentisSqliteRaw;
  auth: AuthService;
  dataDir: string;
  archiveDir: string;
  maintenance: Pick<RunCompactionService, 'compact'>;
  policy: {
    fullRunDays: number;
    ledgerDays: number;
    observabilityDays: number;
    maxHotDbBytes: number;
    minFreeBytes: number;
  };
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const dbPath = join(deps.dataDir, 'data.db');
    const fs = statfsSync(deps.dataDir);
    const rows = deps.sqliteRaw.prepare(
      `SELECT name, SUM(pgsize) AS bytes FROM dbstat
       GROUP BY name ORDER BY bytes DESC LIMIT 20`,
    ).all() as Array<{ name: string; bytes: number }>;
    return c.json({
      hotDatabaseBytes: existsSync(dbPath) ? statSync(dbPath).size : 0,
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
      archiveDir: deps.archiveDir,
      archiveBytes: directoryBytes(deps.archiveDir),
      largestObjects: rows,
      policy: deps.policy,
    });
  });

  app.post('/maintenance', async (c) => c.json(await deps.maintenance.compact()));
  return app;
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      total += entry.isDirectory() ? directoryBytes(child) : statSync(child).size;
    }
    return total;
  } catch {
    return 0;
  }
}
