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
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exec, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AppTestOptions, AppManifestEnvelope } from '@agentis/sdk';
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

// Publish the installed CLI version so the API can compare it against the
// latest release on npm and surface an "update available" prompt in the
// dashboard. package.json sits one level above both `src/` (dev) and `dist/`
// (published), so `../package.json` resolves in both. Best-effort: a missing
// or unreadable manifest just leaves the update check dormant.
function bindCliVersion(): void {
  if (process.env.AGENTIS_CLI_VERSION) return;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifestPath = resolve(here, '..', 'package.json');
    if (existsSync(manifestPath)) {
      const raw = readFileSync(manifestPath, 'utf8');
      const version = (JSON.parse(raw) as { version?: unknown }).version;
      if (typeof version === 'string') process.env.AGENTIS_CLI_VERSION = version;
    }
  } catch {
    // best-effort; the update check simply reports no current version.
  }
}

const HELP = `agentis — the operating system for agentic software

Usage:
  agentis up                              Start Agentis (default if no command given).
  agentis setup                           Prepare the embedding model and Chromium runtime.
  agentis warmup                          Pre-download the embedding model (~450 MB, once).
                                          Needed for offline/air-gapped hosts; up prepares it automatically.
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
  AGENTIS_EMBEDDING_CACHE_DIR    Where the embedding model is cached. Default: <data-dir>/models
  AGENTIS_EMBEDDING_MODEL_PATH   Directory of pre-downloaded model files (offline installs).
  AGENTIS_EMBEDDING_OFFLINE      true = never fetch the model remotely (use the local path only).
  AGENTIS_EMBEDDING_DTYPE        q8 = ~4x smaller download + faster CPU inference. Default: fp32.

Run \`agentis up\` and open http://127.0.0.1:3737 in your browser.
`;

