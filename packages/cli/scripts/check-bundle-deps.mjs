/**
 * Packaging guard: every module the built bundle still reaches for at RUNTIME
 * must be installable by an npm user.
 *
 * Why this exists. The CLI ships as one bundled `dist/index.cjs`. Anything esbuild
 * could not inline survives as a bare `require("x")` / `import("x")`. If `x` is
 * not a Node builtin and not a declared `dependencies` entry, npm never installs
 * it and the user gets MODULE_NOT_FOUND — but only on the code path that touches
 * it, so it looks like "the product is broken", not "a dep is missing".
 *
 * This has bitten us twice:
 *   - the MCP stdio bridge (a spawned file that wasn't published) → agents had
 *     ZERO agentis.* tools on npm installs;
 *   - `sharp` (native, pulled in by baileys) → its glue was inlined while its
 *     `@img/sharp-*` platform packages were never installed.
 *
 * Both were invisible to unit tests, which only ever exercised the repo layout.
 * This check reads the actual built artifact, so it cannot be fooled that way.
 *
 * Run: node scripts/check-bundle-deps.mjs   (prepack runs it automatically)
 */

import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const bundlePath = resolve(pkgRoot, 'dist', 'index.cjs');

/**
 * Modules that may legitimately be absent at runtime. Each is an OPTIONAL native
 * accelerator that its consumer already loads inside try/catch and works without.
 * Anything not on this list must be a real dependency.
 */
const OPTIONAL_ALLOWLIST = new Set([
  'bufferutil', // ws: optional native speedup
  'utf-8-validate', // ws: optional native validator
  'encoding', // node-fetch: optional charset conversion
  // Verified optional in OUR code — each is loaded in try/catch and the feature
  // degrades or is gated behind an explicit opt-in. Do NOT add anything here
  // whose absence breaks a default code path (node-cron was such a case: cron
  // triggers THREW without it, so it is a real dependency instead).
  'isolated-vm', // nodeWorkerRuntime: node:vm fallback unless AGENTIS_EXTENSION_REQUIRE_ISOLATE=true
  'dockerode', // dockerSandboxRuntime: docker_sandbox needs a Docker daemon anyway
  'jimp', // baileys: optional image path (sharp is the one we ship)
  'link-preview-js', // baileys: optional link previews
  'zlib-sync', // discord.js: optional native zlib
  'audio-decode', // discord.js voice: optional decoder
]);

/** Required runtime files that must exist in `dist/` (not just be requireable). */
const REQUIRED_ASSETS = [
  ['dist/scripts/agentis-mcp-stdio-bridge.mjs', 'Codex cannot mount MCP → agents get ZERO agentis.* tools'],
  ['dist/web/index.html', 'the dashboard cannot be served'],
];

function fail(lines) {
  console.error(`\n[check-bundle-deps] FAILED\n${lines.join('\n')}\n`);
  process.exit(1);
}

if (!existsSync(bundlePath)) {
  fail([`  Bundle not found at ${bundlePath}. Run tsup first.`]);
}

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const source = readFileSync(bundlePath, 'utf8');

/** The package name a specifier belongs to (`@scope/pkg/sub` → `@scope/pkg`). */
function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Bare (non-relative, non-absolute) require()/import() specifiers.
const specifiers = new Set();
for (const re of [/require\(\s*["']([^"'`]+)["']\s*\)/g, /(?<!\.)\bimport\(\s*["']([^"'`]+)["']\s*\)/g]) {
  for (const match of source.matchAll(re)) {
    const spec = match[1];
    if (!spec || spec.startsWith('.') || spec.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(spec)) continue;
    if (spec.includes('${')) continue; // computed specifier — not a static dependency
    specifiers.add(spec);
  }
}

const missing = new Map(); // package → example specifiers
for (const spec of specifiers) {
  if (builtins.has(spec)) continue;
  const name = packageOf(spec);
  if (builtins.has(name) || declared.has(name) || OPTIONAL_ALLOWLIST.has(name)) continue;
  if (!missing.has(name)) missing.set(name, []);
  missing.get(name).push(spec);
}

const problems = [];
if (missing.size > 0) {
  problems.push('  Bundle requires packages that npm will NOT install:');
  for (const [name, specs] of [...missing].sort()) {
    problems.push(`    - ${name}   (e.g. ${specs.slice(0, 3).join(', ')})`);
  }
  problems.push('');
  problems.push('  Fix: if it is a NATIVE module, add it to BOTH tsup.config.ts `external`');
  problems.push('  and package.json `dependencies` (like better-sqlite3 / sharp). If it is');
  problems.push('  genuinely optional, add it to OPTIONAL_ALLOWLIST here with a reason.');
}

for (const [rel, blastRadius] of REQUIRED_ASSETS) {
  if (!existsSync(resolve(pkgRoot, rel))) {
    problems.push(`  Missing required runtime asset: ${rel}  → ${blastRadius}`);
  }
}

if (problems.length > 0) fail(problems);

console.log(
  `[check-bundle-deps] OK — ${specifiers.size} bare specifiers, all builtin/declared/allowlisted; ${REQUIRED_ASSETS.length} runtime assets present.`,
);
