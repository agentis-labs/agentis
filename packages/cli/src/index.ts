/**
 * Agentis CLI.
 *
 * Subcommands:
 *   agentis up                  — bootstrap and start Agentis on the current host. Default.
 *   agentis backup [--out DIR]  — snapshot the data dir into DIR (default: <data-dir>/backups/<ts>).
 *   agentis restore DIR [--force] [--data-dir DIR]
 *                               — restore a backup directory into the data dir.
 *   agentis help                — print this help.
 *
 * The CLI deliberately keeps a tiny surface; everything serious is in
 * `@agentis/api`. Embedders that want a programmatic entrypoint should call
 * `bootstrap()` from `@agentis/api/bootstrap` directly.
 */

import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@agentis/api/bootstrap';
import { createBackup, restoreBackup } from '@agentis/api/backup';

// When the CLI is published to npm and run via `npx`, the bundled web SPA
// ships at <pkg>/dist/web. We point AGENTIS_DASHBOARD_DIST at it so the
// HTTP server serves the dashboard out of the same install. In dev (tsx
// from source), the env var is left untouched and bootstrap skips the
// static mount.
function maybeBindBundledWebDist(): void {
  if (process.env.AGENTIS_DASHBOARD_DIST) return;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = resolve(here, 'web');
    if (existsSync(join(candidate, 'index.html'))) {
      process.env.AGENTIS_DASHBOARD_DIST = candidate;
    }
  } catch {
    // best-effort; bootstrap will simply skip the static mount.
  }
}

const HELP = `agentis — proactive ambient dashboard

Usage:
  agentis up                              Start Agentis (default if no command given).
  agentis backup [--out <dir>]            Snapshot the data dir into <dir>.
                                          Default <dir>: <data-dir>/backups/<timestamp>.
  agentis restore <dir> [--force]         Restore a backup directory into the data dir.
                  [--data-dir <dir>]      --force overwrites an existing data.db.
  agentis help                            Show this message.

Environment:
  AGENTIS_DATA_DIR               Where to store data and secrets. Default: .agentis
  AGENTIS_HTTP_PORT              HTTP port. Default: 3737
  AGENTIS_SEED_USERNAME          Operator username on first boot. Default: operator
  AGENTIS_SEED_PASSWORD          Operator password on first boot. Default: random.
  AGENTIS_DATABASE_URL           Set to a postgres URL to use standard mode.

Run \`agentis up\` and open http://127.0.0.1:3737 in your browser.
`;

function dataDir(): string {
  return process.env.AGENTIS_DATA_DIR ?? '.agentis';
}

function timestampSlug(): string {
  // 2026-04-28T22-31-15Z — filename-safe ISO without colons.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseFlags(argv: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

async function runUp(): Promise<void> {
  maybeBindBundledWebDist();
  const handle = await bootstrap();
  const { url } = await handle.start();
  process.stdout.write(`\n  Agentis is running at ${url}\n`);
  if (handle.seed?.generatedPassword) {
    process.stdout.write(
      `\n  First-boot operator credentials:\n    username: ${handle.seed.user.username}\n    password: ${handle.seed.generatedPassword}\n  Save these now — Agentis will not print them again.\n`,
    );
  }
  const stop = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

async function runBackupCmd(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const src = dataDir();
  const out =
    typeof flags.out === 'string'
      ? flags.out
      : join(src, 'backups', `agentis-backup-${timestampSlug()}`);

  try {
    const result = await createBackup({ dataDir: src, outDir: out });
    process.stdout.write(
      `Backup written to ${result.outDir}\n  files: ${result.files.join(', ')}\n  manifest: ${result.manifestPath}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`agentis backup failed: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runRestoreCmd(argv: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(argv);
  const backupDir = positionals[0];
  if (!backupDir) {
    process.stderr.write(`agentis restore requires a backup directory.\nUsage: agentis restore <dir> [--force] [--data-dir <dir>]\n`);
    return 2;
  }
  const targetDataDir = typeof flags['data-dir'] === 'string' ? (flags['data-dir'] as string) : dataDir();
  const force = flags.force === true;

  try {
    const result = await restoreBackup({ backupDir, dataDir: targetDataDir, force });
    process.stdout.write(
      `Restored ${result.files.length} file(s) into ${result.dataDir}\n  files: ${result.files.join(', ')}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`agentis restore failed: ${(err as Error).message}\n`);
    return 1;
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'up';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'up') {
    await runUp();
    return;
  }
  if (cmd === 'backup') {
    process.exitCode = await runBackupCmd(process.argv.slice(3));
    return;
  }
  if (cmd === 'restore') {
    process.exitCode = await runRestoreCmd(process.argv.slice(3));
    return;
  }
  process.stderr.write(`Unknown command: ${cmd}\n${HELP}`);
  process.exitCode = 2;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
