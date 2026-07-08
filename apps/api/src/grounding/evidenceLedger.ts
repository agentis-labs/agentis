/**
 * Grounding Evidence Ledger — the durable boundary between untrusted source
 * material and organizational reasoning (RFC §8).
 *
 * Evidence versions are append-only: replaying the same source version is a
 * no-op (UNIQUE(source_object_id, content_hash)); a changed object produces a
 * new version chained to its predecessor and closes the predecessor's validity
 * window. Deletions never erase history — they flip the source object's
 * lifecycle and close the current version (RFC invariants 8 + 9).
 *
 * All content passes the §8.5 gauntlet before persistence: secret redaction
 * and prompt-injection labeling. Labels quarantine retrieval; they never block
 * the audit record.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { AccessPolicy, CanonicalSourceObject } from './types.js';

/** Conservative secret matchers — value-shaped strings that must never enter the Brain (RFC §16.4). */
const SECRET_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9\-._~+/]{24,}=*/g },
  { kind: 'api_key_assignment', re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9\-._~+/]{16,}['"]?/gi },
  { kind: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
];

/** Heuristic prompt-injection markers — content is data, never instruction (RFC §8.5). */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts|rules)/i,
  /disregard (your|the) (system prompt|instructions)/i,
  /you are now (in )?(developer|dan|jailbreak) mode/i,
  /reveal (your|the) (system prompt|instructions|secrets)/i,
];

export interface RecordObjectResult {
  sourceObjectId: string;
  /** Null when the version already existed (idempotent replay). */
  evidenceVersionId: string | null;
  created: boolean;
  securityLabels: string[];
}

export interface EvidenceLedgerDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  /** Invoked after a deletion/lifecycle change so claims can recompute support (RFC §16.3). */
  onEvidenceInvalidated?: (workspaceId: string, evidenceVersionIds: string[]) => void;
}

export class EvidenceLedgerService {
  #onInvalidated: ((workspaceId: string, evidenceVersionIds: string[]) => void) | null;

  constructor(private readonly deps: EvidenceLedgerDeps) {
    this.#onInvalidated = deps.onEvidenceInvalidated ?? null;
  }

  /** Wire the claim-recompute hook after construction (ledger ↔ claims would otherwise be circular). */
  setInvalidationHandler(handler: (workspaceId: string, evidenceVersionIds: string[]) => void): void {
    this.#onInvalidated = handler;
  }

  private get db() { return this.deps.db; }

