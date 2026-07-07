/**
 * Pure helpers shared by the AssetStore and the ArtifactService.
 *
 * Kept dependency-free (no db, no fs I/O beyond path math) so both the store
 * (which writes blobs) and the artifact service (which resolves `asset://`
 * references back to bytes) can import them without a module cycle.
 */

import type { ArtifactType } from '@agentis/core';

/** Content-addressed reference scheme stored in `artifacts.content`. */
export const ASSET_REF_PREFIX = 'asset://';

/** Build the `asset://<sha256>` reference for a stored blob. */
export function assetRef(hash: string): string {
  return `${ASSET_REF_PREFIX}${hash}`;
}

/** Extract the sha256 hash from an `asset://<hash>` reference, or null. */
export function parseAssetRef(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(ASSET_REF_PREFIX)) return null;
  const hash = value.slice(ASSET_REF_PREFIX.length).trim();
  return /^[a-f0-9]{64}$/i.test(hash) ? hash.toLowerCase() : null;
}

/**
 * On-disk location of a blob relative to the assets dir, sharded by the first
 * two hex chars so a directory never holds millions of entries. Pure function —
 * the AssetStore and any GC/migration tool derive the same path from a hash.
 */
export function blobRelPath(hash: string): string {
  const clean = hash.toLowerCase();
  return `blobs/${clean.slice(0, 2)}/${clean}`;
}

/** Map a MIME type to the coarse ArtifactType used by the Assets library. */
export function inferArtifactType(mime: string | null | undefined): ArtifactType {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'text/html') return 'html';
  if (m === 'application/json' || m === 'text/csv' || m === 'application/x-ndjson') return 'data';
  if (m.startsWith('text/')) return 'code';
  if (m.includes('zip') || m.includes('tar') || m.includes('gzip') || m.includes('x-7z')) return 'archive';
  if (m.includes('spreadsheet') || m.includes('excel')) return 'spreadsheet';
  return 'document';
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.md': 'text/markdown',
  '.zip': 'application/zip',
};

/** Best-effort MIME from a filename extension (fallback: octet-stream). */
export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return EXT_MIME[name.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}
