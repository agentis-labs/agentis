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
// The stdio↔HTTP bridge Codex spawns to reach Agentis MCP. It is a RUNTIME file
// (spawned as `node <path>`), not a bundleable import, so tsup cannot inline it —
// it must be copied into the published tarball. `dist/scripts/` is where
// resolveBridgePath()'s walk-up finds it from `dist/index.cjs`.
const bridgeSrc = resolve(repoRoot, 'scripts', 'agentis-mcp-stdio-bridge.mjs');
const cliScriptsDist = resolve(cliDist, 'scripts');

/**
 * Heap for the child build steps. The Vite SPA build and the ~23 MB tsup bundle
 * run back to back in one `npm pack`, and on the default heap V8 has aborted
 * mid-bundle with SIGABRT (exit 134) — a release that fails ~half the time and
 * looks like a random crash. Raise it here so the build is self-sufficient
 * instead of depending on the operator exporting NODE_OPTIONS by hand.
 * An explicit NODE_OPTIONS from the caller still wins.
 */
const BUILD_HEAP_MB = 8192;
function buildEnv() {
  const existing = process.env.NODE_OPTIONS ?? '';
  if (/--max-old-space-size=/.test(existing)) return process.env;
  return { ...process.env, NODE_OPTIONS: `${existing} --max-old-space-size=${BUILD_HEAP_MB}`.trim() };
}

function run(cmd, args, opts = {}) {
  const display = `${cmd} ${args.join(' ')}`;
  console.log(`\n[prepack] $ ${display}`);
  const env = buildEnv();
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], {
        stdio: 'inherit',
        shell: false,
        cwd: opts.cwd ?? repoRoot,
        env,
      })
    : spawnSync(cmd, args, {
        stdio: 'inherit',
        shell: false,
        cwd: opts.cwd ?? repoRoot,
        env,
      });
  if (result.status === 134 || result.signal === 'SIGABRT') {
    throw new Error(
      `[prepack] ${display} aborted (V8 out of memory) even with --max-old-space-size=${BUILD_HEAP_MB}. ` +
        'Raise BUILD_HEAP_MB in scripts/prepack.mjs or free memory and retry.',
    );
  }
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

if (!existsSync(join(cliDist, 'index.cjs'))) {
  throw new Error(`[prepack] expected tsup output at ${join(cliDist, 'index.cjs')}`);
}

console.log(`[prepack] Copying web SPA → ${cliWebDist}`);
ensureFreshDir(cliWebDist);
cpSync(webDist, cliWebDist, { recursive: true });

const indexHtml = join(cliWebDist, 'index.html');
if (!existsSync(indexHtml)) {
  throw new Error(`[prepack] copy failed; missing ${indexHtml}`);
}

// Ship the MCP stdio bridge. Without this the published CLI tells Codex to spawn
// a bridge that does not exist; Codex silently drops the `agentis` MCP server and
// the agent sees ZERO agentis.* tools (it can chat but cannot build/patch/harden).
// This is a hard failure — never publish a tarball that cannot mount MCP.
if (!existsSync(bridgeSrc)) {
  throw new Error(`[prepack] missing MCP stdio bridge at ${bridgeSrc}`);
}
console.log(`[prepack] Copying MCP stdio bridge → ${cliScriptsDist}`);
ensureFreshDir(cliScriptsDist);
cpSync(bridgeSrc, join(cliScriptsDist, 'agentis-mcp-stdio-bridge.mjs'));
if (!existsSync(join(cliScriptsDist, 'agentis-mcp-stdio-bridge.mjs'))) {
  throw new Error(`[prepack] copy failed; missing ${join(cliScriptsDist, 'agentis-mcp-stdio-bridge.mjs')}`);
}

// Final gate: the built artifact must be self-sufficient for an npm user. Catches
// the whole class of "works in the repo, broken once published" bugs (a surviving
// bare require for an uninstalled package, or a missing runtime asset).
console.log('[prepack] Verifying bundle dependencies + runtime assets…');
run('node', ['scripts/check-bundle-deps.mjs'], { cwd: pkgRoot });

const bundleStat = statSync(join(cliDist, 'index.cjs'));
console.log(`[prepack] Done. CLI bundle: ${(bundleStat.size / 1024).toFixed(1)} KB`);