  /**
   * Persist one canonical source object observation. Idempotent by
   * (source object identity, content hash) — RFC §7.5.
   */
  recordObject(args: {
    workspaceId: string;
    connectionId: string;
    sourceType: string;
    object: CanonicalSourceObject;
  }): RecordObjectResult {
    const now = new Date().toISOString();
    const { sanitized, labels } = this.sanitize(args.object);

    // 1. Upsert the stable external object identity.
    let row = this.db.select().from(schema.groundingSourceObjects)
      .where(and(
        eq(schema.groundingSourceObjects.workspaceId, args.workspaceId),
        eq(schema.groundingSourceObjects.connectionId, args.connectionId),
        eq(schema.groundingSourceObjects.externalId, sanitized.externalId),
      ))
      .get();
    if (!row) {
      const id = randomUUID();
      this.db.insert(schema.groundingSourceObjects).values({
        id,
        workspaceId: args.workspaceId,
        connectionId: args.connectionId,
        sourceType: args.sourceType,
        externalId: sanitized.externalId,
        objectType: sanitized.objectType,
        title: sanitized.title ?? null,
        nativeUrl: sanitized.nativeUrl ?? null,
        lifecycleState: 'active',
      }).run();
      row = this.db.select().from(schema.groundingSourceObjects).where(eq(schema.groundingSourceObjects.id, id)).get()!;
    }

    // 2. Hash the normalized content. Same hash ⇒ replay ⇒ no new version.
    const contentHash = this.hash(sanitized);
    const existing = this.db.select().from(schema.groundingEvidenceVersions)
      .where(and(
        eq(schema.groundingEvidenceVersions.sourceObjectId, row.id),
        eq(schema.groundingEvidenceVersions.contentHash, contentHash),
      ))
      .get();
    if (existing) {
      // Same content, possibly changed PERMISSIONS: ACL is not part of the
      // content hash (§7.5), so replay with a different captured ACL updates
      // the current version's policy in place (§16.3 — permission changes
      // must propagate without waiting for an edit).
      if (sanitized.acl && JSON.stringify(existing.aclJson) !== JSON.stringify(sanitized.acl)) {
        this.applyAclChange(args.workspaceId, existing.id, sanitized.acl);
      }
      return { sourceObjectId: row.id, evidenceVersionId: null, created: false, securityLabels: labels };
    }

    // 3. Append the new version; chain + close the predecessor.
    const predecessorId = row.currentVersionId ?? null;
    const versionId = randomUUID();
    this.db.insert(schema.groundingEvidenceVersions).values({
      id: versionId,
      workspaceId: args.workspaceId,
      sourceObjectId: row.id,
      predecessorVersionId: predecessorId,
      sourceVersionId: sanitized.externalVersionId ?? null,
      contentHash,
      normalizedJson: sanitized as unknown as Record<string, unknown>,
      extractionStatus: labels.includes('prompt_injection_suspect') ? 'partial' : 'ready',
      securityLabelsJson: labels,
      boundaryJson: sanitized.boundary as unknown as Record<string, unknown>,
      aclJson: (sanitized.acl ?? { mode: 'owner', allow: [], deny: [], fidelity: 'exact', capturedAt: now }) as unknown as Record<string, unknown>,
      validFrom: sanitized.modifiedAt ?? sanitized.observedAt,
      observedAt: sanitized.observedAt,
    }).run();
    if (predecessorId) {
      this.db.update(schema.groundingEvidenceVersions)
        .set({ validUntil: sanitized.modifiedAt ?? sanitized.observedAt })
        .where(eq(schema.groundingEvidenceVersions.id, predecessorId))
        .run();
    }
    this.db.update(schema.groundingSourceObjects)
      .set({
        currentVersionId: versionId,
        title: sanitized.title ?? row.title,
        objectType: sanitized.objectType,
        nativeUrl: sanitized.nativeUrl ?? row.nativeUrl,
        lifecycleState: 'active',
        updatedAt: now,
      })
      .where(eq(schema.groundingSourceObjects.id, row.id))
      .run();
    // §8.4 — searchable projection. Quarantined content never projects.
    if (!labels.includes('prompt_injection_suspect')) {
      this.projectToSearch(args.workspaceId, row.id, versionId, args.sourceType, sanitized);
    }
    return { sourceObjectId: row.id, evidenceVersionId: versionId, created: true, securityLabels: labels };
  }

  // ── Search projections (§8.4) ─────────────────────────────

