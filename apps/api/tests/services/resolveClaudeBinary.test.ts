/**
 * resolveClaudeBinary — self-heals a stale Claude-Desktop version pin.
 *
 * Claude Desktop rotates <base>/Claude/claude-code/<version>/claude.exe on
 * auto-update, so a pinned version 404s (`spawn … claude.exe ENOENT`). The
 * resolver re-points a managed path to the NEWEST installed version, or falls
 * back to `claude` on PATH.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveClaudeBinary } from '../../src/services/pathExpander.js';

const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';

let root: string;
let base: string; // <root>/Claude/claude-code

function version(v: string): string {
  const dir = path.join(base, v);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, EXE), '');
  return path.join(dir, EXE);
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'claudebin-'));
  base = path.join(root, 'Claude', 'claude-code');
  version('2.1.9');
  version('2.1.10');
  version('2.1.100'); // newest — numeric compare, not lexical
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('resolveClaudeBinary', () => {
  it('repoints a pinned managed version to the NEWEST installed one (numeric, not lexical)', () => {
    const pinnedOld = path.join(base, '2.1.9', EXE);
    expect(resolveClaudeBinary(pinnedOld)).toBe(path.join(base, '2.1.100', EXE));
  });

  it('heals a pin to a version that no longer exists → newest installed', () => {
    const gone = path.join(base, '2.1.999', EXE);
    expect(resolveClaudeBinary(gone)).toBe(path.join(base, '2.1.100', EXE));
  });

  it('falls back to `claude` (PATH) when the whole managed dir is gone', () => {
    const orphan = path.join(root, 'Nowhere', 'claude-code', '2.1.1', EXE);
    expect(resolveClaudeBinary(orphan)).toBe('claude');
  });

  it('passes a non-managed custom path through unchanged (never overrides a deliberate binary)', () => {
    const real = path.join(base, '2.1.10', EXE); // a managed path → still self-heals to newest
    const plain = path.join(root, 'custom', 'claude');
    mkdirSync(path.dirname(plain), { recursive: true });
    writeFileSync(plain, '');
    expect(resolveClaudeBinary(plain)).toBe(plain);
    // A non-managed path is passed through as-is (even if missing) — resolveSpawnTarget handles it.
    const missing = path.join(root, 'custom', 'missing');
    expect(resolveClaudeBinary(missing)).toBe(missing);
    // sanity: the managed path still resolves to the newest installed version.
    expect(resolveClaudeBinary(real)).toBe(path.join(base, '2.1.100', EXE));
  });

  it('returns `claude` for empty/undefined config', () => {
    expect(resolveClaudeBinary(undefined)).toBe('claude');
    expect(resolveClaudeBinary(null)).toBe('claude');
    expect(resolveClaudeBinary('   ')).toBe('claude');
  });
});
