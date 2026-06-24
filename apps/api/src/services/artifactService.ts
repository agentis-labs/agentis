/**
 * ArtifactService — shared persistence + resolution for run artifacts.
 *
 * Two surfaces previously persisted artifacts inline (the WorkflowEngine
 * `browser`/`artifact_save` nodes) but agents and channel delivery had no way
 * to do the same. This centralizes it so:
 *
 *  - Agent tools (`browser_screenshot`, registry `agentis.browser.*`) can save a
 *    screenshot/PDF and get back a referenceable id + url.
 *  - Channel delivery can resolve an attachment reference (`artifact:<id>`, a
 *    `data:` URL, or an `http(s)` URL) back into raw bytes to upload.
 *
 * Binary payloads are stored inline as `data:` URLs in `artifacts.content`
 * (matching the WorkflowEngine convention) so the Output gallery can preview +
 * download them without a separate blob endpoint.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import { assertSafeUrl } from './safeUrl.js';

export type ArtifactType = 'html' | 'image' | 'document' | 'code' | 'data';

export interface PersistArtifactInput {
  workspaceId: string;
  type: ArtifactType;
  title: string;
  /** File name (used for the metadata + download filename). */
  name: string;
  /** Inline content — for binary this is a `data:` URL. */
  content: string;
  /** Owner user. When absent, resolved to the workspace owner. */
  userId?: string;
  agentId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  nodeId?: string | null;
  savedBy?: string;
}

export interface PersistedArtifact {
  id: string;
  name: string;
  title: string;
  type: ArtifactType;
  /** Stable reference an agent can hand to `agentis.channel.send`. */
  ref: string;
  /** API path to fetch the artifact row. */
  url: string;
}

export interface ResolvedArtifactBytes {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

/** Max bytes we will pull from a remote URL when resolving an attachment. */
const MAX_REMOTE_BYTES = 20 * 1024 * 1024;

export class ArtifactService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
    private readonly bus?: EventBus,
  ) {}

  /** Persist an artifact row, resolving the owner user from the workspace when needed. */
  persist(input: PersistArtifactInput): PersistedArtifact {
    const userId = input.userId ?? this.#resolveWorkspaceOwner(input.workspaceId);
    if (!userId) {
      throw new AgentisError('VALIDATION_FAILED', `cannot persist artifact: no owner user for workspace ${input.workspaceId}`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = (input.title || input.name).slice(0, 200);
    const row = {
      id,
      workspaceId: input.workspaceId,
      userId,
      runId: input.runId ?? null,
      workflowId: input.workflowId ?? null,
      agentId: input.agentId ?? null,
      conversationId: input.conversationId ?? null,
      nodeId: input.nodeId ?? null,
      type: input.type,
      title,
      content: input.content,
      thumbnailUrl: null,
      metadata: { name: input.name, savedBy: input.savedBy ?? 'agent' },
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.db.insert(schema.artifacts).values(row).run();
    } catch (err) {
      this.logger.warn('artifact.persist_failed', { workspaceId: input.workspaceId, message: (err as Error).message });
      throw new AgentisError('INTERNAL_ERROR', `artifact persist failed: ${(err as Error).message}`);
    }
    if (this.bus) {
      this.bus.publish(REALTIME_ROOMS.workspace(input.workspaceId), REALTIME_EVENTS.ARTIFACT_CREATED, { artifact: row });
    }
    return { id, name: input.name, title, type: input.type, ref: `artifact:${id}`, url: `/v1/artifacts/${id}` };
  }

  /**
   * Resolve an attachment reference into raw bytes. Supports:
   *  - `artifact:<id>` (or a bare artifact id) → the stored `data:` URL content
   *  - `data:<mime>;base64,<...>` → decoded inline
   *  - `http(s)://…` → fetched (SSRF-guarded, size-capped)
   */
  async resolveBytes(workspaceId: string, ref: string, hint?: { filename?: string; mimeType?: string }): Promise<ResolvedArtifactBytes> {
    const trimmed = ref.trim();
    if (trimmed.startsWith('data:')) {
      const parsed = parseDataUrl(trimmed);
      if (!parsed) throw new AgentisError('VALIDATION_FAILED', 'attachment data URL is malformed');
      return { buffer: parsed.buffer, mimeType: hint?.mimeType ?? parsed.mimeType, filename: hint?.filename ?? defaultName(parsed.mimeType) };
    }
    if (/^https?:\/\//i.test(trimmed)) {
      return this.#fetchRemote(trimmed, hint);
    }
    // artifact reference (artifact:<id> or bare id)
    const id = trimmed.startsWith('artifact:') ? trimmed.slice('artifact:'.length) : trimmed;
    const artifact = this.db
      .select()
      .from(schema.artifacts)
      .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.workspaceId, workspaceId)))
      .get();
    if (!artifact) throw new AgentisError('RESOURCE_NOT_FOUND', `artifact ${id} not found in this workspace`);
    const content = artifact.content ?? '';
    const meta = (artifact.metadata ?? {}) as { name?: string };
    if (content.startsWith('data:')) {
      const parsed = parseDataUrl(content);
      if (!parsed) throw new AgentisError('VALIDATION_FAILED', `artifact ${id} content is not a valid data URL`);
      return {
        buffer: parsed.buffer,
        mimeType: hint?.mimeType ?? parsed.mimeType,
        filename: hint?.filename ?? meta.name ?? defaultName(parsed.mimeType),
      };
    }
    // Plain-text artifact (code/data/html) — send as a UTF-8 file.
    return {
      buffer: Buffer.from(content, 'utf8'),
      mimeType: hint?.mimeType ?? 'text/plain',
      filename: hint?.filename ?? meta.name ?? `${artifact.title || 'artifact'}.txt`,
    };
  }

  async #fetchRemote(url: string, hint?: { filename?: string; mimeType?: string }): Promise<ResolvedArtifactBytes> {
    const safe = await assertSafeUrl(url, { allowPrivate: false });
    const res = await fetch(safe.toString(), { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new AgentisError('VALIDATION_FAILED', `failed to fetch attachment (${res.status})`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_REMOTE_BYTES) {
      throw new AgentisError('VALIDATION_FAILED', `attachment exceeds ${MAX_REMOTE_BYTES} bytes`);
    }
    const mimeType = hint?.mimeType ?? res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream';
    const filename = hint?.filename ?? filenameFromUrl(safe) ?? defaultName(mimeType);
    return { buffer: Buffer.from(ab), mimeType, filename };
  }

  #resolveWorkspaceOwner(workspaceId: string): string | null {
    const row = this.db
      .select({ userId: schema.workspaces.userId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    return row?.userId ?? null;
  }
}

interface ParsedDataUrl {
  mimeType: string;
  buffer: Buffer;
}

/** Parse a `data:<mime>;base64,<payload>` (or non-base64) URL into bytes. */
export function parseDataUrl(value: string): ParsedDataUrl | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(value);
  if (!match) return null;
  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';
  const buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mimeType, buffer };
}

function filenameFromUrl(url: URL): string | null {
  const last = url.pathname.split('/').filter(Boolean).pop();
  return last && /\.[a-z0-9]{1,8}$/i.test(last) ? last : null;
}

function defaultName(mimeType: string): string {
  const ext = MIME_EXT[mimeType] ?? mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'bin';
  return `attachment.${ext}`;
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/html': 'html',
  'application/json': 'json',
};
