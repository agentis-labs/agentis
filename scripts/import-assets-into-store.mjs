#!/usr/bin/env node
/**
 * import-assets-into-store — migrate scattered/generated media into the
 * content-addressed asset store and register them in the Assets library.
 *
 * WHY: before the asset store existed, agents wrote generated media into the
 * source tree (`apps/api/brand-assets/`) and the store-factory wrote to an
 * external `AGENTIS_STORES_DIR`. This one-off collapses those into the store by
 * content hash (dedup) and inserts an `artifacts` row per file so they show up
 * in the Assets library instead of rotting on disk.
 *
 * Safe by default: DRY RUN unless `--apply` is passed. Nothing is written and no
 * source files are deleted — it only COPIES uniques into the store.
 *
 * Usage (from repo root):
 *   node scripts/import-assets-into-store.mjs [sourceDir ...] [--apply] [--workspace <id>]
 *
 * Defaults: sources = apps/api/brand-assets + $AGENTIS_STORES_DIR (if set);
 *           workspace = the first workspace in the DB.
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repoRoot, 'apps', 'api', 'package.json'));
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const wsFlagIdx = args.indexOf('--workspace');
const workspaceArg = wsFlagIdx >= 0 ? args[wsFlagIdx + 1] : null;
const sourceArgs = args.filter((a, i) => !a.startsWith('--') && i !== (wsFlagIdx + 1));

const dataDir = process.env.AGENTIS_DATA_DIR || path.join(repoRoot, 'apps', 'api', '.agentis');
const assetsDir = process.env.AGENTIS_ASSETS_DIR || path.join(dataDir, 'assets');
const dbPath = path.join(dataDir, 'data.db');

const MEDIA_EXT = new Set(['.mp4', '.mov', '.webm', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp3', '.wav', '.pdf']);
const EXT_MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
};
function inferType(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'document';
}
function blobRel(hash) { return path.join('blobs', hash.slice(0, 2), hash); }
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}
async function* walk(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (MEDIA_EXT.has(path.extname(e.name).toLowerCase())) yield full;
  }
}
function brandCodeFor(file, root) {
  // First path segment under the source root is treated as the brand folder.
  const rel = path.relative(root, file).split(path.sep);
  return rel.length > 1 ? rel[0] : null;
}
const fmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

async function main() {
  const sources = (sourceArgs.length ? sourceArgs : [
    path.join(repoRoot, 'apps', 'api', 'brand-assets'),
    process.env.AGENTIS_STORES_DIR ? path.join(process.env.AGENTIS_STORES_DIR, 'assets') : null,
  ].filter(Boolean)).filter((d) => existsSync(d));

  if (sources.length === 0) {
    console.error('No source directories found. Pass one or more paths, e.g.:');
    console.error('  node scripts/import-assets-into-store.mjs apps/api/brand-assets');
    process.exit(1);
  }
  if (!existsSync(dbPath)) { console.error(`DB not found at ${dbPath}`); process.exit(1); }

  const db = new Database(dbPath);
  db.pragma('busy_timeout = 8000'); // the live API may hold the DB — wait, don't fail
  const ws = workspaceArg
    ? db.prepare('SELECT id, user_id FROM workspaces WHERE id = ?').get(workspaceArg)
    : db.prepare('SELECT id, user_id FROM workspaces ORDER BY created_at LIMIT 1').get();
  if (!ws) { console.error('No workspace found; pass --workspace <id>.'); process.exit(1); }

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — store=${assetsDir}  workspace=${ws.id}`);
  console.log(`Sources:\n${sources.map((s) => `  ${s}`).join('\n')}\n`);

  const seen = new Map(); // hash -> { size }
  let files = 0, sourceBytes = 0, storedBytes = 0, dedupHits = 0, inserted = 0;
  const insert = db.prepare(`INSERT INTO artifacts
    (id, workspace_id, user_id, origin, type, title, content, thumbnail_url, metadata, pinned, created_at, updated_at)
    VALUES (@id, @workspace_id, @user_id, 'workflow', @type, @title, @content, NULL, @metadata, 0, @now, @now)`);

  for (const root of sources) {
    for await (const file of walk(root)) {
      files += 1;
      const size = statSync(file).size;
      sourceBytes += size;
      const hash = await hashFile(file);
      const mime = EXT_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const abs = path.join(assetsDir, blobRel(hash));
      const already = seen.has(hash) || existsSync(abs);
      if (already) { dedupHits += 1; } else { storedBytes += size; seen.set(hash, { size }); }

      if (apply) {
        if (!existsSync(abs)) {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.copyFile(file, abs);
        }
        insert.run({
          id: randomUUID(), workspace_id: ws.id, user_id: ws.user_id,
          type: inferType(mime), title: path.basename(file), content: `asset://${hash}`,
          metadata: JSON.stringify({ name: path.basename(file), hash, mime, size, brandCode: brandCodeFor(file, root), importedFrom: file, savedBy: 'migration' }),
          now: new Date().toISOString(),
        });
        inserted += 1;
      }
    }
  }

  console.log('— Summary —');
  console.log(`  files scanned:   ${files}`);
  console.log(`  unique blobs:    ${seen.size}`);
  console.log(`  dedup hits:      ${dedupHits}`);
  console.log(`  source bytes:    ${fmt(sourceBytes)}`);
  console.log(`  stored (unique): ${fmt(storedBytes)}`);
  console.log(`  saved by dedup:  ${fmt(sourceBytes - storedBytes)}`);
  if (apply) console.log(`  artifacts added: ${inserted}`);
  else console.log('\n(DRY RUN — re-run with --apply to copy blobs + register artifacts.)');
  db.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
