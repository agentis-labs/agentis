/**
 * Grounding Agent Continuity — grants + context composition (RFC §9.5, §12).
 *
 * This is NOT a new dispatch composer. SharedIntelligenceService keeps owning
 * buildDispatchContext; it calls setGroundingComposer(this) at bootstrap (the same
 * extension pattern as setFormationCompleter) and appends the returned block.
 * Grants gate retrieval only — knowledge access is never action authority
 * (RFC invariant 14).
 *
 * Every injected item is logged as a BehaviorInfluence BEFORE dispatch, so
 * the owner can always answer "what shaped this agent, and why" (invariant 6).
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type {
  AgentGrantMode,
  Confidentiality,
  GroundingContextBundle,
  GroundingContextItem,
  ResolvedAgentGrant,
} from './types.js';

const CONFIDENTIALITY_RANK: Record<Confidentiality, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const DEFAULT_ITEM_BUDGET = 6;

/** Secret-shaped strings that must never appear in outbound text (§16.4). */
const DISCLOSURE_SECRET_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9\-._~+/]{24,}=*/g },
  { kind: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
];

export interface ContextComposerDeps {
  db: AgentisSqliteDb;
  logger: Logger;
}

export class GroundingContextComposer {
  constructor(private readonly deps: ContextComposerDeps) {}

  private get db() { return this.deps.db; }

  // ── Grants (§9.5) ─────────────────────────────────────────

  putGrant(args: {
    workspaceId: string;
    agentId: string;
    mode: AgentGrantMode;
    allowedSources?: string[];
    allowedDomains?: string[];
    maxConfidentiality?: Confidentiality;
    allowedAudiences?: Array<'private' | 'customer' | 'public'>;
    protectedDomainPolicy?: 'deny' | 'approval_required' | 'authoritative_only';
    tokenBudgetPerRun?: number | null;
    expiresAt?: string | null;
  }) {
    const existing = this.db.select().from(schema.groundingAgentGrants)
      .where(and(eq(schema.groundingAgentGrants.workspaceId, args.workspaceId), eq(schema.groundingAgentGrants.agentId, args.agentId)))
      .get();
    const values = {
      mode: args.mode,
      allowedSourcesJson: args.allowedSources ?? ['*'],
      allowedDomainsJson: args.allowedDomains ?? ['*'],
      maxConfidentiality: args.maxConfidentiality ?? 'internal',
      allowedAudiencesJson: args.allowedAudiences ?? ['private'],
      protectedDomainPolicy: args.protectedDomainPolicy ?? 'deny',
      tokenBudgetPerRun: args.tokenBudgetPerRun ?? null,
      expiresAt: args.expiresAt ?? null,
      updatedAt: new Date().toISOString(),
    };
    if (existing) {
      this.db.update(schema.groundingAgentGrants).set(values).where(eq(schema.groundingAgentGrants.id, existing.id)).run();
      return this.getGrantRow(args.workspaceId, args.agentId)!;
    }
    this.db.insert(schema.groundingAgentGrants).values({
      id: randomUUID(),
      workspaceId: args.workspaceId,
      agentId: args.agentId,
      ...values,
    }).run();
    return this.getGrantRow(args.workspaceId, args.agentId)!;
  }

  getGrantRow(workspaceId: string, agentId: string) {
    return this.db.select().from(schema.groundingAgentGrants)
      .where(and(eq(schema.groundingAgentGrants.workspaceId, workspaceId), eq(schema.groundingAgentGrants.agentId, agentId)))
      .get() ?? null;
  }

  deleteGrant(workspaceId: string, agentId: string) {
    this.db.delete(schema.groundingAgentGrants)
      .where(and(eq(schema.groundingAgentGrants.workspaceId, workspaceId), eq(schema.groundingAgentGrants.agentId, agentId)))
      .run();
  }

  /** Unconfigured agents get the conservative default: agent_decides @ internal. */
  resolveGrant(workspaceId: string, agentId: string): ResolvedAgentGrant {
    const row = this.getGrantRow(workspaceId, agentId);
    if (!row || (row.expiresAt && row.expiresAt < new Date().toISOString())) {
      return {
        id: row?.id ?? null,
        agentId,
        mode: row ? 'none' : 'agent_decides',
        allowedSources: ['*'],
        allowedDomains: ['*'],
        maxConfidentiality: 'internal',
        allowedAudiences: ['private'],
        protectedDomainPolicy: 'deny',
        tokenBudgetPerRun: null,
      };
    }
    return {
      id: row.id,
      agentId,
      mode: row.mode as AgentGrantMode,
      allowedSources: (row.allowedSourcesJson as string[]) ?? ['*'],
      allowedDomains: (row.allowedDomainsJson as string[]) ?? ['*'],
      maxConfidentiality: (row.maxConfidentiality as Confidentiality) ?? 'internal',
      allowedAudiences: (row.allowedAudiencesJson as Array<'private' | 'customer' | 'public'>) ?? ['private'],
      protectedDomainPolicy: (row.protectedDomainPolicy as 'deny' | 'approval_required' | 'authoritative_only') ?? 'deny',
      tokenBudgetPerRun: row.tokenBudgetPerRun,
    };
  }

