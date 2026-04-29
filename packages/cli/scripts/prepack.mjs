// Prepack hook: runs before `npm pack` / `npm publish`. Builds the web SPA,
// bundles the CLI with tsup, then copies the SPA dist into <pkg>/dist/web so
// `agentis up` can serve the dashboard out of the published tarball.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const webDist = resolve(repoRoot, 'apps', 'web', 'dist');
const cliDist = resolve(pkgRoot, 'dist');
const cliWebDist = resolve(cliDist, 'web');

function run(cmd, args, opts = {}) {
  const display = `${cmd} ${args.join(' ')}`;
  console.log(`\n[prepack] $ ${display}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: opts.cwd ?? repoRoot,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`[prepack] command failed (${result.status}): ${display}`);
  }
}

function ensureFreshDir(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

console.log('[prepack] Building web SPA…');
run('pnpm', ['--filter', '@agentis/web', 'build']);

if (!existsSync(join(webDist, 'index.html'))) {
  throw new Error(`[prepack] expected web build output at ${webDist}`);
}

console.log('[prepack] Bundling CLI with tsup…');
run('pnpm', ['exec', 'tsup'], { cwd: pkgRoot });

if (!existsSync(join(cliDist, 'index.js'))) {
  throw new Error(`[prepack] expected tsup output at ${join(cliDist, 'index.js')}`);
}

console.log(`[prepack] Copying web SPA → ${cliWebDist}`);
ensureFreshDir(cliWebDist);
cpSync(webDist, cliWebDist, { recursive: true });

const indexHtml = join(cliWebDist, 'index.html');
if (!existsSync(indexHtml)) {
  throw new Error(`[prepack] copy failed; missing ${indexHtml}`);
}

const bundleStat = statSync(join(cliDist, 'index.js'));
console.log(`[prepack] Done. CLI bundle: ${(bundleStat.size / 1024).toFixed(1)} KB`);
