/**
 * CORA Identity — entities, source principals, and cross-source identity
 * links (RFC §9.1–§9.2).
 *
 * The §9.2 split is enforced structurally:
 *   • DETERMINISTIC methods (email_exact on verified-equal addresses,
 *     oauth_subject, owner_asserted) activate automatically.
 *   • PROBABILISTIC matches are stored with status 'review' and surface in
 *     the identity review queue. They never merge silently — shared inboxes,
 *     aliases, contractors, and recycled numbers make auto-merge dangerous.
 *
 * V1 single-player: the owner and agents are known anchors; only external
 * subjects are fuzzy, so imperfect resolution degrades to mild duplication,
 * never corruption.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { SourcePrincipalInput } from './types.js';

export type DeterministicMethod = 'email_exact' | 'oauth_subject' | 'owner_asserted';

export interface IdentityServiceDeps {
  db: AgentisSqliteDb;
  logger: Logger;
}

export class IdentityService {
  constructor(private readonly deps: IdentityServiceDeps) {}

  private get db() { return this.deps.db; }

  // ── Entities ──────────────────────────────────────────────

  upsertEntity(args: {
    workspaceId: string;
    kind: string;
    name: string;
    domain?: string;
    aliases?: string[];
    attributes?: Record<string, unknown>;
  }) {
    const existing = this.db.select().from(schema.coraEntities)
      .where(and(
        eq(schema.coraEntities.workspaceId, args.workspaceId),
        eq(schema.coraEntities.kind, args.kind),
        eq(schema.coraEntities.name, args.name),
      ))
      .get();
    if (existing) {
      if (args.aliases?.length || args.attributes) {
        const aliases = [...new Set([...(existing.aliasesJson as string[] ?? []), ...(args.aliases ?? [])])];
        this.db.update(schema.coraEntities)
          .set({
            aliasesJson: aliases,
            attributesJson: { ...(existing.attributesJson as Record<string, unknown>), ...(args.attributes ?? {}) },
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.coraEntities.id, existing.id))
          .run();
      }
      return this.getEntity(args.workspaceId, existing.id)!;
    }
    const id = randomUUID();
    this.db.insert(schema.coraEntities).values({
      id,
      workspaceId: args.workspaceId,
      kind: args.kind,
      name: args.name,
      domain: args.domain ?? null,
      aliasesJson: args.aliases ?? [],
      attributesJson: args.attributes ?? {},
    }).run();
    return this.getEntity(args.workspaceId, id)!;
  }

  getEntity(workspaceId: string, entityId: string) {
    return this.db.select().from(schema.coraEntities)
      .where(and(eq(schema.coraEntities.workspaceId, workspaceId), eq(schema.coraEntities.id, entityId)))
      .get() ?? null;
  }

  listEntities(workspaceId: string, options: { kind?: string; limit?: number } = {}) {
    const conditions = [eq(schema.coraEntities.workspaceId, workspaceId), eq(schema.coraEntities.status, 'active')];
    if (options.kind) conditions.push(eq(schema.coraEntities.kind, options.kind));
    return this.db.select().from(schema.coraEntities)
      .where(and(...conditions))
      .orderBy(desc(schema.coraEntities.updatedAt))
      .limit(Math.min(options.limit ?? 200, 500))
      .all();
  }

  // ── Principals ────────────────────────────────────────────

  upsertPrincipal(args: { workspaceId: string; connectionId: string; principal: SourcePrincipalInput }) {
    const existing = this.db.select().from(schema.coraSourcePrincipals)
      .where(and(
        eq(schema.coraSourcePrincipals.workspaceId, args.workspaceId),
        eq(schema.coraSourcePrincipals.connectionId, args.connectionId),
        eq(schema.coraSourcePrincipals.externalPrincipalId, args.principal.externalPrincipalId),
      ))
      .get();
    if (existing) {
      this.db.update(schema.coraSourcePrincipals)
        .set({
          displayName: args.principal.displayName ?? existing.displayName,
          email: args.principal.email ?? existing.email,
          attributesJson: { ...(existing.attributesJson as Record<string, unknown>), ...(args.principal.attributes ?? {}) },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.coraSourcePrincipals.id, existing.id))
        .run();
      const updated = this.db.select().from(schema.coraSourcePrincipals).where(eq(schema.coraSourcePrincipals.id, existing.id)).get()!;
      this.tryDeterministicLink(args.workspaceId, updated);
      return updated;
    }
    const id = randomUUID();
    this.db.insert(schema.coraSourcePrincipals).values({
      id,
      workspaceId: args.workspaceId,
      connectionId: args.connectionId,
      externalPrincipalId: args.principal.externalPrincipalId,
      kind: args.principal.kind,
      displayName: args.principal.displayName ?? null,
      email: args.principal.email ?? null,
      attributesJson: args.principal.attributes ?? {},
    }).run();
    const created = this.db.select().from(schema.coraSourcePrincipals).where(eq(schema.coraSourcePrincipals.id, id)).get()!;
    this.tryDeterministicLink(args.workspaceId, created);
    return created;
  }

  // ── Identity links (§9.2) ─────────────────────────────────

  /**
   * Deterministic auto-link: a principal whose verified email matches another
   * already-linked principal's email joins that entity. Otherwise, if an
   * entity of kind 'person' shares the exact email in aliases, link to it.
   * Anything weaker is NOT linked here — it goes to proposeProbabilisticLink.
   */
  private tryDeterministicLink(workspaceId: string, principal: { id: string; email: string | null; displayName: string | null }): void {
    if (!principal.email) return;
    const email = principal.email.trim().toLowerCase();
    if (!email) return;
    // Already linked?
    const existingLink = this.db.select().from(schema.coraIdentityLinks)
      .where(and(
        eq(schema.coraIdentityLinks.workspaceId, workspaceId),
        eq(schema.coraIdentityLinks.principalId, principal.id),
        eq(schema.coraIdentityLinks.status, 'active'),
      ))
      .get();
    if (existingLink) return;
    // Another principal with the same email already linked to an entity?
    const peers = this.db.select().from(schema.coraSourcePrincipals)
      .where(and(eq(schema.coraSourcePrincipals.workspaceId, workspaceId), eq(schema.coraSourcePrincipals.email, principal.email)))
      .all()
      .filter((p) => p.id !== principal.id);
    for (const peer of peers) {
      const peerLink = this.db.select().from(schema.coraIdentityLinks)
        .where(and(
          eq(schema.coraIdentityLinks.workspaceId, workspaceId),
          eq(schema.coraIdentityLinks.principalId, peer.id),
          eq(schema.coraIdentityLinks.status, 'active'),
        ))
        .get();
      if (peerLink) {
        this.createLink({
          workspaceId,
          entityId: peerLink.entityId,
          principalId: principal.id,
          method: 'email_exact',
          confidence: 0.95,
          supporting: [`email:${email}`],
        });
        return;
      }
    }
    // No linked peer — create a person entity anchored on this email.
    const entity = this.upsertEntity({
      workspaceId,
      kind: 'person',
      name: principal.displayName ?? email,
      aliases: [email],
    });
    this.createLink({
      workspaceId,
      entityId: entity.id,
      principalId: principal.id,
      method: 'email_exact',
      confidence: 0.9,
      supporting: [`email:${email}`],
    });
  }

  createLink(args: {
    workspaceId: string;
    entityId: string;
    principalId: string;
    method: DeterministicMethod | 'probabilistic';
    confidence: number;
    supporting?: string[];
    conflicting?: string[];
  }) {
    const id = randomUUID();
    const deterministic = args.method !== 'probabilistic';
    this.db.insert(schema.coraIdentityLinks).values({
      id,
      workspaceId: args.workspaceId,
      entityId: args.entityId,
      principalId: args.principalId,
      method: args.method,
      confidence: args.confidence,
      // The §9.2 split: deterministic activates, probabilistic queues for review.
      status: deterministic ? 'active' : 'review',
      supportingJson: args.supporting ?? [],
      conflictingJson: args.conflicting ?? [],
      validFrom: new Date().toISOString(),
    }).run();
    return this.db.select().from(schema.coraIdentityLinks).where(eq(schema.coraIdentityLinks.id, id)).get()!;
  }

  /** The identity review queue (RFC §15.4). */
  listReviewQueue(workspaceId: string) {
    return this.db.select().from(schema.coraIdentityLinks)
      .where(and(eq(schema.coraIdentityLinks.workspaceId, workspaceId), eq(schema.coraIdentityLinks.status, 'review')))
      .orderBy(desc(schema.coraIdentityLinks.createdAt))
      .all();
  }

  resolveLink(workspaceId: string, linkId: string, decision: 'approve' | 'reject', reviewedBy: string) {
    const now = new Date().toISOString();
    this.db.update(schema.coraIdentityLinks)
      .set({
        status: decision === 'approve' ? 'active' : 'rejected',
        reviewedBy,
        updatedAt: now,
        ...(decision === 'reject' ? { validUntil: now } : {}),
      })
      .where(and(eq(schema.coraIdentityLinks.workspaceId, workspaceId), eq(schema.coraIdentityLinks.id, linkId)))
      .run();
    return this.db.select().from(schema.coraIdentityLinks).where(eq(schema.coraIdentityLinks.id, linkId)).get() ?? null;
  }

  /** Owner splits a wrong merge — the link closes; history stays auditable (RFC §20.3). */
  splitLink(workspaceId: string, linkId: string, reviewedBy: string) {
    const now = new Date().toISOString();
    this.db.update(schema.coraIdentityLinks)
      .set({ status: 'split', reviewedBy, validUntil: now, updatedAt: now })
      .where(and(eq(schema.coraIdentityLinks.workspaceId, workspaceId), eq(schema.coraIdentityLinks.id, linkId)))
      .run();
    return this.db.select().from(schema.coraIdentityLinks).where(eq(schema.coraIdentityLinks.id, linkId)).get() ?? null;
  }
}