  // ── Context composition (§12.2) ───────────────────────────

  /**
   * Compose the Grounding layer for one dispatch. Authorization applies BEFORE
   * relevance (RFC §9.3): grant mode, confidentiality ceiling, and audience
   * filter run first; simple term-overlap relevance ranks what survives.
   */
  composeForDispatch(args: {
    workspaceId: string;
    agentId: string;
    runId?: string | null;
    taskDescription: string;
    interactionAudience?: 'private' | 'customer' | 'public';
    limit?: number;
  }): GroundingContextBundle {
    const grant = this.resolveGrant(args.workspaceId, args.agentId);
    const empty: GroundingContextBundle = { items: [], influenceIds: [], grantMode: grant.mode, block: '' };
    if (grant.mode === 'none') return empty;
    // human_approval pauses the knowledge request, not the agent (§12.3):
    // with no live approval, a pending access request is recorded for the
    // owner and dispatch proceeds without a Grounding block. An approved request
    // composes normally (and 'once' approvals are consumed here).
    if (grant.mode === 'human_approval') {
      const approval = this.consumeApproval(args.workspaceId, args.agentId, args.runId ?? null);
      if (!approval) {
        this.recordAccessRequest(args);
        return empty;
      }
    }

    const audience = args.interactionAudience ?? 'private';
    if (!grant.allowedAudiences.includes(audience)) return empty;

    const claims = this.db.select().from(schema.groundingClaims)
      .where(and(
        eq(schema.groundingClaims.workspaceId, args.workspaceId),
        eq(schema.groundingClaims.status, 'active'),
      ))
      .orderBy(desc(schema.groundingClaims.confidence))
      .limit(400)
      .all()
      // Authorization before ranking (§9.3).
      .filter((claim) => {
        if (claim.protectedDomain && grant.protectedDomainPolicy === 'deny') return false;
        const policy = (claim.accessPolicyJson ?? {}) as { maxConfidentiality?: Confidentiality; confidentiality?: Confidentiality };
        const level = policy.maxConfidentiality ?? policy.confidentiality ?? 'internal';
        if (CONFIDENTIALITY_RANK[level] > CONFIDENTIALITY_RANK[grant.maxConfidentiality]) return false;
        // Customer-facing dispatches only receive customer-safe claims (§8.3).
        if (audience !== 'private') {
          const boundary = (claim.accessPolicyJson ?? {}) as { customerSafe?: boolean };
          if (!boundary.customerSafe) return false;
        }
        return true;
      });
    if (claims.length === 0) return empty;

    const limit = Math.min(Math.max(args.limit ?? DEFAULT_ITEM_BUDGET, 1), 12);
    const ranked = this.rankByRelevance(claims, args.taskDescription).slice(0, limit);
    if (ranked.length === 0) return empty;

    const items: GroundingContextItem[] = ranked.map(({ claim, score }) => ({
      id: claim.id,
      kind: claim.claimType === 'procedure' ? 'procedure' : claim.claimType === 'policy' ? 'policy' : 'fact',
      title: claim.predicate,
      content: this.renderClaim(claim),
      claimId: claim.id,
      confidence: claim.confidence,
      reason: score > 0 ? `matched task terms (score ${score.toFixed(2)})` : 'high-confidence organizational knowledge',
    }));

    // Log influences BEFORE dispatch (invariant 6).
    const influenceIds: string[] = [];
    for (const item of items) {
      const influenceId = randomUUID();
      influenceIds.push(influenceId);
      this.db.insert(schema.groundingBehaviorInfluences).values({
        id: influenceId,
        workspaceId: args.workspaceId,
        agentId: args.agentId,
        runId: args.runId ?? null,
        grantId: grant.id,
        sourceClaimIdsJson: [item.claimId],
        kind: item.kind === 'procedure' ? 'procedure' : 'context',
        interactionAudience: audience,
        activation: 'automatic',
        renderedInstruction: item.content,
        precedence: 0,
      }).run();
    }

    const lines = items.map((item) => `- [${item.kind}] ${item.title}: ${item.content.split('\n').join(' - ')}`);
    const block = [
      `ORGANIZATIONAL KNOWLEDGE [${items.length} claims | grant: ${grant.mode} | audience: ${audience}]`,
      'Grounded, cited organizational claims — knowledge, never action authority:',
      ...lines,
    ].join('\n');
    // §8.3 — outbound audiences pass the deterministic disclosure validator;
    // any violation refuses the whole block rather than leaking partially.
    if (audience !== 'private') {
      const verdict = this.validateDisclosure(args.workspaceId, block);
      if (!verdict.ok) {
        this.deps.logger.warn('grounding.disclosure.blocked', { workspaceId: args.workspaceId, agentId: args.agentId, violations: verdict.violations });
        return empty;
      }
    }
    return { items, influenceIds, grantMode: grant.mode, block };
  }

