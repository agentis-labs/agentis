import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { openSqlite } from '@agentis/db/sqlite';
import { migrateWorkspaceAppReliability } from '../src/services/app/appReliabilityMigration.js';
import { WorkflowRevisionService } from '../src/services/workflow/workflowRevisionService.js';

interface Args {
  confirm: boolean;
  database: string;
  workspaceId?: string;
  appId?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    confirm: argv.includes('--confirm'),
    database: resolve(value('--db') ?? join(process.cwd(), '.agentis', 'data.db')),
    workspaceId: value('--workspace-id'),
    appId: value('--app-id'),
  };
}

const args = parseArgs(process.argv.slice(2));
const { db, sqlite } = openSqlite({ path: args.database, migrate: false });

try {
  const workspaces = args.workspaceId
    ? [{ id: args.workspaceId }]
    : sqlite.prepare('SELECT id FROM workspaces ORDER BY created_at').all() as Array<{ id: string }>;
  if (workspaces.length === 0) throw new Error('No workspace exists in the selected database.');

  let backup: string | undefined;
  if (args.confirm) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveDir = join(dirname(args.database), 'archives');
    mkdirSync(archiveDir, { recursive: true });
    backup = join(archiveDir, `${basename(args.database)}.before-app-reliability-${stamp}.bak`);
    await sqlite.backup(backup);
  }

  const results = workspaces.map((workspace) => migrateWorkspaceAppReliability(
    db,
    new WorkflowRevisionService(db),
    workspace.id,
    { dryRun: !args.confirm, appId: args.appId },
  ));
  process.stdout.write(`${JSON.stringify({ mode: args.confirm ? 'applied' : 'preview', database: args.database, backup, workspaces: results }, null, 2)}\n`);
} finally {
  sqlite.close();
}
