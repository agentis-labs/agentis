import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { WorkflowGraph, WorkflowNode } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { SpecialistMindService } from '../specialist/specialistMindService.js';
import type { WorkflowFailureClassification } from './workflowFailureClassification.js';

export interface WorkflowExperienceContext {
  workspaceId: string;
  workflowId: string;
  appId?: string | null;
  agentId?: string | null;
  specialistRole?: string | null;
  activeRevisionId?: string | null;
  candidateRevisionId?: string | null;
}

export interface ExperienceDossier {
  revision: {
    active: ReturnType<WorkflowExperienceService['revisionSummary']> | null;
    candidate: ReturnType<WorkflowExperienceService['revisionSummary']> | null;
  };
  pinned: Array<{ id: string; kind: string; title: string; content: string; confidence: number }>;
  secondary: Array<{ id: string; kind: string; title: string; content: string; confidence: number }>;
  regressionFixtures: unknown[];
}

export class WorkflowExperienceService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly specialistMind?: SpecialistMindService,
  ) {}

  reserveRepairAttempt(input: {
    workspaceId: string;
    workflowId: string;
    baseRevisionId: string;
    failureFingerprint: string;
    runId: string;
    nodeId: string;
    error: string;
  }): { allowed: boolean; prior?: typeof schema.workflowRepairAttempts.$inferSelect } {
    const prior = this.db.select().from(schema.workflowRepairAttempts).where(and(
      eq(schema.workflowRepairAttempts.workspaceId, input.workspaceId),
      eq(schema.workflowRepairAttempts.workflowId, input.workflowId),
      eq(schema.workflowRepairAttempts.baseRevisionId, input.baseRevisionId),
      eq(schema.workflowRepairAttempts.failureFingerprint, input.failureFingerprint),
    )).get();
    if (prior) {
      this.db.update(schema.workflowRepairAttempts).set({
        attemptCount: prior.attemptCount + 1,
        lastError: input.error,
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.workflowRepairAttempts.id, prior.id)).run();
      return { allowed: false, prior };
    }
    const now = new Date().toISOString();
    this.db.insert(schema.workflowRepairAttempts).values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      baseRevisionId: input.baseRevisionId,
      failureFingerprint: input.failureFingerprint,
      runId: input.runId,
      nodeId: input.nodeId,
      status: 'proposed',
      attemptCount: 1,
      lastError: input.error,
      createdAt: now,
      updatedAt: now,
    }).run();
    return { allowed: true };
  }

  completeRepairAttempt(input: {
    workspaceId: string;
    workflowId: string;
    baseRevisionId: string;
    failureFingerprint: string;
    status: 'candidate' | 'verified' | 'rejected' | 'regressed';
    candidateRevisionId?: string | null;
  }) {
    this.db.update(schema.workflowRepairAttempts).set({
      status: input.status,
      candidateRevisionId: input.candidateRevisionId ?? null,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(schema.workflowRepairAttempts.workspaceId, input.workspaceId),
      eq(schema.workflowRepairAttempts.workflowId, input.workflowId),
      eq(schema.workflowRepairAttempts.baseRevisionId, input.baseRevisionId),
      eq(schema.workflowRepairAttempts.failureFingerprint, input.failureFingerprint),
    )).run();
  }

  recordFailureObservation(input: {
    context: WorkflowExperienceContext;
    revisionId: string | null;
    node: Pick<WorkflowNode, 'id' | 'title' | 'config'>;
    error: string;
    fingerprint: string;
    classification: WorkflowFailureClassification;
    runId: string;
    inputs?: Record<string, unknown>;
  }) {
    if (!input.classification.learnerEligible) return null;
    const key = `failure:${input.fingerprint}`;
    const existing = this.findByKey(input.context.workspaceId, 'workflow', input.context.workflowId, key, 'pending');
    const now = new Date().toISOString();
    const evidence = {
      runIds: uniqueStrings([
        ...jsonStrings((existing?.evidenceJson as Record<string, unknown> | null)?.runIds),
        input.runId,
      ]),
      occurrences: (existing?.successCount ?? 0) + 1,
      nodeId: input.node.id,
      nodeTitle: input.node.title,
      error: input.error,
      inputs: redactInputs(input.inputs ?? {}),
      observedAt: now,
    };
    if (existing) {
      this.db.update(schema.workflowExperiences).set({
        evidenceJson: evidence,
        successCount: existing.successCount + 1,
        updatedAt: now,
      }).where(eq(schema.workflowExperiences.id, existing.id)).run();
      return existing.id;
    }
    const id = randomUUID();
    this.db.insert(schema.workflowExperiences).values({
      id,
      workspaceId: input.context.workspaceId,
      workflowId: input.context.workflowId,
      appId: input.context.appId ?? null,
      agentId: input.context.agentId ?? null,
      revisionId: input.revisionId,
      scopeType: 'workflow',
      scopeId: input.context.workflowId,
      applicabilityKey: key,
      kind: 'failure_observation',
      status: 'pending',
      failureFingerprint: input.fingerprint,
      failureClass: input.classification.category,
      title: `${input.node.title || input.node.id}: ${input.classification.canonicalCode}`.slice(0, 180),
      rootCause: input.classification.reason,
      repairSummary: '',
      preconditionsJson: {
        nodeKind: input.node.config.kind,
        canonicalCode: input.classification.canonicalCode,
      },
      evidenceJson: evidence,
      confidence: 0.35,
      successCount: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }

  recordVerifiedRepair(input: {
    context: WorkflowExperienceContext;
    baseRevisionId: string;
    candidateRevisionId: string;
    fingerprint: string;
    classification: WorkflowFailureClassification;
    rootCause: string;
    repairSummary: string;
    proofRunId: string;
    regressionFixture: Record<string, unknown>;
  }) {
    const now = new Date().toISOString();
    const pending = this.findByKey(
      input.context.workspaceId,
      'workflow',
      input.context.workflowId,
      `failure:${input.fingerprint}`,
      'pending',
    );
    const activeKey = `repair:${input.fingerprint}`;
    const priorActive = this.findByKey(
      input.context.workspaceId,
      'workflow',
      input.context.workflowId,
      activeKey,
      'active',
    );
    this.db.transaction(() => {
      if (pending) {
        this.db.update(schema.workflowExperiences).set({
          status: 'superseded',
          updatedAt: now,
        }).where(eq(schema.workflowExperiences.id, pending.id)).run();
      }
      if (priorActive) {
        this.db.update(schema.workflowExperiences).set({
          status: 'superseded',
          updatedAt: now,
        }).where(eq(schema.workflowExperiences.id, priorActive.id)).run();
      }
      this.db.insert(schema.workflowExperiences).values({
        id: randomUUID(),
        workspaceId: input.context.workspaceId,
        workflowId: input.context.workflowId,
        appId: input.context.appId ?? null,
        agentId: input.context.agentId ?? null,
        revisionId: input.candidateRevisionId,
        scopeType: 'workflow',
        scopeId: input.context.workflowId,
        applicabilityKey: activeKey,
        kind: 'verified_repair',
        status: 'active',
        failureFingerprint: input.fingerprint,
        failureClass: input.classification.category,
        title: `Verified repair for ${input.classification.canonicalCode}`,
        rootCause: input.rootCause,
        repairSummary: input.repairSummary,
        preconditionsJson: { baseRevisionId: input.baseRevisionId },
        regressionFixtureJson: input.regressionFixture,
        evidenceJson: { proofRunIds: [input.proofRunId], candidateRevisionId: input.candidateRevisionId },
        confidence: 0.85,
        successCount: 1,
        supersedesId: priorActive?.id ?? pending?.id ?? null,
        createdAt: now,
        updatedAt: now,
      }).run();
    });
  }

  recordRejectedRepair(input: {
    context: WorkflowExperienceContext;
    revisionId: string;
    fingerprint: string;
    title: string;
    repairSummary: string;
    evidence?: Record<string, unknown>;
  }) {
    const now = new Date().toISOString();
    const key = `anti:${input.fingerprint}:${input.revisionId}`;
    if (this.findByKey(input.context.workspaceId, 'workflow', input.context.workflowId, key, 'anti_pattern')) return;
    this.db.insert(schema.workflowExperiences).values({
      id: randomUUID(),
      workspaceId: input.context.workspaceId,
      workflowId: input.context.workflowId,
      appId: input.context.appId ?? null,
      agentId: input.context.agentId ?? null,
      revisionId: input.revisionId,
      scopeType: 'workflow',
      scopeId: input.context.workflowId,
      applicabilityKey: key,
      kind: 'repair_anti_pattern',
      status: 'anti_pattern',
      failureFingerprint: input.fingerprint,
      title: input.title,
      repairSummary: input.repairSummary,
      evidenceJson: input.evidence ?? {},
      confidence: 0.9,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  async recordAccomplished(input: {
    context: WorkflowExperienceContext;
    revisionId: string;
    semanticHash: string;
    graph: WorkflowGraph;
    runId: string;
    objective?: string | null;
  }) {
    const now = new Date().toISOString();
    const workflowKey = `success:${input.semanticHash}`;
    const current = this.findByKey(
      input.context.workspaceId,
      'workflow',
      input.context.workflowId,
      workflowKey,
      'active',
    );
    const nextCount = (current?.successCount ?? 0) + 1;
    const evidence = {
      runIds: uniqueStrings([
        ...jsonStrings((current?.evidenceJson as Record<string, unknown> | null)?.runIds),
        input.runId,
      ]).slice(-20),
      semanticHash: input.semanticHash,
      objective: input.objective ?? null,
      nodeKinds: [...new Set(input.graph.nodes.map((node) => node.config.kind))],
      lastAccomplishedAt: now,
    };
    if (current) {
      this.db.update(schema.workflowExperiences).set({
        evidenceJson: evidence,
        confidence: Math.min(0.98, 0.7 + nextCount * 0.07),
        successCount: nextCount,
        updatedAt: now,
      }).where(eq(schema.workflowExperiences.id, current.id)).run();
    } else {
      this.db.insert(schema.workflowExperiences).values({
        id: randomUUID(),
        workspaceId: input.context.workspaceId,
        workflowId: input.context.workflowId,
        appId: input.context.appId ?? null,
        revisionId: input.revisionId,
        scopeType: 'workflow',
        scopeId: input.context.workflowId,
        applicabilityKey: workflowKey,
        kind: 'known_good_revision',
        status: 'active',
        title: input.objective?.trim().slice(0, 180) || 'Known-good workflow implementation',
        rootCause: '',
        repairSummary: describeGraphRecipe(input.graph),
        preconditionsJson: {},
        evidenceJson: evidence,
        confidence: 0.77,
        successCount: 1,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
    if (nextCount >= 3 && input.context.appId) {
      this.promoteScope({
        workspaceId: input.context.workspaceId,
        workflowId: input.context.workflowId,
        appId: input.context.appId,
        fromScopeType: 'workflow',
        fromScopeId: input.context.workflowId,
        toScopeType: 'app',
        toScopeId: input.context.appId,
        key: `workflow-pattern:${input.context.workflowId}:${input.semanticHash}`,
        title: input.objective?.trim().slice(0, 180) || 'Repeatedly successful workflow pattern',
        content: describeGraphRecipe(input.graph),
        evidence,
        confidence: 0.88,
      });
    }
    await this.promoteSpecialistRoles(input, nextCount);
  }

  dossier(context: WorkflowExperienceContext, limit = 24): ExperienceDossier {
    const rows = this.db.select().from(schema.workflowExperiences)
      .where(eq(schema.workflowExperiences.workspaceId, context.workspaceId))
      .orderBy(desc(schema.workflowExperiences.updatedAt))
      .limit(500)
      .all()
      .filter((row) => row.status === 'active' || row.status === 'anti_pattern')
      .filter((row) => applies(row.scopeType, row.scopeId, context));

    const ranked = rows.sort((a, b) => {
      const scope = scopeRank(a.scopeType) - scopeRank(b.scopeType);
      if (scope !== 0) return scope;
      return b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt);
    });
    const regressionFixtures = ranked
      .map((row) => row.regressionFixtureJson)
      .filter((fixture): fixture is object => Boolean(fixture));
    const mapped = ranked.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      content: experienceContent(row),
      confidence: row.confidence,
    }));
    return {
      revision: {
        active: context.activeRevisionId ? this.revisionSummary(context.activeRevisionId) : null,
        candidate: context.candidateRevisionId ? this.revisionSummary(context.candidateRevisionId) : null,
      },
      pinned: mapped.filter((row) => row.kind === 'verified_repair' || row.kind === 'repair_anti_pattern' || row.kind === 'known_good_revision').slice(0, limit),
      secondary: mapped.filter((row) => row.kind !== 'verified_repair' && row.kind !== 'repair_anti_pattern' && row.kind !== 'known_good_revision').slice(0, Math.max(0, limit - 8)),
      regressionFixtures,
    };
  }

  renderDossier(context: WorkflowExperienceContext, limit = 24): string {
    const dossier = this.dossier(context, limit);
    const lines: string[] = [
      '<workflow_experience_dossier>',
      '  <law>The active revision is proven. Never replace it with an unverified graph. Preserve pinned invariants and regression cases.</law>',
    ];
    if (dossier.revision.active) {
      lines.push(`  <active_revision id="${dossier.revision.active.id}" hash="${dossier.revision.active.semanticHash}" trust="${dossier.revision.active.trustState}">`);
      lines.push(`    ${escapeXml(dossier.revision.active.summary)}`);
      lines.push('  </active_revision>');
    }
    if (dossier.revision.candidate) {
      lines.push(`  <candidate_revision id="${dossier.revision.candidate.id}" hash="${dossier.revision.candidate.semanticHash}" trust="${dossier.revision.candidate.trustState}">`);
      lines.push(`    ${escapeXml(dossier.revision.candidate.summary)}`);
      lines.push('  </candidate_revision>');
    }
    for (const item of dossier.pinned) {
      lines.push(`  <pinned_experience id="${item.id}" kind="${item.kind}" confidence="${item.confidence.toFixed(2)}">${escapeXml(`${item.title}: ${item.content}`)}</pinned_experience>`);
    }
    for (const item of dossier.secondary) {
      lines.push(`  <supporting_experience id="${item.id}" kind="${item.kind}" confidence="${item.confidence.toFixed(2)}">${escapeXml(`${item.title}: ${item.content}`)}</supporting_experience>`);
    }
    lines.push('</workflow_experience_dossier>');
    return lines.join('\n');
  }

  revisionSummary(revisionId: string) {
    const revision = this.db.select().from(schema.workflowGraphRevisions)
      .where(eq(schema.workflowGraphRevisions.id, revisionId)).get();
    if (!revision) return null;
    const proofRows = this.db.select().from(schema.workflowRevisionProofs)
      .where(eq(schema.workflowRevisionProofs.revisionId, revisionId)).all();
    return {
      id: revision.id,
      semanticHash: revision.semanticHash,
      status: revision.status,
      trustState: revision.trustState,
      summary: `${revision.reason || revision.source}; proof ${proofRows.filter((row) => row.status === 'passed').length}/${proofRows.length} passed`,
    };
  }

  private findByKey(
    workspaceId: string,
    scopeType: string,
    scopeId: string,
    key: string,
    status: string,
  ) {
    return this.db.select().from(schema.workflowExperiences).where(and(
      eq(schema.workflowExperiences.workspaceId, workspaceId),
      eq(schema.workflowExperiences.scopeType, scopeType),
      eq(schema.workflowExperiences.scopeId, scopeId),
      eq(schema.workflowExperiences.applicabilityKey, key),
      eq(schema.workflowExperiences.status, status),
    )).get();
  }

  private promoteScope(input: {
    workspaceId: string;
    workflowId: string;
    appId: string | null;
    fromScopeType: string;
    fromScopeId: string;
    toScopeType: string;
    toScopeId: string;
    key: string;
    title: string;
    content: string;
    evidence: Record<string, unknown>;
    confidence: number;
  }) {
    const existing = this.findByKey(input.workspaceId, input.toScopeType, input.toScopeId, input.key, 'active');
    if (existing) return existing.id;
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.insert(schema.workflowExperiences).values({
      id,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      appId: input.appId,
      scopeType: input.toScopeType,
      scopeId: input.toScopeId,
      applicabilityKey: input.key,
      kind: 'promoted_pattern',
      status: 'active',
      title: input.title,
      repairSummary: input.content,
      preconditionsJson: { promotedFrom: `${input.fromScopeType}:${input.fromScopeId}` },
      evidenceJson: input.evidence,
      confidence: input.confidence,
      successCount: 3,
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }

  private async promoteSpecialistRoles(
    input: {
      context: WorkflowExperienceContext;
      revisionId: string;
      semanticHash: string;
      graph: WorkflowGraph;
      runId: string;
      objective?: string | null;
    },
    workflowSuccessCount: number,
  ) {
    if (workflowSuccessCount < 3) return;
    const roles = [...new Set(input.graph.nodes
      .map((node) => node.config.kind === 'agent_task' || node.config.kind === 'agent_session'
        ? String((node.config as { agentRole?: string }).agentRole ?? '').trim().toLowerCase()
        : '')
      .filter(Boolean))];
    for (const role of roles) {
      const key = `role-pattern:${role}:${input.context.workflowId}:${input.semanticHash}`;
      this.promoteScope({
        workspaceId: input.context.workspaceId,
        workflowId: input.context.workflowId,
        appId: input.context.appId ?? null,
        fromScopeType: 'workflow',
        fromScopeId: input.context.workflowId,
        toScopeType: 'role',
        toScopeId: role,
        key,
        title: `${role} pattern proven in ${input.objective ?? input.context.workflowId}`,
        content: describeGraphRecipe(input.graph),
        evidence: { runId: input.runId, revisionId: input.revisionId, semanticHash: input.semanticHash },
        confidence: 0.86,
      });
      const distinctWorkflows = new Set(this.db.select({
        workflowId: schema.workflowExperiences.workflowId,
      }).from(schema.workflowExperiences).where(and(
        eq(schema.workflowExperiences.workspaceId, input.context.workspaceId),
        eq(schema.workflowExperiences.scopeType, 'role'),
        eq(schema.workflowExperiences.scopeId, role),
        eq(schema.workflowExperiences.status, 'active'),
      )).all().map((row) => row.workflowId).filter(Boolean));
      if (distinctWorkflows.size < 2 || !this.specialistMind) continue;
      const mindMarker = this.findByKey(
        input.context.workspaceId,
        'role',
        role,
        `mind-promoted:${role}:${input.semanticHash}`,
        'active',
      );
      if (mindMarker) continue;
      await this.specialistMind.addTextSource(input.context.workspaceId, role, {
        kind: 'run',
        title: `Verified workflow experience: ${input.objective ?? input.context.workflowId}`,
        content: describeGraphRecipe(input.graph),
        trust: 'verified_execution',
      });
      this.promoteScope({
        workspaceId: input.context.workspaceId,
        workflowId: input.context.workflowId,
        appId: input.context.appId ?? null,
        fromScopeType: 'role',
        fromScopeId: role,
        toScopeType: 'role',
        toScopeId: role,
        key: `mind-promoted:${role}:${input.semanticHash}`,
        title: `Promoted to ${role} specialist mind`,
        content: describeGraphRecipe(input.graph),
        evidence: { distinctWorkflowCount: distinctWorkflows.size },
        confidence: 0.9,
      });
    }
  }
}

function scopeRank(scope: string): number {
  return ({ workflow: 0, agent: 1, role: 2, app: 3, workspace: 4 } as Record<string, number>)[scope] ?? 9;
}

function applies(scopeType: string, scopeId: string, context: WorkflowExperienceContext): boolean {
  if (scopeType === 'workspace') return scopeId === context.workspaceId;
  if (scopeType === 'app') return Boolean(context.appId && scopeId === context.appId);
  if (scopeType === 'workflow') return scopeId === context.workflowId;
  if (scopeType === 'role') return Boolean(context.specialistRole && scopeId === context.specialistRole.toLowerCase());
  if (scopeType === 'agent') return Boolean(context.agentId && scopeId === context.agentId);
  return false;
}

function experienceContent(row: typeof schema.workflowExperiences.$inferSelect): string {
  return [
    row.rootCause ? `Root cause: ${row.rootCause}` : '',
    row.repairSummary ? `Implementation: ${row.repairSummary}` : '',
    row.status === 'anti_pattern' ? 'Do not repeat this rejected repair.' : '',
  ].filter(Boolean).join(' ');
}

function describeGraphRecipe(graph: WorkflowGraph): string {
  const nodes = graph.nodes.map((node) => `${node.id}:${node.config.kind}`).join(' -> ');
  const contracts = [
    graph.inputContract ? `input contract ${Object.keys(graph.inputContract).join(', ')}` : '',
    graph.outputContract ? `output contract ${Object.keys(graph.outputContract).join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return `Known-good execution structure: ${nodes || 'empty graph'}.${contracts ? ` ${contracts}.` : ''}`.slice(0, 4000);
}

function redactInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = /token|secret|password|credential|api.?key/i.test(key)
      ? '[REDACTED]'
      : typeof value === 'string'
        ? value.slice(0, 500)
        : value;
  }
  return out;
}

function jsonStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