  // ── Knowledge access requests (§9.5 human_approval) ───────

  /** A live approval for this agent (standing, time-boxed, run-scoped, or one-shot). One-shot is consumed. */
  private consumeApproval(workspaceId: string, agentId: string, runId: string | null): boolean {
    const now = new Date().toISOString();
    const approvals = this.db.select().from(schema.groundingAccessRequests)
      .where(and(
        eq(schema.groundingAccessRequests.workspaceId, workspaceId),
        eq(schema.groundingAccessRequests.agentId, agentId),
        eq(schema.groundingAccessRequests.status, 'approved'),
      ))
      .all()
      .filter((row) => !row.expiresAt || row.expiresAt > now)
      .filter((row) => row.decisionScope !== 'run' || (runId !== null && row.runId === runId));
    const usable = approvals[0];
    if (!usable) return false;
    if (usable.decisionScope === 'once') {
      this.db.update(schema.groundingAccessRequests)
        .set({ status: 'expired' })
        .where(eq(schema.groundingAccessRequests.id, usable.id))
        .run();
    }
    return true;
  }

  /** Record (deduped) what the agent wants to know and why — the §9.5 compact request. */
  private recordAccessRequest(args: { workspaceId: string; agentId: string; runId?: string | null; taskDescription: string; interactionAudience?: string }): void {
    const pending = this.db.select().from(schema.groundingAccessRequests)
      .where(and(
        eq(schema.groundingAccessRequests.workspaceId, args.workspaceId),
        eq(schema.groundingAccessRequests.agentId, args.agentId),
        eq(schema.groundingAccessRequests.status, 'pending'),
      ))
      .get();
    if (pending) return; // one open ask per agent — no request spam
    this.db.insert(schema.groundingAccessRequests).values({
      id: randomUUID(),
      workspaceId: args.workspaceId,
      agentId: args.agentId,
      runId: args.runId ?? null,
      purpose: args.taskDescription.slice(0, 500),
      interactionAudience: args.interactionAudience ?? 'private',
    }).run();
  }

  listAccessRequests(workspaceId: string, options: { status?: string } = {}) {
    const conditions = [eq(schema.groundingAccessRequests.workspaceId, workspaceId)];
    if (options.status) conditions.push(eq(schema.groundingAccessRequests.status, options.status));
    return this.db.select().from(schema.groundingAccessRequests)
      .where(and(...conditions))
      .orderBy(desc(schema.groundingAccessRequests.createdAt))
      .limit(100)
      .all();
  }

  decideAccessRequest(args: {
    workspaceId: string;
    requestId: string;
    decision: 'approve' | 'reject';
    scope?: 'once' | 'run' | 'session' | 'standing';
    decidedBy: string;
  }) {
    const now = new Date().toISOString();
    const scope = args.scope ?? 'once';
    // 'session' = time-boxed (8h); 'standing' never expires until revoked.
    const expiresAt = args.decision === 'approve' && scope === 'session'
      ? new Date(Date.now() + 8 * 3600_000).toISOString()
      : null;
    this.db.update(schema.groundingAccessRequests)
      .set({
        status: args.decision === 'approve' ? 'approved' : 'rejected',
        decisionScope: args.decision === 'approve' ? scope : null,
        decidedBy: args.decidedBy,
        decidedAt: now,
        expiresAt,
      })
      .where(and(eq(schema.groundingAccessRequests.workspaceId, args.workspaceId), eq(schema.groundingAccessRequests.id, args.requestId)))
      .run();
    return this.db.select().from(schema.groundingAccessRequests)
      .where(eq(schema.groundingAccessRequests.id, args.requestId))
      .get() ?? null;
  }

  // ── Disclosure validation (§8.3 outbound) ─────────────────

