#!/usr/bin/env node
/**
 * Dependency-free architectural boundary checker (pre-launch modularity DNA).
 *
 * Enforces the layering rules from docs/PRE-LAUNCH-ARCHITECTURAL-AUDIT.md so a
 * violation fails CI instead of slipping through review. No ESLint/plugins to
 * install — a fresh OSS fork runs `pnpm lint` and the rules just work.
 *
 * Rules (each encodes a boundary that must hold; add more as domains land):
 *   R1  packages/** must NOT import apps/** (the clean inward-only package layer).
 *       Exempt: packages/cli — the documented embedder/launcher that boots the api.
 *   R2  Nothing may import apps/api/src/routes/** except route files themselves and
 *       the composition root (routes are the top layer — HTTP edges, never a dep).
 *   R3  Lower layers (engine/adapters/services/grounding/extensions/middleware)
 *       must NOT import from ../routes (same invariant, stated from the source).
 *   R4  apps/web/** must NOT deep-import apps/api source (only shared packages).
 *
 * Test files (any tests/ directory, or a .test / .spec suffix) are exempt: a test
 * legitimately imports the unit it exercises. Boundary rules govern src only.
 *
 * Usage: node scripts/check-boundaries.mjs [--json]
 * Exit 1 on any violation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asPosix = (p) => p.split(sep).join('/');

/** Recursively collect .ts/.tsx files under a dir, skipping build/vendor dirs. */
function collect(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' ||
        e.name === '.agentis' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Extract import/export/dynamic-import specifiers (string literals only). */
const SPEC_RE = /(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
function specifiers(src) {
  const out = [];
  let m;
  while ((m = SPEC_RE.exec(src)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

/** Resolve a relative specifier to a repo-relative posix path (best-effort). */
function resolveRel(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  return asPosix(relative(ROOT, resolve(dirname(fromFile), spec)));
}

// The composition root wires everything together, so it is allowed to reach
// across layers (it mounts routes, constructs services, boots the engine).
const COMPOSITION_ROOT = new Set([
  'apps/api/src/bootstrap.ts',
  'apps/api/src/httpServer.ts',
  'apps/api/src/index.ts',
]);

const rules = [
  {
    id: 'R1',
    msg: 'packages/** must not import apps/** (packages are the inward-only shared layer)',
    test(relFile, spec, resolved) {
      if (!relFile.startsWith('packages/')) return false;
      if (relFile.startsWith('packages/cli/')) return false; // documented embedder/launcher
      if (spec === '@agentis/api' || spec.startsWith('@agentis/api/') ||
          spec === '@agentis/web' || spec.startsWith('@agentis/web/')) return true;
      return resolved != null && resolved.startsWith('apps/');
    },
  },
  {
    id: 'R2/R3',
    msg: 'only route files or the composition root may import apps/api/src/routes/** (routes are the top HTTP layer)',
    test(relFile, spec, resolved) {
      if (resolved == null) return false;
      if (COMPOSITION_ROOT.has(relFile) || relFile.startsWith('apps/api/src/bootstrap/')) return false;
      const targetsRoutes = resolved.startsWith('apps/api/src/routes/');
      const isRouteFile = relFile.startsWith('apps/api/src/routes/');
      return targetsRoutes && !isRouteFile;
    },
  },
  {
    id: 'R4',
    msg: 'apps/web/** must not deep-import apps/api source (use shared @agentis/* packages)',
    test(relFile, spec, resolved) {
      if (!relFile.startsWith('apps/web/')) return false;
      return (resolved != null && resolved.startsWith('apps/api/')) ||
             spec === '@agentis/api' || spec.startsWith('@agentis/api/');
    },
  },
];

const files = [...collect(join(ROOT, 'apps')), ...collect(join(ROOT, 'packages'))];
const violations = [];
const isTest = (p) => /(^|\/)tests?\//.test(p) || /\.(test|spec)\.(ts|tsx)$/.test(p);
for (const file of files) {
  const relFile = asPosix(relative(ROOT, file));
  if (isTest(relFile)) continue; // tests may import the unit under test
  let src;
  try { src = readFileSync(file, 'utf8'); } catch { continue; }
  for (const spec of specifiers(src)) {
    const resolved = resolveRel(file, spec);
    for (const rule of rules) {
      if (rule.test(relFile, spec, resolved)) {
        violations.push({ rule: rule.id, file: relFile, spec, msg: rule.msg });
      }
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(violations, null, 2));
} else if (violations.length === 0) {
  console.log(`✓ boundaries: ${files.length} files scanned, 0 violations`);
} else {
  console.error(`✗ boundaries: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}\n        imports "${v.spec}"\n        → ${v.msg}\n`);
  }
}
process.exit(violations.length === 0 ? 0 : 1);