async function dataDir(): Promise<string> {
  if (process.env.AGENTIS_DATA_DIR) return process.env.AGENTIS_DATA_DIR;
  const { resolveDefaultDataDir } = await import('@agentis/api/defaultDataDir');
  return resolveDefaultDataDir();
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
  bindCliVersion();
  maybeBindBundledWebDist();
  const dir = await dataDir();
  process.env.AGENTIS_DATA_DIR ??= dir;

  // First-run runtime preparation must finish before bootstrap starts memory
  // workers. The previous fire-and-forget child raced the server's own warm and
  // re-embed jobs against the same empty transformers cache, leaving partial
  // files that every later run mistook for a complete model.
  await prepareRuntime({ showOfflineHint: false });

  const { bootstrap } = await import('@agentis/api/bootstrap');
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

  // Last-resort safety net. `apps/api/src/index.ts` installs these guards for the
  // `pnpm dev` / standalone-binary path, but the CLI calls bootstrap() directly
  // and so never inherited them — meaning a single async throw on a later tick
  // (an adapter stdout handler, a best-effort DB write, a background embedding
  // that failed to load its native runtime) became an unhandledRejection and
  // Node killed the whole `agentis up` process, taking every live run and the
  // dashboard down with it. Observed in the wild: a bundled onnxruntime that
  // couldn't initialise crashed the server the moment a chat turn tried to embed.
  // Log loudly so the underlying bug stays visible, but keep serving.
  process.on('uncaughtException', (err) => {
    handle.logger.error('process.uncaught_exception', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
  process.on('unhandledRejection', (reason) => {
    handle.logger.error('process.unhandled_rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  const stop = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

/**
 * Pre-download the local embedding model.
 *
 * The Brain's ~450 MB ONNX weights are NOT shipped in the package — they are
 * fetched once on first use. `agentis up` warms them in the background, but that
 * is no help for an air-gapped or firewalled host, or a CI image that must be
 * built ready-to-run. This makes the download an explicit, scriptable step:
 * run it where there IS network, then ship/copy the cache dir.
 */
async function runWarmupCmd(options: { showOfflineHint?: boolean } = {}): Promise<number> {
  const dir = await dataDir();
  // The provider reads this to place its cache; set it so a warm run and a later
  // `agentis up` agree on the location.
  process.env.AGENTIS_DATA_DIR ??= dir;
  const cacheDir = process.env.AGENTIS_EMBEDDING_CACHE_DIR ?? join(dir, 'models');
  process.stdout.write(`Downloading the embedding model (~450 MB, once) → ${cacheDir}\n`);
  try {
    const { warmLocalEmbeddingModel } = await import('@agentis/api/embeddingProvider');
    const started = Date.now();
    await warmLocalEmbeddingModel();
    process.stdout.write(`Embedding model ready in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`);
    if (options.showOfflineHint !== false) {
      process.stdout.write('For an offline host, copy that directory over and set:\n');
      process.stdout.write(`  AGENTIS_EMBEDDING_MODEL_PATH=${cacheDir}\n  AGENTIS_EMBEDDING_OFFLINE=true\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`agentis warmup failed: ${(err as Error).message}\n`);
    return 1;
  }
}

type PlaywrightRuntime = {
  chromium: {
    executablePath(): string;
    launch(options: { headless: true }): Promise<{ close(): Promise<void> }>;
  };
};

async function launchChromiumProbe(runtime: PlaywrightRuntime): Promise<void> {
  const browser = await runtime.chromium.launch({ headless: true });
  await browser.close();
}

function resolvePlaywrightCli(): string {
  const entry = process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  const req = createRequire(entry);
  return join(dirname(req.resolve('playwright/package.json')), 'cli.js');
}

function runInherited(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref();
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`command exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}

/** Ensure both the browser package and its separately-downloaded binary work. */
async function prepareChromium(): Promise<number> {
  try {
    const specifier = 'playwright';
    const runtime = (await import(specifier)) as unknown as PlaywrightRuntime;
    try {
      await launchChromiumProbe(runtime);
      process.stdout.write(`Chromium ready at ${runtime.chromium.executablePath()}\n`);
      return 0;
    } catch {
      // Playwright intentionally ships browser binaries separately from npm.
      // Install through the CLI belonging to this exact global package version.
    }

    process.stdout.write('Downloading Chromium for Agentis browser tools (once)...\n');
    await runInherited(process.execPath, [resolvePlaywrightCli(), 'install', 'chromium'], 900_000);
    await launchChromiumProbe(runtime);
    process.stdout.write(`Chromium ready at ${runtime.chromium.executablePath()}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `Chromium setup failed: ${(err as Error).message}\n` +
        'Agentis will still start and retry on the first browser action. Run "agentis setup" to retry explicitly.\n',
    );
    return 1;
  }
}

async function prepareRuntime(options: { showOfflineHint?: boolean } = {}): Promise<number> {
  const embedding = await runWarmupCmd({ showOfflineHint: options.showOfflineHint });
  const chromium = await prepareChromium();
  return embedding === 0 && chromium === 0 ? 0 : 1;
}

async function runBackupCmd(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv);
  const [{ createBackup }, src] = await Promise.all([
    import('@agentis/api/backup'),
    dataDir(),
  ]);
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
  const targetDataDir = typeof flags['data-dir'] === 'string' ? (flags['data-dir'] as string) : await dataDir();
  const force = flags.force === true;

  try {
    const { restoreBackup } = await import('@agentis/api/backup');
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
    const { buildAgentisApp, createStarterApp } = await import('@agentis/sdk');
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
      const client = await appClient(flags);
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

// Verify the checksum against the RAW manifest as it sits in the file — never a
// schema-parsed projection. `validateAgentisApp` strips/defaults manifest fields
// to match the current schema; hashing that output breaks the checksum of an
// authentic older export. Hash the raw bytes, which is what `serialize` hashed.
async function verifyEnvelopeChecksum(envelope: { manifest: unknown; checksum?: unknown }): Promise<void> {
  const { canonicalizeManifest } = await import('@agentis/core');
  const checksum = createHash('sha256').update(canonicalizeManifest(envelope.manifest as never)).digest('hex');
  if (checksum !== envelope.checksum) {
    throw new Error('checksum mismatch: package is corrupt or tampered');
  }
}

async function appClient(flags: Record<string, string | true>) {
  const url = typeof flags.url === 'string' ? flags.url : undefined;
  const key = typeof flags['api-key'] === 'string' ? flags['api-key'] : undefined;
  const workspaceId = typeof flags['workspace-id'] === 'string' ? flags['workspace-id'] : undefined;
  if (!url || !key || !workspaceId) {
    throw new Error('requires --url <url> --api-key <key> --workspace-id <id>');
  }
  const { createAgentisClient } = await import('@agentis/sdk');
  return createAgentisClient({ baseUrl: url, token: key, workspaceId });
}

/**
 * A ZodError's `.message` is a multi-hundred-line JSON dump of every union
 * branch it tried — unreadable in a terminal and it buries the one line that
 * matters. Render `path: message` instead. Duck-typed: the CLI has no zod dep.
 */
function describeError(err: unknown): string {
  const shaped = err as { name?: unknown; issues?: unknown; message?: unknown };
  if (shaped?.name === 'ZodError' && Array.isArray(shaped.issues)) {
    const lines = shaped.issues
      .slice(0, 10)
      .map((raw) => {
        const issue = raw as { path?: unknown; message?: unknown; expected?: unknown; received?: unknown };
        const path = Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : '(root)';
        // An `invalid_union` reports its branch failures in unionErrors; the
        // top-level message ("Invalid input") alone doesn't say what was wrong.
        const detail = typeof issue.message === 'string' ? issue.message : 'invalid';
        const got = issue.received ? ` (received ${String(issue.received)})` : '';
        return `  ${path}: ${detail}${got}`;
      });
    const more = shaped.issues.length - lines.length;
    return `${shaped.issues.length} validation issue(s):\n${lines.join('\n')}${more > 0 ? `\n  …and ${more} more` : ''}`;
  }
  return typeof shaped?.message === 'string' ? shaped.message : String(err);
}

async function runAppCmd(argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'help';
  const { positionals, flags } = parseFlags(argv.slice(1));
  try {
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      process.stdout.write('Usage: agentis app <validate|pack|test|install|export> ...\n');
      return 0;
    }
    const {
      buildAgentisApp,
      validateAgentisApp,
      validateAppManifest,
    } = await import('@agentis/sdk');
    if (sub === 'validate') {
      const file = positionals[0];
      if (!file) throw new Error('agentis app validate requires a file');
      const value = await readJsonFile(file);
      if (value && typeof value === 'object' && (value as { format?: unknown }).format === '.agentisapp') {
        // Checksum first, over the RAW file bytes; then validate shape.
        await verifyEnvelopeChecksum(value as { manifest: unknown; checksum?: unknown });
        const envelope = validateAgentisApp(value);
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
      const raw = await readJsonFile(file);
      await verifyEnvelopeChecksum(raw as { manifest: unknown; checksum?: unknown });
      validateAgentisApp(raw); // shape check with a friendly error before the round-trip
      const spec = await readJsonFile(specFile) as AppTestOptions;
      // Send the RAW file so the server verifies the checksum over the same bytes.
      const result = await (await appClient(flags)).testApp(raw as AppManifestEnvelope, spec);
      process.stdout.write(`Passed ${result.data.assertions.length} assertion(s) across ${result.data.surfaces.length} surface(s)\n`);
      return 0;
    }
    if (sub === 'install') {
      const file = positionals[0];
      if (!file) throw new Error('agentis app install requires a .agentisapp file');
      const raw = await readJsonFile(file);
      await verifyEnvelopeChecksum(raw as { manifest: unknown; checksum?: unknown });
      validateAgentisApp(raw); // shape check with a friendly error before the round-trip
      const client = await appClient(flags);
      // Send the RAW file so the server verifies the checksum over the same bytes.
      const envelope = raw as AppManifestEnvelope;
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
      const client = await appClient(flags);
      const exported = await client.exportApp(appId);
      await verifyEnvelopeChecksum(exported.data);
      const out = typeof flags.out === 'string' ? flags.out : `${exported.data.manifest.identity.slug}.agentisapp`;
      await writeJsonFile(out, exported.data);
      process.stdout.write(`Exported ${exported.data.manifest.identity.name} to ${out}\n`);
      return 0;
    }
    throw new Error(`unknown app command: ${sub}`);
  } catch (err) {
    process.stderr.write(`agentis app ${sub} failed: ${describeError(err)}\n`);
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
  if (cmd === 'setup') {
    process.exitCode = await prepareRuntime();
    return;
  }
  if (cmd === 'warmup') {
    process.exitCode = await runWarmupCmd();
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
