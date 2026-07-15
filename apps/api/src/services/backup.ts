/**
 * Backup / restore service (Batch 8 / D38).
 *
 * Produces a single-directory snapshot of an Agentis data dir that contains
 * everything an operator needs to recreate the install on a fresh host.
 *
 * Design choices:
 *   - Use the SQLite online backup API (`Database.backup(dest)`) so we get a
 *     consistent, single-file snapshot even while the server is running. WAL
 *     and SHM siblings are not part of the snapshot — the destination DB is
 *     a clean checkpointed file that opens without them.
 *   - Copy `secrets.json` verbatim and re-apply 0o600 perms on the
 *     destination (Windows silently ignores the chmod just like the live
 *     install does).
 *   - Emit a `manifest.json` so `restore` can refuse to operate on a random
 *     directory and so future format changes have a version handle.
 *   - Output is a directory, not a tar archive. Operators can `tar -czf` the
 *     directory themselves; keeping the artifact uncompressed avoids adding
 *     a tar dependency to the CLI and makes ad-hoc inspection trivial.
 */

import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { openSqlite } from '@agentis/db/sqlite';

export interface BackupOptions {
  /** Source data directory (typically `AGENTIS_DATA_DIR`, default `.agentis`). */
  dataDir: string;
  /** Destination directory. Created if missing. */
  outDir: string;
}

export interface RestoreOptions {
  /** A directory previously produced by `createBackup`. */
  backupDir: string;
  /** Target data directory (typically `AGENTIS_DATA_DIR`). */
  dataDir: string;
  /** Allow overwriting an existing data.db. Default: false. */
  force?: boolean;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  source: string;
  files: string[];
  notes: string;
}

export interface BackupResult {
  outDir: string;
  files: string[];
  manifestPath: string;
}

export interface RestoreResult {
  dataDir: string;
  files: string[];
}

const MANIFEST_NAME = 'manifest.json';
const DB_NAME = 'data.db';
const SECRETS_NAME = 'secrets.json';
const WAL_SIBLINGS = [`${DB_NAME}-wal`, `${DB_NAME}-shm`];

/**
 * Snapshot a live Agentis data directory into `outDir`.
 *
 * Throws if the source DB is missing. Safe to call against a running api
 * because better-sqlite3's online backup API holds a brief read lock only.
 */
export async function createBackup(opts: BackupOptions): Promise<BackupResult> {
  const dataDir = resolve(opts.dataDir);
  const outDir = resolve(opts.outDir);

  const dbSrc = join(dataDir, DB_NAME);
  if (!existsSync(dbSrc)) {
    throw new Error(`No SQLite database at ${dbSrc} — nothing to back up.`);
  }

  mkdirSync(outDir, { recursive: true });

  // Fail before the online backup starts writing. A partial SQLite copy on a
  // nearly-full volume is worse than a clear refusal, and may consume the last
  // space the live database needs to commit.
  const sourceBytes = statSync(dbSrc).size + (existsSync(join(dataDir, SECRETS_NAME)) ? statSync(join(dataDir, SECRETS_NAME)).size : 0);
  const volume = statfsSync(outDir);
  const freeBytes = Number(volume.bavail) * Number(volume.bsize);
  const requiredBytes = Math.ceil(sourceBytes * 1.1) + 64 * 1024 * 1024;
  if (freeBytes < requiredBytes) {
    throw new Error(
      `Backup requires at least ${formatBytes(requiredBytes)} free at ${outDir}; only ${formatBytes(freeBytes)} is available. Choose another destination.`,
    );
  }

  // Online backup: produces a checkpointed snapshot in one call. WAL siblings
  // do not need to be copied — the destination opens cleanly on its own.
  // Open via @agentis/db with migrate:false so we do not mutate the source.
  const { sqlite } = openSqlite({ path: dbSrc, migrate: false });
  try {
    await sqlite.backup(join(outDir, DB_NAME));
  } finally {
    sqlite.close();
  }

  const files: string[] = [DB_NAME];

  const secretsSrc = join(dataDir, SECRETS_NAME);
  if (existsSync(secretsSrc)) {
    const secretsDst = join(outDir, SECRETS_NAME);
    copyFileSync(secretsSrc, secretsDst);
    try {
      chmodSync(secretsDst, 0o600);
    } catch {
      // Windows silently no-ops chmod; matches the live install behaviour.
    }
    files.push(SECRETS_NAME);
  }

  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: dataDir,
    files,
    notes: 'Created by `agentis backup`. Restore with `agentis restore <dir>`.',
  };
  const manifestPath = join(outDir, MANIFEST_NAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return { outDir, files, manifestPath };
}

/**
 * Restore a backup directory into a target data dir.
 *
 * Refuses to overwrite an existing `data.db` unless `force=true`. Removes
 * stale WAL/SHM siblings so the restored DB opens cleanly on the next boot.
 */
export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const backupDir = resolve(opts.backupDir);
  const dataDir = resolve(opts.dataDir);

  const manifestPath = join(backupDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Not an Agentis backup directory: ${backupDir} (missing ${MANIFEST_NAME}).`,
    );
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  } catch (err) {
    throw new Error(
      `Corrupt manifest at ${manifestPath}: ${(err as Error).message}`,
    );
  }
  if (manifest.version !== 1) {
    throw new Error(
      `Unsupported backup format version ${String(manifest.version)}; this build understands version 1.`,
    );
  }

  const dbDst = join(dataDir, DB_NAME);
  if (existsSync(dbDst) && !opts.force) {
    throw new Error(
      `${dbDst} already exists. Re-run with --force to overwrite the existing data directory.`,
    );
  }

  mkdirSync(dataDir, { recursive: true });

  // Stale WAL siblings + an old data.db would shadow the restore. Wipe them
  // so the restored snapshot is the only handle on next boot.
  for (const sibling of WAL_SIBLINGS) {
    const p = join(dataDir, sibling);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  if (existsSync(dbDst)) rmSync(dbDst, { force: true });

  const restored: string[] = [];
  for (const file of manifest.files) {
    assertRestorableFile(file);
    const src = join(backupDir, file);
    if (!existsSync(src)) {
      throw new Error(
        `Backup is incomplete: manifest lists ${file} but ${src} is missing.`,
      );
    }
    const dst = join(dataDir, file);
    copyFileSync(src, dst);
    if (file === SECRETS_NAME) {
      try {
        chmodSync(dst, 0o600);
      } catch {
        // Windows: see createBackup for context.
      }
    }
    restored.push(file);
  }

  return { dataDir, files: restored };
}

function assertRestorableFile(file: string): void {
  const allowed = file === DB_NAME || file === SECRETS_NAME;
  if (!allowed || isAbsolute(file) || file !== basename(file)) {
    throw new Error(`Unsafe backup manifest file entry: ${file}`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.ceil(bytes / 1024)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
