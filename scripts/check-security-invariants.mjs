#!/usr/bin/env node
/**
 * Dependency-free security-invariant checker (pre-launch security DNA).
 *
 * Locks in the hardening from docs/PRE-LAUNCH-SECURITY-AUDIT.md so a future edit
 * cannot silently regress a defense. No plugins to install — `pnpm lint` runs it.
 *
 * Invariants:
 *   S1  Untrusted-network paths (agent/extension-reachable fetches) must go
 *       through `safeFetch`, never global `fetch(`. Global fetch re-resolves DNS
 *       and auto-follows redirects without re-checking — both are SSRF/rebinding
 *       vectors that `safeFetch` closes by pinning the validated IP.
 *   S2  `withExpandedPath` (the single chokepoint every child-process spawn env
 *       funnels through) must strip Agentis secrets via `redactSensitiveEnv`, so
 *       a prompt-injected agent CLI can't inherit and exfiltrate them.
 *   S3  `safeFetch` must re-validate every redirect hop (resolveSafeTarget inside
 *       the redirect loop) — a single up-front check is not enough.
 *
 * Usage: node scripts/check-security-invariants.mjs
 * Exit 1 on any violation.
 */
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
};

// Files that handle URLs an agent or extension can influence. They must use
// safeFetch — a bare global `fetch(` here is a DNS-rebinding SSRF regression.
const UNTRUSTED_NETWORK_FILES = [
  'apps/api/src/extensions/vmRuntime.ts',
  'apps/api/src/extensions/nodeWorkerRuntime.ts',
  'apps/api/src/services/builtinExtensions.ts',
  'apps/api/src/services/agent/agentToolRuntime.ts',
  'apps/api/src/services/artifactService.ts',
];

// Matches a call to global `fetch(` but not `safeFetch(`, `x.fetch(`, or the word
// inside an identifier — the char before `fetch` must be a non-identifier, non-dot.
const BARE_FETCH_RE = /(^|[^.\w])fetch\s*\(/;

const violations = [];

// S1 ─ untrusted paths must not call global fetch.
for (const rel of UNTRUSTED_NETWORK_FILES) {
  const src = read(rel);
  if (src == null) {
    violations.push({ id: 'S1', file: rel, msg: 'expected untrusted-network file is missing (audit drift)' });
    continue;
  }
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (BARE_FETCH_RE.test(code)) {
      violations.push({
        id: 'S1',
        file: `${rel}:${i + 1}`,
        msg: 'uses global fetch() on an agent/extension-reachable path — use safeFetch (SSRF/DNS-rebinding pin)',
      });
    }
  });
}

// S2 ─ the spawn-env chokepoint must redact secrets.
const pathExpander = read('apps/api/src/services/pathExpander.ts');
if (pathExpander == null) {
  violations.push({ id: 'S2', file: 'apps/api/src/services/pathExpander.ts', msg: 'file missing' });
} else {
  const m = /export function withExpandedPath\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(pathExpander);
  const body = m ? m[1] : '';
  if (!/redactSensitiveEnv\s*\(/.test(body)) {
    violations.push({
      id: 'S2',
      file: 'apps/api/src/services/pathExpander.ts',
      msg: 'withExpandedPath no longer calls redactSensitiveEnv — child processes could inherit Agentis secrets',
    });
  }
}

// S3 ─ safeFetch must re-validate every redirect hop.
const safeFetch = read('apps/api/src/services/safeFetch.ts');
if (safeFetch == null) {
  violations.push({ id: 'S3', file: 'apps/api/src/services/safeFetch.ts', msg: 'file missing' });
} else if (!/resolveSafeTarget/.test(safeFetch) || !/redirect/i.test(safeFetch)) {
  violations.push({
    id: 'S3',
    file: 'apps/api/src/services/safeFetch.ts',
    msg: 'safeFetch must re-validate each redirect hop via resolveSafeTarget',
  });
}

// S4 ─ the logger must apply secret redaction before emitting.
const logger = read('apps/api/src/logger.ts');
if (logger == null) {
  violations.push({ id: 'S4', file: 'apps/api/src/logger.ts', msg: 'file missing' });
} else if (!/redactForLogging\s*\(/.test(logger) || !/redactSecretString\s*\(/.test(logger)) {
  violations.push({
    id: 'S4',
    file: 'apps/api/src/logger.ts',
    msg: 'logger.emit no longer redacts secrets — a leaked key could reach stdout/DB',
  });
}

// S5 ─ the chat executor must run the IPI taint/quarantine gate on tool results.
const chatExec = read('apps/api/src/services/chat/chatSessionExecutor.ts');
if (chatExec == null) {
  violations.push({ id: 'S5', file: 'apps/api/src/services/chat/chatSessionExecutor.ts', msg: 'file missing' });
} else if (!/scanForInjection\s*\(/.test(chatExec) || !/turnTainted/.test(chatExec) || !/isHighImpact\s*\(/.test(chatExec)) {
  violations.push({
    id: 'S5',
    file: 'apps/api/src/services/chat/chatSessionExecutor.ts',
    msg: 'IPI gate removed — tool results must be scanned and high-impact tools escalated on taint',
  });
}

if (violations.length === 0) {
  console.log(`✓ security-invariants: ${UNTRUSTED_NETWORK_FILES.length + 4} checks passed, 0 violations`);
  process.exit(0);
}
console.error(`✗ security-invariants: ${violations.length} violation(s):\n`);
for (const v of violations) {
  console.error(`  [${v.id}] ${v.file}\n        → ${v.msg}\n`);
}
process.exit(1);