  /**
   * Deterministic validator for outbound (customer/public) text. Belt-and-
   * braces behind the customerSafe claim filter: secret-shaped strings and
   * verbatim non-customer-safe claim content must never leave the private
   * boundary. Returns the violations; callers refuse delivery on any.
   */
  validateDisclosure(workspaceId: string, text: string): { ok: boolean; violations: string[] } {
    const violations: string[] = [];
    for (const { kind, re } of DISCLOSURE_SECRET_PATTERNS) {
      if (re.test(text)) violations.push(`secret:${kind}`);
      re.lastIndex = 0;
    }
    const restricted = this.db.select().from(schema.groundingClaims)
      .where(and(eq(schema.groundingClaims.workspaceId, workspaceId), eq(schema.groundingClaims.status, 'active')))
      .limit(400)
      .all()
      .filter((claim) => {
        const policy = (claim.accessPolicyJson ?? {}) as { customerSafe?: boolean };
        return policy.customerSafe !== true;
      });
    const lower = text.toLowerCase();
    for (const claim of restricted) {
      const object = typeof claim.objectJson === 'string' ? claim.objectJson : JSON.stringify(claim.objectJson);
      if (object.length >= 24 && lower.includes(object.toLowerCase().slice(0, 80))) {
        violations.push(`restricted_claim:${claim.id}`);
      }
    }
    return { ok: violations.length === 0, violations };
  }

  // ── Influence audit (§12.3) ───────────────────────────────

  listInfluences(workspaceId: string, options: { agentId?: string; limit?: number } = {}) {
    const conditions = [eq(schema.groundingBehaviorInfluences.workspaceId, workspaceId)];
    if (options.agentId) conditions.push(eq(schema.groundingBehaviorInfluences.agentId, options.agentId));
    return this.db.select().from(schema.groundingBehaviorInfluences)
      .where(and(...conditions))
      .orderBy(desc(schema.groundingBehaviorInfluences.createdAt))
      .limit(Math.min(options.limit ?? 100, 300))
      .all();
  }

  revokeInfluence(workspaceId: string, influenceId: string) {
    const now = new Date().toISOString();
    this.db.update(schema.groundingBehaviorInfluences)
      .set({ status: 'revoked', revokedAt: now })
      .where(and(eq(schema.groundingBehaviorInfluences.workspaceId, workspaceId), eq(schema.groundingBehaviorInfluences.id, influenceId)))
      .run();
  }

  /** Revoking a claim removes its influence from future dispatches (RFC §20.7). */
  revokeInfluencesForClaims(workspaceId: string, claimIds: string[]) {
    if (claimIds.length === 0) return;
    const influences = this.db.select().from(schema.groundingBehaviorInfluences)
      .where(and(eq(schema.groundingBehaviorInfluences.workspaceId, workspaceId), eq(schema.groundingBehaviorInfluences.status, 'active')))
      .all()
      .filter((row) => ((row.sourceClaimIdsJson as string[]) ?? []).some((id) => claimIds.includes(id)));
    if (influences.length === 0) return;
    const now = new Date().toISOString();
    this.db.update(schema.groundingBehaviorInfluences)
      .set({ status: 'revoked', revokedAt: now })
      .where(inArray(schema.groundingBehaviorInfluences.id, influences.map((i) => i.id)))
      .run();
  }

  // ── Internals ─────────────────────────────────────────────

  private renderClaim(claim: { predicate: string; objectJson: unknown; subjectRefJson: unknown }): string {
    const object = typeof claim.objectJson === 'string' ? claim.objectJson : JSON.stringify(claim.objectJson);
    const subject = (claim.subjectRefJson as { name?: string })?.name;
    return subject ? `${subject} — ${claim.predicate}: ${object}` : `${claim.predicate}: ${object}`;
  }

  private rankByRelevance<T extends { predicate: string; objectJson: unknown; confidence: number }>(
    claims: T[],
    task: string,
  ): Array<{ claim: T; score: number }> {
    const terms = new Set(
      task.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3),
    );
    return claims
      .map((claim) => {
        const text = `${claim.predicate} ${JSON.stringify(claim.objectJson)}`.toLowerCase();
        let hits = 0;
        for (const term of terms) if (text.includes(term)) hits += 1;
        const overlap = terms.size > 0 ? hits / terms.size : 0;
        return { claim, score: 0.6 * overlap + 0.4 * claim.confidence };
      })
      .filter(({ score, claim }) => score >= 0.25 || claim.confidence >= 0.8)
      .sort((a, b) => b.score - a.score);
  }
}