  /**
   * Project the CURRENT version of a source object into the workspace's
   * "Connected Sources" knowledge base. One kb_document per source object;
   * its chunks are replaced on each new version (embeddings are derived
   * indexes and regenerate through the existing embedding backfill). Chunk
   * metadata carries evidenceVersionId + boundary so retrieval stays
   * provenance- and permission-aware. The ledger remains the source of truth.
   */
  private projectToSearch(
    workspaceId: string,
    sourceObjectId: string,
    versionId: string,
    sourceType: string,
    object: CanonicalSourceObject,
  ): void {
    const now = new Date().toISOString();
    const baseId = this.ensureProjectionBase(workspaceId);
    const docName = object.title ?? object.externalId;
    let doc = this.db.select().from(schema.kbDocuments)
      .where(and(eq(schema.kbDocuments.workspaceId, workspaceId), eq(schema.kbDocuments.knowledgeBaseId, baseId), eq(schema.kbDocuments.name, `${sourceType}:${object.externalId}`)))
      .get();
    if (!doc) {
      const id = randomUUID();
      this.db.insert(schema.kbDocuments).values({
        id,
        knowledgeBaseId: baseId,
        workspaceId,
        name: `${sourceType}:${object.externalId}`,
        mimeType: 'text/plain',
        status: 'ready',
      }).run();
      doc = this.db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, id)).get()!;
    } else {
      this.db.update(schema.kbDocuments)
        .set({ status: 'ready', archivedAt: null, updatedAt: now })
        .where(eq(schema.kbDocuments.id, doc.id))
        .run();
      // Old version's chunks are stale projections — replace them.
      this.db.delete(schema.kbChunks).where(eq(schema.kbChunks.documentId, doc.id)).run();
    }
    const text = [docName, object.content].filter(Boolean).join('\n');
    this.db.insert(schema.kbChunks).values({
      id: randomUUID(),
      documentId: doc.id,
      knowledgeBaseId: baseId,
      workspaceId,
      chunkIndex: 0,
      content: text.slice(0, 8000),
      metadata: {
        evidenceVersionId: versionId,
        sourceObjectId,
        sourceType,
        externalId: object.externalId,
        boundary: object.boundary,
        observedAt: object.observedAt,
      },
      tokenCount: Math.ceil(text.length / 4),
    }).run();
  }

  private ensureProjectionBase(workspaceId: string): string {
    const existing = this.db.select().from(schema.knowledgeBases)
      .where(and(eq(schema.knowledgeBases.workspaceId, workspaceId), eq(schema.knowledgeBases.name, 'Connected Sources')))
      .get();
    if (existing) return existing.id;
    const id = randomUUID();
    this.db.insert(schema.knowledgeBases).values({
      id,
      workspaceId,
      name: 'Connected Sources',
      description: 'Searchable projections of synchronized source evidence. Managed by the Brain; the evidence ledger stays authoritative.',
    }).run();
    return id;
  }

  /** Tombstone propagation — historical truth stays historical (RFC §16.3). */
  recordDeletion(args: {
    workspaceId: string;
    connectionId: string;
    externalId: string;
    state: 'deleted' | 'inaccessible';
    at?: string;
  }): { sourceObjectId: string | null; invalidatedVersionIds: string[] } {
    const now = args.at ?? new Date().toISOString();
    const row = this.db.select().from(schema.groundingSourceObjects)
      .where(and(
        eq(schema.groundingSourceObjects.workspaceId, args.workspaceId),
        eq(schema.groundingSourceObjects.connectionId, args.connectionId),
        eq(schema.groundingSourceObjects.externalId, args.externalId),
      ))
      .get();
    if (!row) return { sourceObjectId: null, invalidatedVersionIds: [] };
    this.db.update(schema.groundingSourceObjects)
      .set({ lifecycleState: args.state, lifecycleAt: now, updatedAt: now })
      .where(eq(schema.groundingSourceObjects.id, row.id))
      .run();
    const versions = this.db.select({ id: schema.groundingEvidenceVersions.id }).from(schema.groundingEvidenceVersions)
      .where(eq(schema.groundingEvidenceVersions.sourceObjectId, row.id))
      .all();
    const ids = versions.map((v) => v.id);
    if (row.currentVersionId) {
      this.db.update(schema.groundingEvidenceVersions)
        .set({ validUntil: now })
        .where(eq(schema.groundingEvidenceVersions.id, row.currentVersionId))
        .run();
    }
    // §8.4 invariant: deleting or restricting evidence invalidates every
    // corresponding search projection.
    const sourceTypeRow = row.sourceType;
    const doc = this.db.select().from(schema.kbDocuments)
      .where(and(
        eq(schema.kbDocuments.workspaceId, args.workspaceId),
        eq(schema.kbDocuments.name, `${sourceTypeRow}:${args.externalId}`),
      ))
      .get();
    if (doc) {
      this.db.delete(schema.kbChunks).where(eq(schema.kbChunks.documentId, doc.id)).run();
      this.db.update(schema.kbDocuments)
        .set({ status: 'archived', archivedAt: now, updatedAt: now })
        .where(eq(schema.kbDocuments.id, doc.id))
        .run();
    }
    this.#onInvalidated?.(args.workspaceId, ids);
    this.deps.logger.info('grounding.evidence.lifecycle', { workspaceId: args.workspaceId, externalId: args.externalId, state: args.state, versions: ids.length });
    return { sourceObjectId: row.id, invalidatedVersionIds: ids };
  }

  getVersion(workspaceId: string, versionId: string) {
    return this.db.select().from(schema.groundingEvidenceVersions)
      .where(and(eq(schema.groundingEvidenceVersions.workspaceId, workspaceId), eq(schema.groundingEvidenceVersions.id, versionId)))
      .get() ?? null;
  }

  /**
   * Apply a captured ACL change to a live version (§9.1). Unknown fidelity
   * narrows immediately: the version's projection is removed from search and
   * dependent claims recompute — deny-by-default until the next exact capture.
   */
  applyAclChange(workspaceId: string, versionId: string, acl: AccessPolicy): void {
    const now = new Date().toISOString();
    this.db.update(schema.groundingEvidenceVersions)
      .set({ aclJson: acl as unknown as Record<string, unknown> })
      .where(and(eq(schema.groundingEvidenceVersions.workspaceId, workspaceId), eq(schema.groundingEvidenceVersions.id, versionId)))
      .run();
    if (acl.fidelity === 'unavailable' || acl.mode === 'unknown') {
      const version = this.getVersion(workspaceId, versionId);
      if (version) {
        const object = this.db.select().from(schema.groundingSourceObjects)
          .where(eq(schema.groundingSourceObjects.id, version.sourceObjectId)).get();
        if (object) {
          const doc = this.db.select().from(schema.kbDocuments)
            .where(and(
              eq(schema.kbDocuments.workspaceId, workspaceId),
              eq(schema.kbDocuments.name, `${object.sourceType}:${object.externalId}`),
            )).get();
          if (doc) {
            this.db.delete(schema.kbChunks).where(eq(schema.kbChunks.documentId, doc.id)).run();
            this.db.update(schema.kbDocuments)
              .set({ status: 'archived', archivedAt: now, updatedAt: now })
              .where(eq(schema.kbDocuments.id, doc.id)).run();
          }
        }
      }
      this.#onInvalidated?.(workspaceId, [versionId]);
    }
    this.deps.logger.info('grounding.evidence.acl_changed', { workspaceId, versionId, fidelity: acl.fidelity });
  }

  /** Find the source object row by external identity (webhook + ACL passes). */
  getObjectByExternalId(workspaceId: string, connectionId: string, externalId: string) {
    return this.db.select().from(schema.groundingSourceObjects)
      .where(and(
        eq(schema.groundingSourceObjects.workspaceId, workspaceId),
        eq(schema.groundingSourceObjects.connectionId, connectionId),
        eq(schema.groundingSourceObjects.externalId, externalId),
      ))
      .get() ?? null;
  }

  /** Source type + boundary origin for a version — drives reliability + authority fit (§10.3–§10.4). */
  getProvenance(workspaceId: string, versionId: string): { sourceType: string; origin: string } | null {
    const version = this.getVersion(workspaceId, versionId);
    if (!version) return null;
    const object = this.db.select().from(schema.groundingSourceObjects)
      .where(eq(schema.groundingSourceObjects.id, version.sourceObjectId))
      .get();
    if (!object) return null;
    const boundary = (version.boundaryJson ?? {}) as { origin?: string };
    return { sourceType: object.sourceType, origin: boundary.origin ?? 'private_external' };
  }

  /** Is this version still live evidence (active object + open validity window)? */
  isVersionLive(workspaceId: string, versionId: string): boolean {
    const version = this.getVersion(workspaceId, versionId);
    if (!version || version.validUntil) return false;
    const object = this.db.select().from(schema.groundingSourceObjects)
      .where(eq(schema.groundingSourceObjects.id, version.sourceObjectId))
      .get();
    return object?.lifecycleState === 'active';
  }

  listRecent(workspaceId: string, limit = 50) {
    return this.db.select().from(schema.groundingEvidenceVersions)
      .where(eq(schema.groundingEvidenceVersions.workspaceId, workspaceId))
      .orderBy(desc(schema.groundingEvidenceVersions.createdAt))
      .limit(Math.min(limit, 200))
      .all();
  }

  /** §8.5 — redact secret values, label injection suspects. Never blocks persistence. */
  private sanitize(object: CanonicalSourceObject): { sanitized: CanonicalSourceObject; labels: string[] } {
    const labels: string[] = [];
    let content = object.content ?? '';
    for (const { kind, re } of SECRET_PATTERNS) {
      if (re.test(content)) {
        content = content.replace(re, `[REDACTED:${kind}]`);
        labels.push(`secret_redacted:${kind}`);
      }
      re.lastIndex = 0;
    }
    for (const re of INJECTION_PATTERNS) {
      if (re.test(content)) {
        labels.push('prompt_injection_suspect');
        break;
      }
    }
    return { sanitized: { ...object, content }, labels };
  }

  private hash(object: CanonicalSourceObject): string {
    return createHash('sha256')
      .update(JSON.stringify({
        t: object.title ?? '',
        c: object.content,
        o: object.objectType,
        a: object.attributes ?? {},
        m: object.modifiedAt ?? '',
        v: object.externalVersionId ?? '',
      }))
      .digest('hex');
  }
}
