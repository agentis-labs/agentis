/**
 * Agentis CLI.
 *
 * Subcommands:
 *   agentis up                               — bootstrap and start Agentis on the current host. Default.
 *   agentis backup [--out DIR]               — snapshot the data dir into DIR (default: <data-dir>/backups/<ts>).
 *   agentis restore DIR [--force] [--data-dir DIR]
 *                                            — restore a backup directory into the data dir.
 *   agentis bootstrap [flags]                — commission an agent through the HTTP API.
 *   agentis bootstrap generate-config [flags]
 *                                            — generate an agentis-config.json scaffold.
 *   agentis export-config [flags]            — alias for bootstrap generate-config.
 *   agentis help                             — print this help.
 *
 * The CLI deliberately keeps a tiny surface; everything serious is in
 * `@agentis/api`. Embedders that want a programmatic entrypoint should call
 * `bootstrap()` from `@agentis/api/bootstrap` directly.
 */

import { basename, dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { bootstrap } from '@agentis/api/bootstrap';
import { createBackup, restoreBackup } from '@agentis/api/backup';
import { resolveDefaultDataDir } from '@agentis/api/defaultDataDir';
import { canonicalizeManifest } from '@agentis/core';
import {
  buildAgentisApp,
  createStarterApp,
  createAgentisClient,
  validateAgentisApp,
  validateAppManifest,
  type AppTestOptions,
  type AppManifestEnvelope,
} from '@agentis/sdk';
import { runBootstrapCmd, runGenerateConfigCmd } from './commands/bootstrap.js';

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

const HELP = `agentis — the operating system for agentic software

Usage:
  agentis up                              Start Agentis (default if no command given).
  agentis backup [--out <dir>]            Snapshot the data dir into <dir>.
                                          Default <dir>: <data-dir>/backups/<timestamp>.
  agentis restore <dir> [--force]         Restore a backup directory into the data dir.
                  [--data-dir <dir>]      --force overwrites an existing data.db.
  agentis create <dir> [--name <name>] [--install --url <url> --api-key <key> --workspace-id <id>]
                                          Scaffold a code-authored Agentic App.
  agentis app validate <file>             Validate an App manifest or .agentisapp envelope.
  agentis app pack <manifest> [--out f]   Build a .agentisapp envelope from an App manifest.
  agentis app install <file> --url <url> --api-key <key> --workspace-id <id>
                                          Preview and install a .agentisapp.
  agentis app test <file> --spec <file> --url <url> --api-key <key> --workspace-id <id>
                                          Run manifest actions/assertions in an isolated runtime transaction.
  agentis app export <app-id> --url <url> --api-key <key> --workspace-id <id> [--out f]
                                          Export an installed App as .agentisapp.
  agentis bootstrap --url <url> --api-key <key> --adapter <adapter>
                                          Commission an orchestrator, manager, or specialist through the API.
  agentis bootstrap generate-config --from <claude_code|codex> [--output <file>]
                                          Generate an agentis-config.json scaffold from local context.
  agentis export-config --from <claude_code|codex> [--output <file>]
                                          Alias for bootstrap generate-config.
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
  return process.env.AGENTIS_DATA_DIR ?? resolveDefaultDataDir();
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

  const launchToken = handle.secrets.launchToken;
  const openUrl = launchToken ? `${url}?token=${encodeURIComponent(launchToken)}` : url;

  process.stdout.write(`\n  Agentis is running at ${url}\n`);

  // Open the browser automatically. Works on macOS, Linux, and Windows.
  const opener =
    process.platform === 'win32' ? `start "" "${openUrl}"` :
    process.platform === 'darwin' ? `open "${openUrl}"` :
    `xdg-open "${openUrl}"`;
  exec(opener, () => { /* best-effort */ });

  if (!launchToken) {
    // Server/env-var deployment — no auto-login token. Print the URL only.
    process.stdout.write(`  Open the dashboard at ${url} and sign in.\n`);
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

async function runCreateCmd(argv: string[]): Promise<number> {
  const { positionals, flags } = parseFlags(argv);
  const destination = positionals[0];
  if (!destination) {
    process.stderr.write('agentis create requires a target directory.\nUsage: agentis create <dir> [--name <name>] [--install --url <url> --api-key <key> --workspace-id <id>]\n');
    return 2;
  }

  try {
    const dir = resolve(destination);
    if (existsSync(dir) && (await readdir(dir)).length > 0) {
      throw new Error(`target directory is not empty: ${dir}`);
    }
    const name = typeof flags.name === 'string' ? flags.name : titleFromDirectory(basename(dir));
    const manifest = createStarterApp(name);
    const envelope = buildAgentisApp(manifest);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeJsonFile(join(dir, 'app.agentisapp'), envelope);
    await writeJsonFile(join(dir, 'agentis.test.json'), {
      actions: [{ surface: 'home', name: 'createTask', args: { record: { title: 'First task', status: 'todo' } } }],
      assertions: [{ collection: 'tasks', count: 1, includes: { title: 'First task', status: 'todo' } }],
    });
    await writeJsonFile(join(dir, 'package.json'), {
      name: manifest.identity.slug,
      private: true,
      type: 'module',
      scripts: {
        pack: 'node src/app.mjs',
        validate: 'agentis app validate app.agentisapp',
      },
      dependencies: { '@agentis/sdk': '^0.1.0' },
    });
    await writeFile(join(dir, 'src', 'app.mjs'), starterAppSource(name), 'utf8');
    await writeFile(join(dir, 'README.md'), starterAppReadme(manifest.identity.name), 'utf8');
    process.stdout.write(`Created ${manifest.identity.name} in ${dir}\n`);

    if (flags.install === true) {
      const client = appClient(flags);
      const preview = await client.previewAppImport(envelope);
      const installed = await client.importApp(envelope, { permissionsAcknowledged: preview.data.permissions });
      process.stdout.write(`Installed app ${installed.data.appId}\n`);
    } else {
      process.stdout.write('Next: edit src/app.mjs, run npm run pack, then agentis app test app.agentisapp --spec agentis.test.json --url <url> --api-key <key> --workspace-id <id>\n');
    }
    return 0;
  } catch (err) {
    process.stderr.write(`agentis create failed: ${(err as Error).message}\n`);
    return 1;
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as unknown;
}

function titleFromDirectory(directory: string): string {
  const words = directory.replace(/[-_]+/g, ' ').trim();
  return words ? words.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'My Agentic App';
}

function starterAppSource(name: string): string {
  return `import { buildAgentisApp, createStarterApp } from '@agentis/sdk';
import { writeFile } from 'node:fs/promises';

const app = createStarterApp(${JSON.stringify(name)});
const envelope = buildAgentisApp(app);

await writeFile(
  new URL('../app.agentisapp', import.meta.url),
  \`\${JSON.stringify(envelope, null, 2)}\\n\`,
  'utf8',
);
`;
}

function starterAppReadme(name: string): string {
  return `# ${name}

This App runs inside a self-hosted Agentis runtime.

\`\`\`bash
npm install
npm run pack
agentis app test app.agentisapp --spec agentis.test.json --url http://127.0.0.1:3737 --api-key <key> --workspace-id <id>
agentis app install app.agentisapp --url http://127.0.0.1:3737 --api-key <key> --workspace-id <id>
\`\`\`

Edit \`src/app.mjs\` to change the manifest and \`agentis.test.json\` to define deterministic action/assertion checks. The generated \`.agentisapp\` is portable and can be exported, reviewed, installed, upgraded, or shared without requiring AgentisHub.
`;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function verifyEnvelopeChecksum(envelope: AppManifestEnvelope): void {
  const checksum = createHash('sha256').update(canonicalizeManifest(envelope.manifest)).digest('hex');
  if (checksum !== envelope.checksum) {
    throw new Error('checksum mismatch: package is corrupt or tampered');
  }
}

function appClient(flags: Record<string, string | true>) {
  const url = typeof flags.url === 'string' ? flags.url : undefined;
  const key = typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined;
  const workspaceId = typeof flags['workspace-id'] === 'string' ? flags['workspace-id'] : undefined;
  if (!url || !key || !workspaceId) {
    throw new Error('requires --url <url> --api-key <key> --workspace-id <id>');
  }
  return createAgentisClient({ baseUrl: url, token: key, workspaceId });
}

async function runAppCmd(argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'help';
  const { positionals, flags } = parseFlags(argv.slice(1));
  try {
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      process.stdout.write('Usage: agentis app <validate|pack|test|install|export> ...\n');
      return 0;
    }
    if (sub === 'validate') {
      const file = positionals[0];
      if (!file) throw new Error('agentis app validate requires a file');
      const value = await readJsonFile(file);
      if (value && typeof value === 'object' && (value as { format?: unknown }).format === '.agentisapp') {
        const envelope = validateAgentisApp(value);
        verifyEnvelopeChecksum(envelope);
        process.stdout.write(`Valid .agentisapp: ${envelope.manifest.identity.name} v${envelope.manifest.identity.version}\n`);
      } else {
        const manifest = validateAppManifest(value);
        process.stdout.write(`Valid AppManifest: ${manifest.identity.name} v${manifest.identity.version}\n`);
      }
      return 0;
    }
    if (sub === 'pack') {
      const file = positionals[0];
      if (!file) throw new Error('agentis app pack requires a manifest file');
      const manifest = validateAppManifest(await readJsonFile(file));
      const envelope = buildAgentisApp(manifest);
      const out = typeof flags.out === 'string' ? flags.out : `${manifest.identity.slug}.agentisapp`;
      await writeJsonFile(out, envelope);
      process.stdout.write(`Packed ${manifest.identity.name} to ${out}\n`);
      return 0;
    }
    if (sub === 'test') {
      const file = positionals[0];
      const specFile = typeof flags.spec === 'string' ? flags.spec : undefined;
      if (!file) throw new Error('agentis app test requires a .agentisapp file');
      if (!specFile) throw new Error('agentis app test requires --spec <file>');
      const envelope = validateAgentisApp(await readJsonFile(file));
      verifyEnvelopeChecksum(envelope);
      const spec = await readJsonFile(specFile) as AppTestOptions;
      const result = await appClient(flags).testApp(envelope, spec);
      process.stdout.write(`Passed ${result.data.assertions.length} assertion(s) across ${result.data.surfaces.length} surface(s)\n`);
      return 0;
    }
    if (sub === 'install') {
      const file = positionals[0];
      if (!file) throw new Error('agentis app install requires a .agentisapp file');
      const envelope = validateAgentisApp(await readJsonFile(file));
      verifyEnvelopeChecksum(envelope);
      const client = appClient(flags);
      const preview = await client.previewAppImport(envelope);
      process.stdout.write(
        `Installing ${preview.data.identity.name} v${preview.data.identity.version} ` +
        `(${preview.data.counts.workflows} logic, ${preview.data.counts.surfaces} surfaces, ${preview.data.counts.collections} collections)\n`,
      );
      for (const warning of preview.data.warnings) process.stdout.write(`  warning: ${warning}\n`);
      for (const permission of preview.data.permissions) process.stdout.write(`  permission: ${permission}\n`);
      const installed = await client.importApp(envelope, { permissionsAcknowledged: preview.data.permissions });
      process.stdout.write(`Installed app ${installed.data.appId}\n`);
      return 0;
    }
    if (sub === 'export') {
      const appId = positionals[0];
      if (!appId) throw new Error('agentis app export requires an app id');
      const client = appClient(flags);
      const exported = await client.exportApp(appId);
      verifyEnvelopeChecksum(exported.data);
      const out = typeof flags.out === 'string' ? flags.out : `${exported.data.manifest.identity.slug}.agentisapp`;
      await writeJsonFile(out, exported.data);
      process.stdout.write(`Exported ${exported.data.manifest.identity.name} to ${out}\n`);
      return 0;
    }
    throw new Error(`unknown app command: ${sub}`);
  } catch (err) {
    process.stderr.write(`agentis app ${sub} failed: ${(err as Error).message}\n`);
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
  if (cmd === 'create') {
    process.exitCode = await runCreateCmd(process.argv.slice(3));
    return;
  }
  if (cmd === 'app') {
    process.exitCode = await runAppCmd(process.argv.slice(3));
    return;
  }
  if (cmd === 'bootstrap') {
    process.exitCode = await runBootstrapCmd(process.argv.slice(3));
    return;
  }
  if (cmd === 'export-config') {
    process.exitCode = await runGenerateConfigCmd(process.argv.slice(3));
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
