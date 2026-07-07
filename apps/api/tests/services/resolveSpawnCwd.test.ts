/**
 * resolveSpawnCwd — self-heals a spawn working directory that has gone missing.
 *
 * On Windows, `child_process.spawn(cmd, args, { cwd })` throws a MISLEADING
 * `Error: spawn <cmd> ENOENT` when `cwd` does not exist — it names the command,
 * not the absent directory, so a present, working binary looks "missing" and the
 * runtime looks "unavailable". Agent harness cwds (managed homes, project
 * checkouts) can vanish after an adapter is registered, so we re-validate/re-create
 * the cwd on every spawn. These tests pin that contract AND reproduce the raw
 * failure to prove the resolver prevents it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSpawnCwd } from '../../src/services/pathExpander.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'spawncwd-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveSpawnCwd', () => {
  it('returns undefined for empty/undefined (inherit the parent process cwd)', () => {
    expect(resolveSpawnCwd(undefined)).toBeUndefined();
    expect(resolveSpawnCwd(null)).toBeUndefined();
    expect(resolveSpawnCwd('   ')).toBeUndefined();
  });

  it('returns an existing directory unchanged', () => {
    expect(resolveSpawnCwd(root)).toBe(root);
  });

  it('re-creates a missing directory when create:true', () => {
    const gone = path.join(root, 'managed', 'home', 'agent-123');
    expect(existsSync(gone)).toBe(false);
    expect(resolveSpawnCwd(gone, { create: true })).toBe(gone);
    expect(statSync(gone).isDirectory()).toBe(true);
  });

  it('falls back to the nearest existing ancestor when missing and create:false', () => {
    const gone = path.join(root, 'a', 'b', 'c');
    expect(resolveSpawnCwd(gone)).toBe(root);
    expect(existsSync(gone)).toBe(false); // did NOT create it
  });

  it('never returns a non-directory: a file path degrades to its nearest existing dir', () => {
    const file = path.join(root, 'not-a-dir.txt');
    writeFileSync(file, 'x');
    // The path itself is a file → not usable as a cwd.
    expect(resolveSpawnCwd(file)).toBe(root);
    // A path *under* a file can't be created (ENOTDIR) → degrade, don't throw.
    const underFile = path.join(file, 'sub');
    expect(resolveSpawnCwd(underFile, { create: true })).toBe(root);
  });

  // The whole point: reproduce the platform failure, then prove the fix.
  it('prevents the misleading `spawn <binary> ENOENT` a missing cwd causes', () => {
    const missing = path.join(root, 'vanished', 'workdir');

    // 1) Raw missing cwd → spawn fails with ENOENT (blaming the command).
    const raw = spawnSync(process.execPath, ['--version'], { cwd: missing, windowsHide: true });
    expect(raw.error?.code).toBe('ENOENT');

    // 2) Same spawn through the resolved cwd → succeeds.
    const safe = resolveSpawnCwd(missing, { create: true });
    const healed = spawnSync(process.execPath, ['--version'], { cwd: safe, windowsHide: true });
    expect(healed.error).toBeUndefined();
    expect(healed.status).toBe(0);
    expect(String(healed.stdout)).toContain(process.version);
  });
});
