import { z } from 'zod';

/**
 * Canonical asset (artifact) types for the Assets library.
 *
 * Stored in `artifacts.type` — a plain TEXT column, so THIS list is the single
 * source of truth, enforced in application code (API zod + web unions + workflow
 * node configs all import from here). Adding a type here makes it first-class
 * everywhere: filters, icons, viewers, agent tools, and workflow save nodes.
 */
export const ARTIFACT_TYPES = [
  'image',
  'document',
  'pdf',
  'spreadsheet',
  'data',
  'code',
  'html',
  'audio',
  'video',
  'archive',
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const artifactTypeSchema = z.enum(ARTIFACT_TYPES);

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/** Human-facing label for each type (UI tabs, card meta). */
export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  image: 'Images',
  document: 'Docs',
  pdf: 'PDF',
  spreadsheet: 'Sheets',
  data: 'Data',
  code: 'Code',
  html: 'HTML',
  audio: 'Audio',
  video: 'Video',
  archive: 'Archives',
};


export function artifactTypeFromMime(mime?: string | null, filename?: string | null): ArtifactType {
  const m = (mime ?? '').toLowerCase();
  const ext = (filename ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.startsWith('text/html') || ext === 'html' || ext === 'htm') return 'html';
  if (
    m.includes('spreadsheet') ||
    m === 'text/csv' ||
    ['csv', 'tsv', 'xlsx', 'xls', 'ods'].includes(ext)
  ) {
    return 'spreadsheet';
  }
  if (m === 'application/json' || ext === 'json' || ext === 'ndjson') return 'data';
  if (
    m.includes('zip') ||
    m.includes('tar') ||
    m.includes('gzip') ||
    m.includes('compressed') ||
    ['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(ext)
  ) {
    return 'archive';
  }
  if (
    m.startsWith('text/') &&
    ['js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'sh', 'sql', 'css', 'yaml', 'yml'].includes(ext)
  ) {
    return 'code';
  }
  return 'document';
}



