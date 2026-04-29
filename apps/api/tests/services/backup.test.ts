/**
 * Backup / restore service tests (D38 / Batch 8).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite } from '@agentis/db/sqlite';
import { createBackup, restoreBackup, type BackupManifest } from '../../src/services/backup.js';

function makeSourceDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentis-backup-src-'));
  // Seed a small SQLite DB with one table + row so we can verify the backup
  // is not just an empty file. Use openSqlite so the better-sqlite3 binary
  // is resolved through the same dep graph as the production code path.
  const dbPath = join(dir, 'data.db');
  const { sqlite } = openSqlite({ path: dbPath, migrate: false });
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  sqlite.prepare('INSERT INTO t (id, value) VALUES (?, ?)').run(1, 'hello');
  sqlite.close();
  // Seed a secrets.json so we cover the secrets-copy path too.
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ jwtPrivateKeyPem: 'X', jwtPublicKeyPem: 'Y', credentialKeyB64: 'Z' }), 'utf8');
  return dir;
}

describe('backup service', () => {
  let src: string;
  let out: string;
  let restoreTarget: string;

  beforeEach(() => {
    src = makeSourceDataDir();
    out = mkdtempSync(join(tmpdir(), 'agentis-backup-out-'));
    restoreTarget = mkdtempSync(join(tmpdir(), 'agentis-backup-restore-'));
    // Empty restoreTarget so existsSync(data.db) is false on first restore.
    rmSync(restoreTarget, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const d of [src, out, restoreTarget]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('writes data.db, secrets.json, and manifest.json into the out dir', async () => {
    const result = await createBackup({ dataDir: src, outDir: out });

    expect(result.files).toEqual(['data.db', 'secrets.json']);
    expect(existsSync(join(out, 'data.db'))).toBe(true);
    expect(existsSync(join(out, 'secrets.json'))).toBe(true);
    expect(existsSync(join(out, 'manifest.json'))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as BackupManifest;
    expect(manifest.version).toBe(1);
    expect(manifest.files).toEqual(['data.db', 'secrets.json']);
    expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('produces a snapshot DB whose row data matches the source', async () => {
    await createBackup({ dataDir: src, outDir: out });
    const { sqlite: snap } = openSqlite({ path: join(out, 'data.db'), migrate: false });
    try {
      const rows = snap.prepare('SELECT id, value FROM t').all();
      expect(rows).toEqual([{ id: 1, value: 'hello' }]);
    } finally {
      snap.close();
    }
  });

  it('omits secrets.json from the backup when it is missing in the source', async () => {
    rmSync(join(src, 'secrets.json'), { force: true });
    const result = await createBackup({ dataDir: src, outDir: out });
    expect(result.files).toEqual(['data.db']);
    expect(existsSync(join(out, 'secrets.json'))).toBe(false);
  });

  it('throws when the source has no database', async () => {
    rmSync(join(src, 'data.db'), { force: true });
    await expect(createBackup({ dataDir: src, outDir: out })).rejects.toThrow(/No SQLite database/);
  });

  it('round-trips: backup then restore reproduces the row data', async () => {
    await createBackup({ dataDir: src, outDir: out });
    const result = await restoreBackup({ backupDir: out, dataDir: restoreTarget });

    expect(result.files).toEqual(['data.db', 'secrets.json']);
    expect(existsSync(join(restoreTarget, 'data.db'))).toBe(true);
    expect(existsSync(join(restoreTarget, 'secrets.json'))).toBe(true);

    const { sqlite: restored } = openSqlite({ path: join(restoreTarget, 'data.db'), migrate: false });
    try {
      const rows = restored.prepare('SELECT id, value FROM t').all();
      expect(rows).toEqual([{ id: 1, value: 'hello' }]);
    } finally {
      restored.close();
    }
  });

  it('refuses to overwrite an existing data.db without --force', async () => {
    await createBackup({ dataDir: src, outDir: out });
    mkdirSync(restoreTarget, { recursive: true });
    writeFileSync(join(restoreTarget, 'data.db'), 'pre-existing');

    await expect(restoreBackup({ backupDir: out, dataDir: restoreTarget })).rejects.toThrow(/already exists/);
  });

  it('overwrites with --force and wipes stale WAL siblings', async () => {
    await createBackup({ dataDir: src, outDir: out });
    mkdirSync(restoreTarget, { recursive: true });
    writeFileSync(join(restoreTarget, 'data.db'), 'pre-existing');
    writeFileSync(join(restoreTarget, 'data.db-wal'), 'stale-wal');
    writeFileSync(join(restoreTarget, 'data.db-shm'), 'stale-shm');

    await restoreBackup({ backupDir: out, dataDir: restoreTarget, force: true });

    expect(existsSync(join(restoreTarget, 'data.db-wal'))).toBe(false);
    expect(existsSync(join(restoreTarget, 'data.db-shm'))).toBe(false);
    const { sqlite: restored } = openSqlite({ path: join(restoreTarget, 'data.db'), migrate: false });
    try {
      expect(restored.prepare('SELECT count(*) as n FROM t').get()).toEqual({ n: 1 });
    } finally {
      restored.close();
    }
  });

  it('rejects a directory without manifest.json', async () => {
    await expect(restoreBackup({ backupDir: out, dataDir: restoreTarget })).rejects.toThrow(/missing manifest\.json/);
  });

  it('rejects a manifest with an unknown version', async () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'manifest.json'), JSON.stringify({ version: 99, files: [] }));
    await expect(restoreBackup({ backupDir: out, dataDir: restoreTarget })).rejects.toThrow(/Unsupported backup format/);
  });

  it('rejects a backup whose listed files are missing on disk', async () => {
    mkdirSync(out, { recursive: true });
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: src,
      files: ['data.db'],
      notes: '',
    };
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
    // data.db intentionally not written.
    await expect(restoreBackup({ backupDir: out, dataDir: restoreTarget })).rejects.toThrow(/Backup is incomplete/);
  });

  it('applies 0o600 to the restored secrets.json on POSIX (skipped on Windows)', async () => {
    await createBackup({ dataDir: src, outDir: out });
    await restoreBackup({ backupDir: out, dataDir: restoreTarget });
    if (process.platform === 'win32') return;
    const mode = statSync(join(restoreTarget, 'secrets.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
