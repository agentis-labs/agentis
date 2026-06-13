/**
 * CORA Claim Ledger — atomic organizational statements with computed
 * confidence and formation gating (RFC §10).
 *
 * Garbage control (§10.6) is enforced HERE, not narrated:
 *   • confidence is computed from inspectable components, never model say-so;
 *   • corroboration counts independent origins (independence_key collapses
 *     copies/forwards to one source);
 *   • a claim is born `candidate` and activates only through gating rules;
 *   • single-source consequential (protected) claims stay `candidate`;
 *   • conflicts write a knowledge_links `contradicts` row so contradictions
 *     surface through the EXISTING Brain dispute system (one surface, §10.5).
 *
 * Evidence invalidation (deleted/restricted sources) recomputes support and
 * demotes claims whose grounding is gone (RFC §16.3).
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EvidenceLedgerService } from './evidenceLedger.js';
import type { ClaimInput, ClaimStatus, ConfidenceComponents } from './types.js';

const ACTIVATION_THRESHOLD = 0.55;
const REASONING_VERSION = 'cora-v1';

export interface ClaimServiceDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  ledger: EvidenceLedgerService;
}

export class ClaimService {
  constructor(private readonly deps: ClaimServiceDeps) {}

  private get db() { return this.deps.db; }

  /**
   * Record a claim with its evidence and attempt activation through the
   * formation gate. Returns the stored claim row (status reflects gating).
   *
   * Idempotent: an identical claim (same predicate, subject, and object)
   * REINFORCES the existing row — new evidence links are appended and the
   * gate re-runs over the merged support, so a candidate can graduate to
   * active when corroboration arrives. Extraction re-runs never duplicate.
   */
  recordClaim(input: ClaimInput): { id: string; status: ClaimStatus; confidence: number; components: ConfidenceComponents } {
    const identical = this.findIdentical(input);
    if (identical) return this.reinforceClaim(identical, input);
    const id = randomUUID();
    const components = this.computeConfidence(input);
    const confidence = this.scoreFromComponents(components);
    const protectedDomain = input.protectedDomain ?? false;
    const status = this.gate({
      confidence,
      components,
      protectedDomain,
      authorityFit: this.authorityFit(input.workspaceId, input.predicate, input.evidence.map((ev) => ev.evidenceVersionId)),
    });

    this.db.insert(schema.coraClaims).values({
      id,
      workspaceId: input.workspaceId,
      subjectEntityId: input.subjectEntityId ?? null,
      subjectRefJson: input.subjectRef ?? {},
      predicate: input.predicate,
      objectJson: input.object as Record<string, unknown>,
      claimType: input.claimType ?? 'observation',
      status,
      confidence,
      confidenceJson: components as unknown as Record<string, unknown>,
      accessPolicyJson: input.accessPolicy ?? {},
      protectedDomain,
      validFrom: input.validFrom ?? new Date().toISOString(),
      reasoningVersion: input.reasoningVersion ?? REASONING_VERSION,
    }).run();

    for (const ev of input.evidence) {
      this.db.insert(schema.coraClaimEvidence).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        claimId: id,
        evidenceVersionId: ev.evidenceVersionId,
        role: ev.role ?? 'supports',
        directness: ev.directness ?? 1,
        locatorJson: ev.locator ?? {},
        independenceKey: ev.independenceKey ?? this.defaultIndependenceKey(input.workspaceId, ev.evidenceVersionId),
      }).run();
    }

    this.detectConflicts(input.workspaceId, id, input.predicate, input.subjectEntityId ?? null, input.object, protectedDomain);
    return { id, status, confidence, components };
  }

  getClaim(workspaceId: string, claimId: string) {
    return this.db.select().from(schema.coraClaims)
      .where(and(eq(schema.coraClaims.workspaceId, workspaceId), eq(schema.coraClaims.id, claimId)))
      .get() ?? null;
  }

  listClaims(workspaceId: string, options: { status?: ClaimStatus; limit?: number } = {}) {
    const conditions = [eq(schema.coraClaims.workspaceId, workspaceId)];
    if (options.status) conditions.push(eq(schema.coraClaims.status, options.status));
    return this.db.select().from(schema.coraClaims)
      .where(and(...conditions))
      .orderBy(desc(schema.coraClaims.updatedAt))
      .limit(Math.min(options.limit ?? 100, 500))
      .all();
  }

  listEvidence(workspaceId: string, claimId: string) {
    return this.db.select().from(schema.coraClaimEvidence)
      .where(and(eq(schema.coraClaimEvidence.workspaceId, workspaceId), eq(schema.coraClaimEvidence.claimId, claimId)))
      .all();
  }

  /** Owner governance: approve/reject/correct (RFC §15.4). */
  setStatus(workspaceId: string, claimId: string, status: ClaimStatus, actor: 'owner' | 'system' = 'owner') {
    const now = new Date().toISOString();
    this.db.update(schema.coraClaims)
      .set({ status, updatedAt: now, ...(status === 'superseded' || status === 'expired' ? { validUntil: now } : {}) })
      .where(and(eq(schema.coraClaims.workspaceId, workspaceId), eq(schema.coraClaims.id, claimId)))
      .run();
    this.audit(workspaceId, actor, 'claim_status_changed', 'claim', claimId, { status });
    return this.getClaim(workspaceId, claimId);
  }

  // ── Conflicts → existing dispute surface (§10.5) ──────────

  listConflicts(workspaceId: string, options: { unresolvedOnly?: boolean } = {}) {
    const conditions = [eq(schema.coraClaimConflicts.workspaceId, workspaceId)];
    if (options.unresolvedOnly) conditions.push(eq(schema.coraClaimConflicts.resolution, 'unresolved'));
    return this.db.select().from(schema.coraClaimConflicts)
      .where(and(...conditions))
      .orderBy(desc(schema.coraClaimConflicts.updatedAt))
      .all();
  }

  resolveConflict(args: {
    workspaceId: string;
    conflictId: string;
    winnerClaimId?: string;
    resolution: 'confidence_winner' | 'authority_winner' | 'temporal_successor' | 'human_decision';
  }) {
    const conflict = this.db.select().from(schema.coraClaimConflicts)
      .where(and(eq(schema.coraClaimConflicts.workspaceId, args.workspaceId), eq(schema.coraClaimConflicts.id, args.conflictId)))
      .get();
    if (!conflict) return null;
    const claimIds = (conflict.claimIdsJson as string[]) ?? [];
    // Protected conflicts only resolve through authority or a human (§10.5).
    if (conflict.consequentiality === 'protected'
      && args.resolution !== 'human_decision' && args.resolution !== 'authority_winner') {
      throw new Error('Protected conflicts require human_decision or authority_winner resolution.');
    }
    const now = new Date().toISOString();
    const winner = args.winnerClaimId ?? null;
    this.db.update(schema.coraClaimConflicts)
      .set({ resolution: args.resolution, activeClaimId: winner, updatedAt: now })
      .where(eq(schema.coraClaimConflicts.id, args.conflictId))
      .run();
    if (winner) {
      this.db.update(schema.coraClaims)
        .set({ status: 'active', updatedAt: now })
        .where(and(eq(schema.coraClaims.workspaceId, args.workspaceId), eq(schema.coraClaims.id, winner)))
        .run();
      const losers = claimIds.filter((c) => c !== winner);
      if (losers.length > 0) {
        this.db.update(schema.coraClaims)
          .set({ status: 'superseded', validUntil: now, updatedAt: now })
          .where(and(eq(schema.coraClaims.workspaceId, args.workspaceId), inArray(schema.coraClaims.id, losers)))
          .run();
      }
    }
    // Close the shared dispute row so the Brain dispute surface clears too.
    if (conflict.disputeLinkId) {
      this.db.update(schema.knowledgeLinks)
        .set({ resolvedAt: now, invalidAt: now, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, conflict.disputeLinkId))
        .run();
    }
    this.audit(args.workspaceId, 'owner', 'conflict_resolved', 'claim_conflict', args.conflictId, { resolution: args.resolution, winner });
    return this.db.select().from(schema.coraClaimConflicts).where(eq(schema.coraClaimConflicts.id, args.conflictId)).get();
  }

  // ── Evidence invalidation propagation (§16.3) ─────────────

  /** Wire as EvidenceLedgerService.onEvidenceInvalidated. */
  onEvidenceInvalidated = (workspaceId: string, evidenceVersionIds: string[]): void => {
    if (evidenceVersionIds.length === 0) return;
    const rows = this.db.select().from(schema.coraClaimEvidence)
      .where(and(
        eq(schema.coraClaimEvidence.workspaceId, workspaceId),
        inArray(schema.coraClaimEvidence.evidenceVersionId, evidenceVersionIds),
      ))
      .all();
    const claimIds = [...new Set(rows.map((r) => r.claimId))];
    const now = new Date().toISOString();
    for (const claimId of claimIds) {
      const liveSupport = this.listEvidence(workspaceId, claimId)
        .filter((ev) => ev.role === 'supports')
        .filter((ev) => this.deps.ledger.isVersionLive(workspaceId, ev.evidenceVersionId));
      if (liveSupport.length === 0) {
        this.db.update(schema.coraClaims)
          .set({ status: 'expired', validUntil: now, updatedAt: now })
          .where(and(eq(schema.coraClaims.workspaceId, workspaceId), eq(schema.coraClaims.id, claimId)))
          .run();
        this.audit(workspaceId, 'system', 'claim_expired_no_support', 'claim', claimId, {});
      } else {
        // Support shrank — recompute and possibly demote to candidate.
        const independents = new Set(liveSupport.map((ev) => ev.independenceKey ?? ev.evidenceVersionId)).size;
        if (independents < 2) {
          const claim = this.getClaim(workspaceId, claimId);
          if (claim && claim.protectedDomain && claim.status === 'active') {
            this.db.update(schema.coraClaims)
              .set({ status: 'candidate', updatedAt: now })
              .where(eq(schema.coraClaims.id, claimId))
              .run();
            this.audit(workspaceId, 'system', 'claim_demoted_support_loss', 'claim', claimId, { independents });
          }
        }
      }
    }
    if (claimIds.length > 0) {
      this.deps.logger.info('cora.claims.support_recomputed', { workspaceId, claims: claimIds.length });
    }
  };

  // ── Formation internals ───────────────────────────────────

  /** §10.3 — computed components; calibrated weighted blend, each part inspectable. */
  private computeConfidence(input: ClaimInput): ConfidenceComponents {
    const supports = input.evidence.filter((ev) => (ev.role ?? 'supports') === 'supports');
    const contradicts = input.evidence.filter((ev) => ev.role === 'contradicts');
    const independenceKeys = new Set(supports.map((ev) => ev.independenceKey ?? this.defaultIndependenceKey(input.workspaceId, ev.evidenceVersionId)));
    const independents = independenceKeys.size;
    // 1 source → 0.4, 2 → 0.7, 3+ → asymptotic to 1.
    const corroboration = independents === 0 ? 0 : Math.min(1, 0.4 + 0.3 * (independents - 1));
    const directness = supports.length > 0
      ? supports.reduce((sum, ev) => sum + Math.max(0, Math.min(1, ev.directness ?? 1)), 0) / supports.length
      : 0;
    const freshness = this.freshnessOf(input.workspaceId, supports.map((ev) => ev.evidenceVersionId));
    const consistency = contradicts.length === 0 ? 1 : Math.max(0, 1 - 0.4 * contradicts.length);
    const contradictionPenalty = Math.min(0.5, 0.25 * contradicts.length);
    return {
      corroboration,
      sourceReliability: this.reliabilityOf(input.workspaceId, supports.map((ev) => ev.evidenceVersionId)),
      directness,
      freshness,
      consistency,
      contradictionPenalty,
    };
  }

  /**
   * §10.3 — origin-calibrated source reliability. Owner-authored statements
   * outrank first-party Agentis evidence, which outranks external private
   * material, which outranks scraped public text. Averaged over supports.
   */
  private reliabilityOf(workspaceId: string, versionIds: string[]): number {
    if (versionIds.length === 0) return 0.5;
    const ORIGIN_RELIABILITY: Record<string, number> = {
      owner_authored: 1,
      agentis_native: 0.9,
      private_external: 0.75,
      public_external: 0.6,
    };
    let total = 0;
    let counted = 0;
    for (const id of versionIds) {
      const provenance = this.deps.ledger.getProvenance(workspaceId, id);
      if (!provenance) continue;
      total += ORIGIN_RELIABILITY[provenance.origin] ?? 0.7;
      counted += 1;
    }
    return counted === 0 ? 0.5 : Number((total / counted).toFixed(3));
  }

  // ── Authority profiles (§10.4) ────────────────────────────

  /** predicate → source types the owner declared authoritative. Stored on the owner profile. */
  getAuthorityProfiles(workspaceId: string): Record<string, string[]> {
    const profile = this.db.select().from(schema.coraOwnerProfiles)
      .where(eq(schema.coraOwnerProfiles.workspaceId, workspaceId))
      .get();
    const defaults = (profile?.defaultsJson ?? {}) as { authorityProfiles?: Record<string, string[]> };
    return defaults.authorityProfiles ?? {};
  }

  setAuthorityProfile(workspaceId: string, predicate: string, sourceTypes: string[]): Record<string, string[]> {
    const profile = this.db.select().from(schema.coraOwnerProfiles)
      .where(eq(schema.coraOwnerProfiles.workspaceId, workspaceId))
      .get();
    if (!profile) throw new Error('Launch the Brain before configuring authority profiles.');
    const defaults = (profile.defaultsJson ?? {}) as Record<string, unknown> & { authorityProfiles?: Record<string, string[]> };
    const profiles = { ...(defaults.authorityProfiles ?? {}) };
    if (sourceTypes.length === 0) delete profiles[predicate];
    else profiles[predicate] = sourceTypes;
    this.db.update(schema.coraOwnerProfiles)
      .set({ defaultsJson: { ...defaults, authorityProfiles: profiles }, updatedAt: new Date().toISOString() })
      .where(eq(schema.coraOwnerProfiles.id, profile.id))
      .run();
    this.audit(workspaceId, 'owner', 'authority_profile_set', 'predicate', predicate, { sourceTypes });
    return profiles;
  }

  /**
   * Does at least one supporting evidence version come from a source the
   * owner declared authoritative for this predicate? Owner-defined only —
   * CORA never silently redefines protected authority (§10.4).
   */
  private authorityFit(workspaceId: string, predicate: string, versionIds: string[]): boolean {
    const profiles = this.getAuthorityProfiles(workspaceId);
    const authoritative = profiles[predicate];
    if (!authoritative || authoritative.length === 0) return false;
    return versionIds.some((id) => {
      const provenance = this.deps.ledger.getProvenance(workspaceId, id);
      return provenance ? authoritative.includes(provenance.sourceType) : false;
    });
  }

  private scoreFromComponents(c: ConfidenceComponents): number {
    const blend = 0.35 * c.corroboration
      + 0.15 * c.sourceReliability
      + 0.2 * c.directness
      + 0.15 * c.freshness
      + 0.15 * c.consistency
      - c.contradictionPenalty;
    return Math.max(0, Math.min(1, Number(blend.toFixed(4))));
  }

  /**
   * §10.6 gate. Ordinary descriptive claims activate on score; protected
   * (consequential) claims with single-source support are quarantined as
   * candidates — UNLESS the owner declared the supporting source
   * authoritative for the predicate (§10.4: a signed policy repo can
   * activate a protected policy claim on its own authority).
   */
  private gate(args: { confidence: number; components: ConfidenceComponents; protectedDomain: boolean; authorityFit?: boolean }): ClaimStatus {
    if (args.protectedDomain && args.components.corroboration < 0.7 && !args.authorityFit) return 'candidate';
    if (args.confidence >= ACTIVATION_THRESHOLD || (args.protectedDomain && args.authorityFit)) return 'active';
    return 'candidate';
  }

  /**
   * Same subject + predicate with a different object value ⇒ contradiction
   * set + a knowledge_links `contradicts` row (the shared dispute id-space).
   */
  private detectConflicts(
    workspaceId: string,
    claimId: string,
    predicate: string,
    subjectEntityId: string | null,
    object: unknown,
    protectedDomain: boolean,
  ): void {
    const conditions = [
      eq(schema.coraClaims.workspaceId, workspaceId),
      eq(schema.coraClaims.predicate, predicate),
      inArray(schema.coraClaims.status, ['active', 'candidate', 'disputed']),
    ];
    if (subjectEntityId) conditions.push(eq(schema.coraClaims.subjectEntityId, subjectEntityId));
    const peers = this.db.select().from(schema.coraClaims)
      .where(and(...conditions))
      .all()
      .filter((peer) => peer.id !== claimId)
      .filter((peer) => JSON.stringify(peer.objectJson) !== JSON.stringify(object));
    if (peers.length === 0) return;

    const now = new Date().toISOString();
    const rival = peers[0]!;
    const linkId = randomUUID();
    this.db.insert(schema.knowledgeLinks).values({
      id: linkId,
      workspaceId,
      sourceId: claimId,
      sourceKind: 'cora_claim',
      targetId: rival.id,
      targetKind: 'cora_claim',
      relation: 'contradicts',
      confidence: 0.8,
    }).run();
    this.db.insert(schema.coraClaimConflicts).values({
      id: randomUUID(),
      workspaceId,
      disputeLinkId: linkId,
      claimIdsJson: [claimId, rival.id],
      consequentiality: protectedDomain || rival.protectedDomain ? 'protected' : 'normal',
      rationaleJson: { predicate, detectedAt: now },
    }).run();
    this.db.update(schema.coraClaims)
      .set({ status: 'disputed', updatedAt: now })
      .where(inArray(schema.coraClaims.id, [claimId, rival.id]))
      .run();
    this.deps.logger.info('cora.claims.conflict_detected', { workspaceId, predicate, claims: [claimId, rival.id] });
  }

  /** Identical = same predicate + subject + object value, still live. */
  private findIdentical(input: ClaimInput) {
    const conditions = [
      eq(schema.coraClaims.workspaceId, input.workspaceId),
      eq(schema.coraClaims.predicate, input.predicate),
      inArray(schema.coraClaims.status, ['candidate', 'active', 'disputed']),
    ];
    if (input.subjectEntityId) conditions.push(eq(schema.coraClaims.subjectEntityId, input.subjectEntityId));
    const subjectRef = JSON.stringify(input.subjectRef ?? {});
    return this.db.select().from(schema.coraClaims)
      .where(and(...conditions))
      .all()
      .find((row) =>
        JSON.stringify(row.objectJson) === JSON.stringify(input.object)
        && (input.subjectEntityId || JSON.stringify(row.subjectRefJson) === subjectRef)) ?? null;
  }

  /** Append new evidence links, recompute over the merged support, re-gate. */
  private reinforceClaim(
    existing: { id: string; protectedDomain: boolean; status: string },
    input: ClaimInput,
  ): { id: string; status: ClaimStatus; confidence: number; components: ConfidenceComponents } {
    const linked = new Set(this.listEvidence(input.workspaceId, existing.id).map((ev) => ev.evidenceVersionId));
    for (const ev of input.evidence) {
      if (linked.has(ev.evidenceVersionId)) continue;
      this.db.insert(schema.coraClaimEvidence).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        claimId: existing.id,
        evidenceVersionId: ev.evidenceVersionId,
        role: ev.role ?? 'supports',
        directness: ev.directness ?? 1,
        locatorJson: ev.locator ?? {},
        independenceKey: ev.independenceKey ?? this.defaultIndependenceKey(input.workspaceId, ev.evidenceVersionId),
      }).run();
    }
    const merged: ClaimInput = {
      ...input,
      evidence: this.listEvidence(input.workspaceId, existing.id).map((ev) => ({
        evidenceVersionId: ev.evidenceVersionId,
        role: ev.role as 'supports' | 'contradicts' | 'contextualizes' | 'supersedes',
        directness: ev.directness,
        independenceKey: ev.independenceKey ?? undefined,
      })),
    };
    const components = this.computeConfidence(merged);
    const confidence = this.scoreFromComponents(components);
    // Re-gate, but never auto-downgrade an owner-approved active claim and
    // never auto-clear a dispute — only resolution does that.
    const gated = this.gate({
      confidence,
      components,
      protectedDomain: existing.protectedDomain,
      authorityFit: this.authorityFit(input.workspaceId, input.predicate, merged.evidence.map((ev) => ev.evidenceVersionId)),
    });
    const status = existing.status === 'disputed' ? 'disputed'
      : existing.status === 'active' ? 'active'
      : gated;
    this.db.update(schema.coraClaims)
      .set({ confidence, confidenceJson: components as unknown as Record<string, unknown>, status, updatedAt: new Date().toISOString() })
      .where(eq(schema.coraClaims.id, existing.id))
      .run();
    return { id: existing.id, status: status as ClaimStatus, confidence, components };
  }

  /** Default independence key: the evidence version's source object — copies inside one object collapse. */
  private defaultIndependenceKey(workspaceId: string, evidenceVersionId: string): string {
    const version = this.deps.ledger.getVersion(workspaceId, evidenceVersionId);
    return version ? `obj:${version.sourceObjectId}` : `ev:${evidenceVersionId}`;
  }

  private freshnessOf(workspaceId: string, versionIds: string[]): number {
    if (versionIds.length === 0) return 0;
    const now = Date.now();
    let best = 0;
    for (const id of versionIds) {
      const version = this.deps.ledger.getVersion(workspaceId, id);
      if (!version) continue;
      const ageDays = (now - Date.parse(version.observedAt)) / 86_400_000;
      const score = !Number.isFinite(ageDays) ? 0.5 : ageDays <= 7 ? 1 : ageDays <= 30 ? 0.9 : ageDays <= 120 ? 0.7 : 0.5;
      best = Math.max(best, score);
    }
    return best;
  }

  private audit(workspaceId: string, actor: 'owner' | 'agent' | 'system', eventType: string, subjectKind: string, subjectId: string, payload: Record<string, unknown>): void {
    this.db.insert(schema.coraAuditEvents).values({
      id: randomUUID(),
      workspaceId,
      actor,
      eventType,
      subjectKind,
      subjectId,
      payloadJson: payload,
    }).run();
  }

  /** Deterministic hash of the active claim set — model snapshot input (§13.4). */
  activeClaimSetHash(workspaceId: string): string {
    const actives = this.db.select({ id: schema.coraClaims.id, updatedAt: schema.coraClaims.updatedAt })
      .from(schema.coraClaims)
      .where(and(eq(schema.coraClaims.workspaceId, workspaceId), eq(schema.coraClaims.status, 'active')))
      .orderBy(schema.coraClaims.id)
      .all();
    return createHash('sha256').update(JSON.stringify(actives)).digest('hex');
  }
}
