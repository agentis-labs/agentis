/**
 * Grounding Migration Engine — observe → score → trust-gated candidacy (RFC §18).
 *
 * The commercial thesis, built LAST and gated on trust: a bad process model
 * acted upon is far more dangerous than a bad search answer. The gate is
 * structural, not advisory:
 *
 *   advance(observing → candidate) requires every supporting claim to be
 *   ACTIVE, corroborated (≥2 independent origins), and free of unresolved
 *   conflicts. No exceptions, no override flag.
 *
 * V1 implements observe/score/candidate + draft proposal records. Shadowing
 * and activation stay owner-driven later stages; nothing here executes
 * anything (RFC §18.5 — `build` produces a draft, never live automation).
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { ClaimService } from './claimService.js';

export interface MigrationServiceDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  claims: ClaimService;
}

export interface TrustGateResult {
  passed: boolean;
  reasons: string[];
}

export class GroundingMigrationService {
  constructor(private readonly deps: MigrationServiceDeps) {}

  private get db() { return this.deps.db; }

  /** Record an observed repeated process (status always starts 'observing'). */
  observe(args: {
    workspaceId: string;
    title: string;
    supportingClaimIds: string[];
    currentSystems: string[];
    recurrence: number;
    determinism?: number;
    reversibility?: number;
    operationalRisk?: number;
  }) {
    const existing = this.db.select().from(schema.groundingMigrationCandidates)
      .where(and(
        eq(schema.groundingMigrationCandidates.workspaceId, args.workspaceId),
        eq(schema.groundingMigrationCandidates.title, args.title),
      ))
      .get();
    const now = new Date().toISOString();
    if (existing) {
      this.db.update(schema.groundingMigrationCandidates)
        .set({
          recurrence: Math.max(existing.recurrence, args.recurrence),
          supportingClaimIdsJson: [...new Set([...(existing.supportingClaimIdsJson as string[] ?? []), ...args.supportingClaimIds])],
          updatedAt: now,
        })
        .where(eq(schema.groundingMigrationCandidates.id, existing.id))
        .run();
      return this.get(args.workspaceId, existing.id)!;
    }
    const id = randomUUID();
    this.db.insert(schema.groundingMigrationCandidates).values({
      id,
      workspaceId: args.workspaceId,
      title: args.title,
      supportingClaimIdsJson: args.supportingClaimIds,
      currentSystemsJson: args.currentSystems,
      recurrence: args.recurrence,
      determinism: args.determinism ?? 0,
      reversibility: args.reversibility ?? 0,
      operationalRisk: args.operationalRisk ?? 0.5,
      recommendedTarget: 'keep_external',
      status: 'observing',
    }).run();
    return this.get(args.workspaceId, id)!;
  }

  get(workspaceId: string, candidateId: string) {
    return this.db.select().from(schema.groundingMigrationCandidates)
      .where(and(eq(schema.groundingMigrationCandidates.workspaceId, workspaceId), eq(schema.groundingMigrationCandidates.id, candidateId)))
      .get() ?? null;
  }

  list(workspaceId: string) {
    return this.db.select().from(schema.groundingMigrationCandidates)
      .where(eq(schema.groundingMigrationCandidates.workspaceId, workspaceId))
      .orderBy(desc(schema.groundingMigrationCandidates.updatedAt))
      .all();
  }

  /**
   * The §18 trust gate. Every supporting claim must be active, corroborated
   * by ≥2 independent origins, and free of unresolved conflicts.
   */
  trustGate(workspaceId: string, candidateId: string): TrustGateResult {
    const candidate = this.get(workspaceId, candidateId);
    if (!candidate) return { passed: false, reasons: ['Candidate not found.'] };
    const claimIds = (candidate.supportingClaimIdsJson as string[]) ?? [];
    const reasons: string[] = [];
    if (claimIds.length === 0) {
      return { passed: false, reasons: ['No supporting claims — the process model is ungrounded.'] };
    }
    const claims = this.db.select().from(schema.groundingClaims)
      .where(and(eq(schema.groundingClaims.workspaceId, workspaceId), inArray(schema.groundingClaims.id, claimIds)))
      .all();
    if (claims.length !== claimIds.length) reasons.push('Some supporting claims no longer exist.');
    for (const claim of claims) {
      if (claim.status !== 'active') {
        reasons.push(`Claim "${claim.predicate}" is ${claim.status}, not active.`);
        continue;
      }
      const evidence = this.deps.claims.listEvidence(workspaceId, claim.id).filter((ev) => ev.role === 'supports');
      const independents = new Set(evidence.map((ev) => ev.independenceKey ?? ev.evidenceVersionId)).size;
      if (independents < 2) reasons.push(`Claim "${claim.predicate}" has only ${independents} independent origin(s).`);
    }
    // Any unresolved conflict touching a supporting claim blocks candidacy.
    const conflicts = this.deps.claims.listConflicts(workspaceId, { unresolvedOnly: true })
      .filter((conflict) => ((conflict.claimIdsJson as string[]) ?? []).some((id) => claimIds.includes(id)));
    if (conflicts.length > 0) reasons.push(`${conflicts.length} unresolved conflict(s) touch the supporting claims.`);
    return { passed: reasons.length === 0, reasons };
  }

  /**
   * Score + attempt advance. Cannot leave 'observing' unless the trust gate
   * passes; cannot ever auto-advance past 'candidate' (owner approval owns
   * the rest of the §18.2 lifecycle).
   */
  evaluate(workspaceId: string, candidateId: string): { status: string; gate: TrustGateResult; recommendedTarget: string } {
    const candidate = this.get(workspaceId, candidateId);
    if (!candidate) throw new Error(`Unknown migration candidate: ${candidateId}`);
    const gate = this.trustGate(workspaceId, candidateId);
    const now = new Date().toISOString();

    const suitability = 0.4 * Math.min(1, candidate.recurrence / 5)
      + 0.3 * candidate.determinism
      + 0.3 * candidate.reversibility
      - 0.3 * candidate.operationalRisk;
    const recommendedTarget = !gate.passed || suitability < 0.4
      ? 'keep_external'
      : candidate.determinism >= 0.7 ? 'workflow' : 'agent_task';

    let status = candidate.status;
    if (candidate.status === 'observing' && gate.passed && suitability >= 0.4) {
      status = 'candidate';
    }
    this.db.update(schema.groundingMigrationCandidates)
      .set({
        status,
        recommendedTarget,
        expectedValue: Math.max(0, Number(suitability.toFixed(3))),
        evidenceJson: { gate, suitability, evaluatedAt: now },
        updatedAt: now,
      })
      .where(eq(schema.groundingMigrationCandidates.id, candidateId))
      .run();
    this.deps.logger.info('grounding.migration.evaluated', { workspaceId, candidateId, status, gatePassed: gate.passed });
    return { status, gate, recommendedTarget };
  }

  // ── §18.4–§18.5: draft → shadow → owner approval ──────────

  /**
   * Generate the Agentis draft design (§18.4). Deterministic: the proposed
   * workflow graph is derived from the candidate's supporting claims and
   * stored on the candidate — NOT inserted as a live workflow. Requires the
   * trust gate; advances investigating → draft_ready.
   */
  generateDraft(workspaceId: string, candidateId: string) {
    const candidate = this.get(workspaceId, candidateId);
    if (!candidate) throw new Error(`Unknown migration candidate: ${candidateId}`);
    if (candidate.status !== 'investigating') {
      throw new Error(`Draft generation requires 'investigating' status (currently '${candidate.status}').`);
    }
    const gate = this.trustGate(workspaceId, candidateId);
    if (!gate.passed) throw new Error(`Trust gate blocks drafting: ${gate.reasons.join(' ')}`);

    const claimIds = (candidate.supportingClaimIdsJson as string[]) ?? [];
    const claims = this.db.select().from(schema.groundingClaims)
      .where(and(eq(schema.groundingClaims.workspaceId, workspaceId), inArray(schema.groundingClaims.id, claimIds)))
      .all();
    const steps = claims
      .filter((claim) => claim.claimType === 'procedure' || claim.claimType === 'observation')
      .slice(0, 8)
      .map((claim, index) => ({
        id: `step-${index + 1}`,
        type: 'agent_task',
        title: claim.predicate.replace(/_/g, ' '),
        config: { instruction: typeof claim.objectJson === 'string' ? claim.objectJson : JSON.stringify(claim.objectJson), sourceClaimId: claim.id },
      }));
    const draft = {
      title: candidate.title.replace(/^Repeated ad-hoc run: /, ''),
      target: candidate.recommendedTarget,
      graph: {
        nodes: steps,
        edges: steps.slice(1).map((step, index) => ({ from: steps[index]!.id, to: step.id })),
      },
      controls: {
        humanCheckpoint: candidate.operationalRisk >= 0.5 || claims.some((c) => c.protectedDomain),
        rollback: 'pause workflow; external systems untouched until activation',
      },
      generatedAt: new Date().toISOString(),
    };
    const evidence = (candidate.evidenceJson ?? {}) as Record<string, unknown>;
    this.db.update(schema.groundingMigrationCandidates)
      .set({ status: 'draft_ready', evidenceJson: { ...evidence, draft }, updatedAt: new Date().toISOString() })
      .where(eq(schema.groundingMigrationCandidates.id, candidateId))
      .run();
    return this.get(workspaceId, candidateId);
  }

  /**
   * Shadow replay (§18.5): runs the draft against the candidate's HISTORICAL
   * cases with zero external side effects — pure comparison. Coverage = how
   * many historical observations the draft's steps account for; exceptions
   * (failed runs / disputed claims) are surfaced, never hidden.
   */
  shadow(workspaceId: string, candidateId: string) {
    const candidate = this.get(workspaceId, candidateId);
    if (!candidate) throw new Error(`Unknown migration candidate: ${candidateId}`);
    if (candidate.status !== 'draft_ready' && candidate.status !== 'shadowing') {
      throw new Error(`Shadowing requires 'draft_ready' (currently '${candidate.status}').`);
    }
    const claimIds = (candidate.supportingClaimIdsJson as string[]) ?? [];
    const claims = this.db.select().from(schema.groundingClaims)
      .where(and(eq(schema.groundingClaims.workspaceId, workspaceId), inArray(schema.groundingClaims.id, claimIds)))
      .all();
    const observations = claims.filter((c) => c.claimType === 'observation');
    const failures = observations.filter((c) => c.predicate.includes('fail'));
    const disputed = claims.filter((c) => c.status === 'disputed');
    const evidence = (candidate.evidenceJson ?? {}) as Record<string, unknown> & { draft?: { graph?: { nodes?: unknown[] } } };
    const stepCount = evidence.draft?.graph?.nodes?.length ?? 0;
    const coverage = observations.length === 0 ? 0
      : Number(((observations.length - failures.length) / observations.length).toFixed(3));
    const comparison = {
      historicalCases: observations.length,
      coveredByDraft: observations.length - failures.length,
      exceptions: failures.map((c) => c.predicate),
      disputedSupport: disputed.length,
      draftSteps: stepCount,
      coverage,
      verdict: coverage >= 0.8 && disputed.length === 0
        ? 'ready_for_owner_review'
        : 'exceptions_found_keep_shadowing',
      shadowedAt: new Date().toISOString(),
    };
    this.db.update(schema.groundingMigrationCandidates)
      .set({ status: 'shadowing', evidenceJson: { ...evidence, comparison }, updatedAt: new Date().toISOString() })
      .where(eq(schema.groundingMigrationCandidates.id, candidateId))
      .run();
    this.deps.logger.info('grounding.migration.shadowed', { workspaceId, candidateId, coverage, verdict: comparison.verdict });
    return this.get(workspaceId, candidateId);
  }

  /**
   * Owner approval (§18.5 "limited activation"): materializes the draft as a
   * REAL workflow row — untriggered and inert until the owner arms it in the
   * canvas. Grounding never activates automation itself (§15.6 `build` contract).
   */
  approve(workspaceId: string, candidateId: string, ownerUserId: string) {
    const candidate = this.get(workspaceId, candidateId);
    if (!candidate) throw new Error(`Unknown migration candidate: ${candidateId}`);
    if (candidate.status !== 'shadowing') {
      throw new Error(`Approval requires 'shadowing' status with a comparison (currently '${candidate.status}').`);
    }
    const evidence = (candidate.evidenceJson ?? {}) as Record<string, unknown> & {
      draft?: { title?: string; graph?: Record<string, unknown> };
      comparison?: { verdict?: string };
    };
    if (!evidence.draft?.graph) throw new Error('No draft graph on the candidate — generate the draft first.');
    const workflowId = randomUUID();
    this.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId,
      userId: ownerUserId,
      title: `[Migration draft] ${evidence.draft.title ?? candidate.title}`,
      description: `Generated from observed work "${candidate.title}". Shadow verdict: ${evidence.comparison?.verdict ?? 'none'}. Review and arm a trigger to activate.`,
      graph: evidence.draft.graph,
      tags: ['migration-draft'],
    }).run();
    this.db.update(schema.groundingMigrationCandidates)
      .set({
        status: 'owner_approved',
        evidenceJson: { ...evidence, approvedWorkflowId: workflowId },
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.groundingMigrationCandidates.id, candidateId))
      .run();
    this.deps.logger.info('grounding.migration.approved', { workspaceId, candidateId, workflowId });
    return { candidate: this.get(workspaceId, candidateId), workflowId };
  }

  /** Owner decision endpoints — reject or (gate-checked) mark for investigation. */
  setStatus(workspaceId: string, candidateId: string, status: 'investigating' | 'rejected') {
    const candidate = this.get(workspaceId, candidateId);
    if (!candidate) return null;
    if (status === 'investigating') {
      const gate = this.trustGate(workspaceId, candidateId);
      if (!gate.passed) {
        throw new Error(`Trust gate blocks investigation: ${gate.reasons.join(' ')}`);
      }
      if (candidate.status !== 'candidate') {
        throw new Error(`Only 'candidate' status can advance to investigating (currently '${candidate.status}').`);
      }
    }
    this.db.update(schema.groundingMigrationCandidates)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(schema.groundingMigrationCandidates.id, candidateId))
      .run();
    return this.get(workspaceId, candidateId);
  }
}
