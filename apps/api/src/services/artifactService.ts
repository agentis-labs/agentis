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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, type ArtifactType } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import { safeFetch } from './safeFetch.js';
import { blobRelPath, parseAssetRef } from './assetPaths.js';

export type { ArtifactType };

/** Assets §1 — coarse source class used to group artifacts in the library. */
export type ArtifactOrigin = 'agent' | 'app' | 'workflow' | 'channel' | 'manual';

export interface PersistArtifactInput {
  workspaceId: string;
  type: ArtifactType;
  title: string;
  /** File name (used for the metadata + download filename). */
  name: string;
  /** Content — inline `data:` URL for small binary, or an `asset://<hash>` ref. */
  content: string;
  /** Owner user. When absent, resolved to the workspace owner. */
  userId?: string;
  agentId?: string | null;
  appId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  nodeId?: string | null;
  /** Override the derived source class (defaults from the strongest provenance). */
  origin?: ArtifactOrigin;
  savedBy?: string;
  /** Extra metadata merged into the artifact row (e.g. hash, mime, size). */
  metadataExtra?: Record<string, unknown>;
  /** Optional thumbnail reference/URL for the Assets library. */
  thumbnailUrl?: string | null;
}

/** Derive the coarse source class from whatever provenance the caller supplied. */
export function deriveArtifactOrigin(input: {
  origin?: ArtifactOrigin;
  appId?: string | null;
  runId?: string | null;
  workflowId?: string | null;
  agentId?: string | null;
}): ArtifactOrigin {
  if (input.origin) return input.origin;
  if (input.appId) return 'app';
  if (input.runId || input.workflowId) return 'workflow';
  if (input.agentId) return 'agent';
  return 'manual';
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
    /** Content-addressed asset store root; enables resolving `asset://` refs. */
    private readonly assetsDir?: string,
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
    // File the artifact under its owning App. Workflow/agent/browser save paths
    // thread runId/workflowId but rarely hold the App in hand (the App owns the
    // workflow, and is often created AFTER it), so an explicit appId is usually
    // absent — leaving every run-produced asset with app_id=NULL and invisible in
    // the App's Assets tab. Resolve it from the strongest provenance we do have.
    const appId = this.#resolveAppId(input.workspaceId, {
      appId: input.appId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
    });
    const row = {
      id,
      workspaceId: input.workspaceId,
      userId,
      runId: input.runId ?? null,
      workflowId: input.workflowId ?? null,
      agentId: input.agentId ?? null,
      appId,
      conversationId: input.conversationId ?? null,
      nodeId: input.nodeId ?? null,
      origin: deriveArtifactOrigin({ ...input, appId }),
      type: input.type,
      title,
      content: input.content,
      thumbnailUrl: input.thumbnailUrl ?? null,
      metadata: { name: input.name, savedBy: input.savedBy ?? 'agent', ...(input.metadataExtra ?? {}) },
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
    const meta = (artifact.metadata ?? {}) as { name?: string; mime?: string };
    // Content-addressed blob reference — read the bytes off the asset store.
    const assetHash = parseAssetRef(content);
    if (assetHash) {
      const buffer = await this.readBlob(assetHash);
      return {
        buffer,
        mimeType: hint?.mimeType ?? meta.mime ?? 'application/octet-stream',
        filename: hint?.filename ?? meta.name ?? defaultName(meta.mime ?? 'application/octet-stream'),
      };
    }
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
    // safeFetch pins the connection to the IP validated at check time (defeats
    // DNS rebinding), re-validates each redirect hop, and caps the body size.
    const res = await safeFetch(url, { timeoutMs: 20_000, maxBytes: MAX_REMOTE_BYTES }, { allowPrivate: false });
    if (!res.ok) throw new AgentisError('VALIDATION_FAILED', `failed to fetch attachment (${res.status})`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_REMOTE_BYTES) {
      throw new AgentisError('VALIDATION_FAILED', `attachment exceeds ${MAX_REMOTE_BYTES} bytes`);
    }
    const mimeType = hint?.mimeType ?? res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream';
    const filename = hint?.filename ?? filenameFromUrl(new URL(res.url || url)) ?? defaultName(mimeType);
    return { buffer: Buffer.from(ab), mimeType, filename };
  }

  /** Read a content-addressed blob's bytes from the asset store. */
  async readBlob(hash: string): Promise<Buffer> {
    if (!this.assetsDir) {
      throw new AgentisError('INTERNAL_ERROR', 'asset store is not configured on this deployment');
    }
    const abs = path.join(this.assetsDir, blobRelPath(hash));
    try {
      return await fs.readFile(abs);
    } catch {
      throw new AgentisError('RESOURCE_NOT_FOUND', `asset blob ${hash} is missing from the store`);
    }
  }

  #resolveWorkspaceOwner(workspaceId: string): string | null {
    const row = this.db
      .select({ userId: schema.workspaces.userId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    return row?.userId ?? null;
  }

  /**
   * Resolve the owning App for an artifact from whatever provenance the caller
   * threaded: an explicit appId wins; otherwise the App that owns the workflow
   * (directly, or via the run → workflow chain). Returns null for a bare
   * (ownerless) workflow or a synthetic test run with no workflow_runs row.
   */
  #resolveAppId(
    workspaceId: string,
    input: { appId?: string | null; workflowId?: string | null; runId?: string | null },
  ): string | null {
    if (input.appId) return input.appId;
    if (input.workflowId) {
      const row = this.db
        .select({ appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, input.workflowId)))
        .get();
      if (row?.appId) return row.appId;
    }
    if (input.runId) {
      const row = this.db
        .select({ appId: schema.workflows.appId })
        .from(schema.workflowRuns)
        .innerJoin(schema.workflows, eq(schema.workflows.id, schema.workflowRuns.workflowId))
        .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.id, input.runId)))
        .get();
      if (row?.appId) return row.appId;
    }
    return null;
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
