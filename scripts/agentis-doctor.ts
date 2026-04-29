#!/usr/bin/env node
/**
 * agentis-doctor — preflight diagnostic for self-hosted Agentis.
 *
 * Run with `pnpm doctor` (or `tsx scripts/agentis-doctor.ts`). Exits 0 when
 * the host is fit to run `agentis up`, 1 otherwise. Each check is small and
 * additive — when something fails the operator gets a printable line that
 * names exactly what to fix, not a stack trace.
 *
 * Checks (V1-SPEC §2 host requirements):
 *   - Node ≥ 20.10
 *   - .agentis/ data dir exists or can be created
 *   - .agentis/secrets.json (when present) is mode 0600 with the expected keys
 *   - .agentis/agentis.db (when present) opens cleanly via better-sqlite3 and
 *     reports `integrity_check = ok` + journal_mode = wal
 *   - HTTP port 3737 (api) and 5173 (web dev) are free
 *   - better-sqlite3 native binary loads on this Node ABI
 */

import { existsSync, statSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';

// Resolve better-sqlite3 from the db package, not the root — that is the
// only workspace member that depends on it.
const requireFromDb = createRequire(
  resolve(process.cwd(), 'packages/db/package.json'),
);

type CheckResult = { name: string; ok: boolean; detail: string };

const DATA_DIR = resolve(process.env.AGENTIS_DATA_DIR ?? '.agentis');
const DB_FILE = join(DATA_DIR, 'agentis.db');
const SECRETS_FILE = join(DATA_DIR, 'secrets.json');

async function checkNode(): Promise<CheckResult> {
  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
  const ok = maj > 20 || (maj === 20 && min >= 10);
  return {
    name: 'Node ≥ 20.10',
    ok,
    detail: `found ${process.versions.node}`,
  };
}

async function checkDataDir(): Promise<CheckResult> {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    const st = statSync(DATA_DIR);
    return {
      name: 'data dir',
      ok: st.isDirectory(),
      detail: DATA_DIR,
    };
  } catch (err) {
    return { name: 'data dir', ok: false, detail: `cannot create ${DATA_DIR}: ${(err as Error).message}` };
  }
}

async function checkSecrets(): Promise<CheckResult> {
  if (!existsSync(SECRETS_FILE)) {
    return { name: 'secrets.json', ok: true, detail: 'not present yet (will be generated on first boot)' };
  }
  try {
    const st = statSync(SECRETS_FILE);
    // Permission check on POSIX only — Windows ACLs are evaluated separately
    // and the mode bits are not meaningful there.
    if (process.platform !== 'win32') {
      const mode = st.mode & 0o777;
      if (mode !== 0o600) {
        return {
          name: 'secrets.json',
          ok: false,
          detail: `mode is 0${mode.toString(8)} (expected 0600). Run: chmod 600 ${SECRETS_FILE}`,
        };
      }
    }
    const parsed = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
    const required = ['jwtPrivateKeyPem', 'jwtPublicKeyPem', 'credentialKeyB64'];
    const missing = required.filter((k) => !parsed[k]);
    if (missing.length > 0) {
      return { name: 'secrets.json', ok: false, detail: `missing keys: ${missing.join(', ')}` };
    }
    return { name: 'secrets.json', ok: true, detail: 'present, mode 0600, all keys present' };
  } catch (err) {
    return { name: 'secrets.json', ok: false, detail: `unreadable: ${(err as Error).message}` };
  }
}

async function checkSqlite(): Promise<CheckResult> {
  // Always probe better-sqlite3 itself — that is the most common failure
  // mode (native binary mismatch after Node upgrade).
  let Database: typeof import('better-sqlite3');
  try {
    Database = requireFromDb('better-sqlite3') as typeof import('better-sqlite3');
  } catch (err) {
    return {
      name: 'better-sqlite3',
      ok: false,
      detail: `native binary did not load: ${(err as Error).message}. Try: pnpm rebuild better-sqlite3`,
    };
  }
  if (!existsSync(DB_FILE)) {
    return { name: 'better-sqlite3', ok: true, detail: 'binary loads; db file not present yet' };
  }
  try {
    const db = new Database(DB_FILE, { readonly: true });
    const integrity = (db.pragma('integrity_check', { simple: true }) as string) ?? '';
    const journal = (db.pragma('journal_mode', { simple: true }) as string) ?? '';
    db.close();
    if (integrity !== 'ok') {
      return { name: 'agentis.db', ok: false, detail: `integrity_check returned: ${integrity}` };
    }
    if (journal.toLowerCase() !== 'wal') {
      return { name: 'agentis.db', ok: false, detail: `journal_mode is ${journal}, expected wal` };
    }
    return { name: 'agentis.db', ok: true, detail: 'integrity ok, WAL mode' };
  } catch (err) {
    return { name: 'agentis.db', ok: false, detail: `open failed: ${(err as Error).message}` };
  }
}

function checkPort(port: number, label: string): Promise<CheckResult> {
  return new Promise((resolveCheck) => {
    const srv = createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => {
      resolveCheck({
        name: `port ${port} (${label})`,
        ok: false,
        detail: err.code === 'EADDRINUSE' ? 'in use' : (err.message ?? 'unavailable'),
      });
    });
    srv.once('listening', () => {
      srv.close(() => resolveCheck({ name: `port ${port} (${label})`, ok: true, detail: 'free' }));
    });
    srv.listen(port, '127.0.0.1');
  });
}

async function main() {
  const results: CheckResult[] = [];
  results.push(await checkNode());
  results.push(await checkDataDir());
  results.push(await checkSecrets());
  results.push(await checkSqlite());
  results.push(await checkPort(3737, 'api'));
  results.push(await checkPort(5173, 'web'));

  const width = Math.max(...results.map((r) => r.name.length));
  let failed = 0;
  for (const r of results) {
    const status = r.ok ? 'OK  ' : 'FAIL';
    if (!r.ok) failed++;
    process.stdout.write(`  [${status}] ${r.name.padEnd(width)}  ${r.detail}\n`);
  }
  process.stdout.write(`\n${failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`agentis-doctor crashed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(2);
});
