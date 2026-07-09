/**
 * AssetStore — the single authority for agent/app/workflow-generated media.
 *
 * WHY: agents used to write generated media to whatever their process `cwd`
 * happened to be, and binary artifacts
 * were stored inline as base64 `data:` URLs in the DB. Both bloat without bound
 * and duplicate freely. This store fixes that with ONE content-addressed root:
 *
 *   {AGENTIS_ASSETS_DIR}/blobs/<hh>/<sha256>
 *
 * Identical bytes hash to the same path, so a blob is stored exactly once
 * (automatic dedup — the terabyte killer). Every `put` also registers an
 * `artifacts` row whose `content` is an `asset://<hash>` reference, so the asset
 * is visible in the Assets library, GC-able (ref-counted by artifact rows), and
 * downloadable via the blob route. The store root is configurable and defaults
 * OUTSIDE the source tree ({AGENTIS_DATA_DIR}/assets).
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArtifactType } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { ArtifactOrigin, ArtifactService, PersistedArtifact } from './artifactService.js';
import { assetRef, blobRelPath, inferArtifactType, mimeFromName, parseAssetRef } from './assetPaths.js';

export interface AssetPutInput {
  workspaceId: string;
  /** Raw bytes to store. Provide this OR `sourcePath`. */
  bytes?: Buffer;
  /** Absolute path to a file to import (streamed — safe for large media). */
  sourcePath?: string;
  /** Logical file name (download filename + metadata). */
  name: string;
  /** MIME type; inferred from `name` when omitted. */
  mime?: string;
  /** Display title (defaults to `name`). */
  title?: string;
  /** Artifact type; inferred from MIME when omitted. */
  type?: ArtifactType;
  origin?: ArtifactOrigin;
  userId?: string;
  agentId?: string | null;
  appId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  nodeId?: string | null;
  savedBy?: string;
  /** Extra provenance merged into the artifact metadata (e.g. brandCode). */
  metadataExtra?: Record<string, unknown>;
}

export interface StoredAsset extends PersistedArtifact {
  hash: string;
  size: number;
  mime: string;
  /** True when the blob already existed (dedup hit — no bytes written). */
  deduped: boolean;
}

export interface GcResult {
  scannedBlobs: number;
  removedBlobs: number;
  freedBytes: number;
}

export class AssetStore {
  constructor(
    private readonly assetsDir: string,
    private readonly artifacts: ArtifactService,
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  /** Absolute path to the content-addressed blob for a hash. */
  blobPath(hash: string): string {
    return path.join(this.assetsDir, blobRelPath(hash));
  }

  async exists(hash: string): Promise<boolean> {
    try {
      await fs.access(this.blobPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Store bytes/a file by content hash (dedup) and register an artifact row
   * that references the blob. Returns the artifact + storage details.
   */
  async put(input: AssetPutInput): Promise<StoredAsset> {
    const mime = input.mime ?? mimeFromName(input.name);
    const { hash, size, deduped } = input.bytes
      ? await this.#writeBytes(input.bytes)
      : await this.#writeFile(this.#requireSourcePath(input));

    const artifact = this.artifacts.persist({
      workspaceId: input.workspaceId,
      type: input.type ?? inferArtifactType(mime),
      title: input.title ?? input.name,
      name: input.name,
      content: assetRef(hash),
      userId: input.userId,
      agentId: input.agentId ?? null,
      appId: input.appId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      conversationId: input.conversationId ?? null,
      nodeId: input.nodeId ?? null,
      origin: input.origin,
      savedBy: input.savedBy,
      metadataExtra: { hash, mime, size, ...(input.metadataExtra ?? {}) },
    });

    return { ...artifact, hash, size, mime, deduped };
  }

  /** Read a blob's bytes by hash. */
  async read(hash: string): Promise<Buffer> {
    return fs.readFile(this.blobPath(hash));
  }

  /** A streamable read handle for the blob route (avoids buffering large media). */
  createReadStream(hash: string): NodeJS.ReadableStream {
    return createReadStream(this.blobPath(hash));
  }

  async stat(hash: string): Promise<{ size: number } | null> {
    try {
      const s = await fs.stat(this.blobPath(hash));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  /**
   * Delete blobs no artifact row references. Ref-count is the set of
   * `asset://<hash>` values across ALL artifacts (pinned rows are artifacts too,
   * so pinned assets are inherently retained). Content-addressing is global, so
   * a blob survives while ANY workspace still references it.
   *
   * A grace window skips freshly-written blobs so a `put` whose artifact row is
   * still being committed is never collected out from under itself.
   */
  async gc(opts: { graceMs?: number } = {}): Promise<GcResult> {
    const graceMs = opts.graceMs ?? 60 * 60 * 1000; // 1h default
    const cutoff = Date.now() - graceMs;
    const referenced = new Set<string>();
    for (const row of this.db.select({ content: schema.artifacts.content }).from(schema.artifacts).all()) {
      const hash = parseAssetRef(row.content);
      if (hash) referenced.add(hash);
    }

    const result: GcResult = { scannedBlobs: 0, removedBlobs: 0, freedBytes: 0 };
    const blobsRoot = path.join(this.assetsDir, 'blobs');
    let shards: string[];
    try {
      shards = await fs.readdir(blobsRoot);
    } catch {
      return result; // no blobs dir yet — nothing to collect
    }
    for (const shard of shards) {
      const shardDir = path.join(blobsRoot, shard);
      let entries: string[];
      try {
        entries = await fs.readdir(shardDir);
      } catch {
        continue;
      }
      for (const hash of entries) {
        result.scannedBlobs += 1;
        if (referenced.has(hash.toLowerCase())) continue;
        try {
          const s = await fs.stat(path.join(shardDir, hash));
          if (s.mtimeMs > cutoff) continue; // too new — may be mid-put
          await fs.rm(path.join(shardDir, hash));
          result.removedBlobs += 1;
          result.freedBytes += s.size;
        } catch (err) {
          this.logger.warn('assetStore.gc_remove_failed', { hash, message: (err as Error).message });
        }
      }
    }
    this.logger.info('assetStore.gc', { ...result });
    return result;
  }

  #requireSourcePath(input: AssetPutInput): string {
    if (!input.sourcePath) throw new Error('AssetStore.put requires either bytes or sourcePath');
    return input.sourcePath;
  }

  /** Hash + persist raw bytes, skipping the write when the blob already exists. */
  async #writeBytes(bytes: Buffer): Promise<{ hash: string; size: number; deduped: boolean }> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const abs = this.blobPath(hash);
    if (await this.exists(hash)) return { hash, size: bytes.byteLength, deduped: true };
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${randomUUID()}`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, abs);
    return { hash, size: bytes.byteLength, deduped: false };
  }

  /** Stream-hash a file, then copy it into the store only if new (dedup). */
  async #writeFile(sourcePath: string): Promise<{ hash: string; size: number; deduped: boolean }> {
    const hash = await hashFile(sourcePath);
    const size = (await fs.stat(sourcePath)).size;
    const abs = this.blobPath(hash);
    if (await this.exists(hash)) return { hash, size, deduped: true };
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${randomUUID()}`;
    await fs.copyFile(sourcePath, tmp);
    await fs.rename(tmp, abs);
    return { hash, size, deduped: false };
  }
}

/** sha256 a file by streaming it (constant memory, safe for large video). */
function hashFile(sourcePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(sourcePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
