import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type ChatPlan,
  type PlanDecisionRecord,
  type PlanDeviationKind,
  type PlanDeviationRecord,
  type PlanEdge,
  type PlanEvidenceRef,
  type PlanNode,
  type PlanPatch,
  type PlanStage,
  type PlanStatus,
  type PlanVerification,
  type PlanVerificationCriterion,
  type RealtimeEventName,
  type WorkStepStatus,
  projectPlanSteps,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';

const STAGES: PlanStage[] = ['goal', 'decisions', 'build', 'verify'];
const STAGE_X: Record<PlanStage, number> = {
  goal: 40,
  decisions: 360,
  build: 680,
  verify: 1000,
  activate: 1320,
};

function titleFromObjective(objective: string): string {
  const line = objective.trim().split(/\r?\n/)[0] ?? 'Implementation plan';
  return line.length > 68 ? `${line.slice(0, 65)}...` : line;
}

function resourceKinds(objective: string): string[] {
  const candidates = ['workflow', 'agent', 'task', 'issue', 'ability', 'extension', 'app', 'listener', 'schedule'];
  const lower = objective.toLowerCase();
  return candidates.filter((kind) => lower.includes(kind));
}

function node(
  kind: PlanNode['kind'],
  stage: PlanStage,
  index: number,
  title: string,
  summary: string,
  extra: Partial<PlanNode> = {},
): PlanNode {
  return {
    id: randomUUID(),
    kind,
    stage,
    title,
    summary,
    status: kind === 'decision' ? 'unresolved' : 'ready',
    position: { x: STAGE_X[stage], y: 72 + index * 164 },
    ...extra,
  };
}

export interface TaskCompletionJudge {
  (args: {
    plan: ChatPlan;
    output: unknown;
    evidence?: PlanEvidenceRef[];
  }): Promise<Omit<PlanVerification, 'id' | 'verifiedAt'>> | Omit<PlanVerification, 'id' | 'verifiedAt'>;
}

export function generatePlan(args: { conversationId?: string | null; objective: string; previous?: ChatPlan | null }): ChatPlan {
  const now = new Date().toISOString();
  const planId = args.previous?.id ?? randomUUID();
  const objective = args.objective.replace(/^\/plan\b/i, '').trim() || 'Define the objective before execution.';
  const resources = resourceKinds(objective);
  const nodes: PlanNode[] = [
    node('goal', 'goal', 0, titleFromObjective(objective), objective, {
      acceptanceCriteria: ['The requested outcome is delivered and verified.', 'No mutation occurs before approval.'],
      estimate: { reversible: true },
    }),
  ];

  if (/\b(or|choose|compare|approach|option)\b/i.test(objective)) {
    nodes.push(node('decision', 'decisions', 0, 'Choose implementation approach', 'Select the approach before dependent work begins.', {
      required: true,
      options: [
        { id: 'recommended', label: 'Recommended approach', description: 'Use existing Agentis patterns and resources.', recommended: true },
        { id: 'custom', label: 'Custom approach', description: 'Introduce a purpose-built implementation.' },
      ],
    }));
  }

  const buildItems = resources.length > 0 ? resources : ['implementation'];
  buildItems.forEach((kind, index) => {
    nodes.push(node(kind === 'implementation' ? 'action' : 'resource', 'build', index, `Prepare ${kind}`, `Create or update the ${kind} required for this objective.`, {
      resourceKind: kind === 'implementation' ? undefined : kind,
      estimate: { durationMinutes: 15, reversible: true },
    }));
  });

  nodes.push(node('validation', 'verify', 0, 'Verify the outcome', 'Run focused checks against the goal and acceptance criteria.', {
    acceptanceCriteria: ['Expected behavior passes.', 'Existing behavior remains intact.'],
    estimate: { durationMinutes: 8, reversible: true },
  }));

  const ordered = STAGES.flatMap((stage) => nodes.filter((item) => item.stage === stage));
  const edges: PlanEdge[] = ordered.slice(1).map((target, index) => ({
    id: randomUUID(),
    source: ordered[index]!.id,
    target: target.id,
  }));

  return {
    id: planId,
    conversationId: args.conversationId ?? null,
    runIds: args.previous?.runIds ?? [],
    sessionId: args.previous?.sessionId ?? null,
    version: (args.previous?.version ?? 0) + 1,
    status: nodes.some((item) => item.kind === 'decision' && !item.selectedOptionId) ? 'draft' : 'ready',
    title: titleFromObjective(objective),
    objective,
    summary: `${buildItems.length} implementation area${buildItems.length === 1 ? '' : 's'} and one verification pass.`,
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 0.78, semanticZoom: 'plan' },
    assumptions: ['Existing workspace resources are reused when they satisfy the objective.'],
    acceptanceCriteria: ['The visible version is the version approved for execution.'],
    decisions: args.previous?.decisions ?? [],
    deviations: args.previous?.deviations ?? [],
    verification: args.previous?.verification,
    createdAt: args.previous?.createdAt ?? now,
    updatedAt: now,
  };
}

function workStepToPlanNodeStatus(status: WorkStepStatus): PlanNode['status'] {
  if (status === 'running') return 'running';
  if (status === 'done') return 'completed';
  if (status === 'failed') return 'failed';
  return 'ready';
}

/**
 * Rebuild a plan's build-stage nodes from an ordered list of step labels,
 * preserving prior ids/status where the index still exists (so an in-flight
 * step keeps its `running`/`completed` state across a re-set). Non-build stages
 * (goal/decisions/verify) are left intact and edges are re-threaded in order.
 */
function withBuildSteps(plan: ChatPlan, labels: string[]): ChatPlan {
  const nonBuild = plan.nodes.filter((item) => item.stage !== 'build');
  const priorBuild = plan.nodes.filter((item) => item.stage === 'build');
  const buildNodes = labels.map((label, index) => {
    const prior = priorBuild[index];
    return node('action', 'build', index, label, prior?.summary ?? label, {
      ...(prior ? { id: prior.id, status: prior.status } : {}),
    });
  });
  const merged = [...nonBuild, ...buildNodes];
  const ordered = STAGES.flatMap((stage) => merged.filter((item) => item.stage === stage));
  const edges: PlanEdge[] = ordered.slice(1).map((target, index) => ({
    id: randomUUID(),
    source: ordered[index]!.id,
    target: target.id,
  }));
  return { ...plan, nodes: ordered, edges, updatedAt: new Date().toISOString() };
}

/** Overall plan status implied by its build-step statuses (never un-terminates). */
function planStatusFromSteps(plan: ChatPlan, buildNodes: PlanNode[]): PlanStatus {
  if (plan.status === 'completed' || plan.status === 'failed') return plan.status;
  if (buildNodes.length === 0) return plan.status;
  if (buildNodes.some((item) => item.status === 'failed')) return 'blocked';
  if (buildNodes.every((item) => item.status === 'completed')) return 'completed';
  return 'executing';
}

function applyPatch(plan: ChatPlan, patch: PlanPatch): ChatPlan {
  const removedNodes = new Set(patch.removeNodeIds ?? []);
  const removedEdges = new Set(patch.removeEdgeIds ?? []);
  const updates = new Map((patch.updateNodes ?? []).map((entry) => [entry.id, entry.changes]));
  const nodes = [
    ...plan.nodes
      .filter((item) => !removedNodes.has(item.id))
      .map((item) => ({ ...item, ...(updates.get(item.id) ?? {}) })),
    ...(patch.addNodes ?? []),
  ];
  const nodeIds = new Set(nodes.map((item) => item.id));
  const edges = [
    ...plan.edges.filter((item) =>
      !removedEdges.has(item.id) && nodeIds.has(item.source) && nodeIds.has(item.target)),
    ...(patch.addEdges ?? []),
  ];
  const unresolved = nodes.some((item) => item.required && (
    (item.kind === 'decision' && !item.selectedOptionId)
    || (item.risk === 'high' || item.risk === 'destructive') && !item.acknowledged
  ));
  return {
    ...plan,
    version: plan.version + 1,
    status: unresolved ? 'draft' : 'ready',
    nodes,
    edges,
    viewport: patch.viewport ?? plan.viewport,
    updatedAt: new Date().toISOString(),
  };
}

export class PlanService {
  constructor(private readonly db: AgentisSqliteDb, private readonly bus?: EventBus) {}

  latest(workspaceId: string, conversationId: string): ChatPlan | null {
    const row = this.db
      .select({ content: schema.planVersions.content })
      .from(schema.planVersions)
      .innerJoin(schema.plans, eq(schema.plans.id, schema.planVersions.planId))
      .where(and(eq(schema.plans.workspaceId, workspaceId), eq(schema.plans.conversationId, conversationId)))
      .orderBy(desc(schema.planVersions.version))
      .get();
    return (row?.content as ChatPlan | undefined) ?? null;
  }

  create(workspaceId: string, userId: string, conversationId: string, objective: string): ChatPlan {
    const previous = this.latest(workspaceId, conversationId);
    const plan = generatePlan({ conversationId, objective, previous });
    if (!previous) {
      this.db.insert(schema.plans).values({
        id: plan.id,
        workspaceId,
        conversationId,
        runIds: plan.runIds ?? [],
        sessionId: plan.sessionId ?? null,
        title: plan.title,
        objective: plan.objective,
        status: plan.status,
        activeVersion: plan.version,
        decisions: plan.decisions ?? [],
        deviations: plan.deviations ?? [],
        verification: plan.verification ?? null,
      }).run();
    } else {
      this.db.update(schema.plans).set({
        title: plan.title,
        objective: plan.objective,
        status: plan.status,
        activeVersion: plan.version,
        runIds: plan.runIds ?? [],
        sessionId: plan.sessionId ?? null,
        decisions: plan.decisions ?? [],
        deviations: plan.deviations ?? [],
        verification: plan.verification ?? null,
        updatedAt: plan.updatedAt,
      }).where(eq(schema.plans.id, plan.id)).run();
    }
    this.insertVersion(workspaceId, userId, plan);
    this.publishTaskEvent(workspaceId, previous ? REALTIME_EVENTS.TASK_SPINE_UPDATED : REALTIME_EVENTS.TASK_SPINE_ACCEPTED, plan);
    return plan;
  }

  createTask(args: {
    workspaceId: string;
    userId: string;
    objective: string;
    conversationId?: string | null;
    title?: string;
    acceptanceCriteria?: string[];
    assumptions?: string[];
  }): ChatPlan {
    const previous = args.conversationId ? this.latest(args.workspaceId, args.conversationId) : null;
    const generated = generatePlan({ conversationId: args.conversationId ?? null, objective: args.objective, previous });
    const plan: ChatPlan = {
      ...generated,
      title: args.title ?? generated.title,
      acceptanceCriteria: args.acceptanceCriteria ?? generated.acceptanceCriteria,
      assumptions: args.assumptions ?? generated.assumptions,
    };
    if (!previous) {
      this.db.insert(schema.plans).values({
        id: plan.id,
        workspaceId: args.workspaceId,
        conversationId: plan.conversationId ?? null,
        runIds: [],
        sessionId: null,
        title: plan.title,
        objective: plan.objective,
        status: plan.status,
        activeVersion: plan.version,
        decisions: [],
        deviations: [],
        verification: plan.verification ?? null,
      }).run();
    } else {
      this.syncTopRow(args.workspaceId, plan);
    }
    this.insertVersion(args.workspaceId, args.userId, plan);
    this.publishTaskEvent(
      args.workspaceId,
      previous ? REALTIME_EVENTS.TASK_SPINE_UPDATED : REALTIME_EVENTS.TASK_SPINE_ACCEPTED,
      plan,
    );
    return plan;
  }

  /**
   * Set the linear checklist the operator sees (the StepTrack). Creates the
   * spine row if one isn't bound yet, so an agent can call this directly without
   * a separate accept. Emits TASK_SPINE_UPDATED so chat / Live Workspace /
   * channels all pick up the same steps.
   */
  setSteps(workspaceId: string, userId: string, args: {
    planId?: string;
    conversationId?: string | null;
    title?: string;
    objective?: string;
    agentId?: string;
    steps: string[];
  }): ChatPlan {
    const labels = args.steps.map((step) => step.trim()).filter(Boolean);
    let plan = args.planId
      ? this.byId(workspaceId, args.planId)
      : (args.conversationId ? this.latest(workspaceId, args.conversationId) : null);
    if (!plan) {
      plan = this.createTask({
        workspaceId,
        userId,
        conversationId: args.conversationId ?? null,
        objective: args.objective ?? args.title ?? labels[0] ?? 'Task',
        ...(args.title ? { title: args.title } : {}),
      });
    }
    const next = withBuildSteps(plan, labels);
    const buildNodes = next.nodes.filter((item) => item.stage === 'build');
    const revised = this.revise(workspaceId, userId, {
      ...next,
      status: planStatusFromSteps(next, buildNodes),
    });
    this.publishTaskEvent(workspaceId, REALTIME_EVENTS.TASK_SPINE_UPDATED, revised, args.agentId ? { agentId: args.agentId } : {});
    return revised;
  }

  /**
   * Advance one step of the checklist. With no target, marks the active (or next
   * pending) step `done` and auto-starts the following step — the common
   * "finished a step" call. `status: 'failed'` marks it failed and blocks.
   */
  advanceStep(workspaceId: string, userId: string, args: {
    planId?: string;
    conversationId?: string | null;
    agentId?: string;
    index?: number;
    label?: string;
    status?: WorkStepStatus;
  }): ChatPlan {
    const plan = args.planId
      ? this.byId(workspaceId, args.planId)
      : (args.conversationId ? this.latest(workspaceId, args.conversationId) : null);
    if (!plan) throw new AgentisError('RESOURCE_NOT_FOUND', 'No task spine to advance.');
    const buildNodes = plan.nodes.filter((item) => item.stage === 'build');
    if (buildNodes.length === 0) {
      throw new AgentisError('VALIDATION_FAILED', 'Task spine has no steps; call agentis.task.set_steps first.');
    }
    const status = args.status ?? 'done';
    let targetIndex: number;
    if (typeof args.index === 'number') {
      targetIndex = args.index;
    } else if (args.label) {
      targetIndex = buildNodes.findIndex((item) => item.title.toLowerCase() === args.label!.trim().toLowerCase());
    } else {
      const running = buildNodes.findIndex((item) => item.status === 'running');
      targetIndex = running >= 0
        ? running
        : buildNodes.findIndex((item) => item.status !== 'completed' && item.status !== 'failed');
    }
    const target = buildNodes[targetIndex];
    if (!target) throw new AgentisError('VALIDATION_FAILED', 'Could not resolve the step to advance.');
    const nodeStatus = workStepToPlanNodeStatus(status);
    let nodes = plan.nodes.map((item) => (item.id === target.id ? { ...item, status: nodeStatus } : item));
    if (status === 'done') {
      const next = buildNodes[targetIndex + 1];
      if (next && next.status !== 'completed' && next.status !== 'failed') {
        nodes = nodes.map((item) => (item.id === next.id ? { ...item, status: 'running' as const } : item));
      }
    }
    const updated: ChatPlan = { ...plan, nodes, updatedAt: new Date().toISOString() };
    const revised = this.revise(workspaceId, userId, {
      ...updated,
      status: planStatusFromSteps(updated, nodes.filter((item) => item.stage === 'build')),
    });
    this.publishTaskEvent(workspaceId, REALTIME_EVENTS.TASK_SPINE_UPDATED, revised, args.agentId ? { agentId: args.agentId } : {});
    return revised;
  }

  patch(workspaceId: string, userId: string, planId: string, patch: PlanPatch): ChatPlan {
    const current = this.byId(workspaceId, planId);
    const next = applyPatch(current, patch);
    this.syncTopRow(workspaceId, next);
    this.insertVersion(workspaceId, userId, next);
    this.syncMessage(next);
    this.publishTaskEvent(workspaceId, REALTIME_EVENTS.TASK_SPINE_UPDATED, next);
    return next;
  }

  approve(workspaceId: string, planId: string, version: number): ChatPlan {
    const current = this.byId(workspaceId, planId);
    if (current.status === 'approved' && current.approvedVersion === version) return current;
    if (current.version !== version) {
      throw new AgentisError('RESOURCE_CONFLICT', 'Approval must target the visible plan version.', {
        remediation: 'Refresh the plan and approve the latest version.',
        details: { currentVersion: current.version, requestedVersion: version },
      });
    }
    const blocked = current.nodes.some((item) => item.required && (
      (item.kind === 'decision' && !item.selectedOptionId)
      || ((item.risk === 'high' || item.risk === 'destructive') && !item.acknowledged)
    ));
    if (blocked) {
      throw new AgentisError('VALIDATION_FAILED', 'Resolve required decisions and risk acknowledgements before approval.');
    }
    const approved = { ...current, status: 'approved' as const, approvedVersion: version, updatedAt: new Date().toISOString() };
    this.db.update(schema.plans).set({
      status: approved.status,
      approvedVersion: version,
      updatedAt: approved.updatedAt,
    }).where(and(eq(schema.plans.id, planId), eq(schema.plans.workspaceId, workspaceId))).run();
    this.db.update(schema.planVersions).set({ content: approved }).where(and(
      eq(schema.planVersions.planId, planId),
      eq(schema.planVersions.version, version),
    )).run();
    this.syncMessage(approved);
    this.publishTaskEvent(workspaceId, REALTIME_EVENTS.TASK_SPINE_UPDATED, approved);
    return approved;
  }

  get(workspaceId: string, planId: string): ChatPlan {
    return this.byId(workspaceId, planId);
  }

  findByRun(workspaceId: string, runId: string): ChatPlan | null {
    const rows = this.db
      .select({ id: schema.plans.id, runIds: schema.plans.runIds })
      .from(schema.plans)
      .where(eq(schema.plans.workspaceId, workspaceId))
      .all();
    const row = rows.find((item) => Array.isArray(item.runIds) && (item.runIds as unknown[]).includes(runId));
    return row ? this.byId(workspaceId, row.id) : null;
  }

  findBySession(workspaceId: string, sessionId: string): ChatPlan | null {
    const row = this.db
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(and(eq(schema.plans.workspaceId, workspaceId), eq(schema.plans.sessionId, sessionId)))
      .get();
    return row ? this.byId(workspaceId, row.id) : null;
  }

  bindRun(workspaceId: string, userId: string, planId: string, runId: string): ChatPlan {
    const current = this.byId(workspaceId, planId);
    const runIds = Array.from(new Set([...(current.runIds ?? []), runId]));
    const status = terminalStatus(current.status) ? current.status : 'executing';
    const next = this.revise(workspaceId, userId, { ...current, runIds, status, updatedAt: new Date().toISOString() });
    this.publishTaskEvent(workspaceId, REALTIME_EVENTS.TASK_SPINE_BOUND, next, { binding: 'run', runId });
    return next;
  }

  bindSession(workspaceId: string, userId: string, planId: string, sessionId: string): ChatPlan {
    const current = this.byId(workspaceId, planId);
    const status = terminalStatus(current.status) ? current.status : 'executing';
    const next = this.revise(workspaceId, userId, { ...current, sessionId, status, updatedAt: new Date().toISOString() });
    this.publishTaskEvent(workspaceId, REALTIME_EVENTS.TASK_SPINE_BOUND, next, { binding: 'session', sessionId });
    return next;
  }

  setStatus(workspaceId: string, userId: string, planId: string, status: PlanStatus): ChatPlan {
    const current = this.byId(workspaceId, planId);
    const next = this.revise(workspaceId, userId, { ...current, status, updatedAt: new Date().toISOString() });
    this.publishTaskEvent(workspaceId, eventForStatus(status), next);
    return next;
  }

  recordDecision(workspaceId: string, userId: string, planId: string, args: {
    summary: string;
    rationale?: string;
    actorId?: string;
    runId?: string;
    sessionId?: string;
    nodeId?: string;
    evidence?: PlanEvidenceRef[];
  }): ChatPlan {
    const current = this.byId(workspaceId, planId);
    const record: PlanDecisionRecord = {
      id: randomUUID(),
      summary: args.summary.trim(),
      ...(args.rationale ? { rationale: args.rationale.trim() } : {}),
      ...(args.actorId ? { actorId: args.actorId } : {}),
      ...(args.runId ? { runId: args.runId } : {}),
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.nodeId ? { nodeId: args.nodeId } : {}),
      ...(args.evidence ? { evidence: args.evidence } : {}),
      createdAt: new Date().toISOString(),
    };
    if (!record.summary) throw new AgentisError('VALIDATION_FAILED', 'Decision summary is required.');
    const next = this.revise(workspaceId, userId, {
      ...current,
      decisions: [...(current.decisions ?? []), record],
      updatedAt: record.createdAt,
    });
    this.publishTaskEvent(workspaceId, REALTIME_EVENTS.TASK_SPINE_DECISION_RECORDED, next, { decision: record });
    return next;
  }

  recordDeviation(workspaceId: string, userId: string, planId: string, args: {
    kind: PlanDeviationKind;
    reason: string;
    proposed?: string;
    actorId?: string;
    runId?: string;
    sessionId?: string;
    nodeId?: string;
    evidence?: PlanEvidenceRef[];
  }): ChatPlan {
    const current = this.byId(workspaceId, planId);
    const now = new Date().toISOString();
    const record: PlanDeviationRecord = {
      id: randomUUID(),
      kind: args.kind,
      reason: args.reason.trim(),
      ...(args.proposed ? { proposed: args.proposed.trim() } : {}),
      ...(args.actorId ? { actorId: args.actorId } : {}),
      ...(args.runId ? { runId: args.runId } : {}),
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.nodeId ? { nodeId: args.nodeId } : {}),
      ...(args.evidence ? { evidence: args.evidence } : {}),
      createdAt: now,
    };
    if (!record.reason) throw new AgentisError('VALIDATION_FAILED', 'Deviation reason is required.');
    const next = this.revise(workspaceId, userId, {
      ...current,
      status: record.kind === 'blocked' ? 'blocked' : current.status,
      deviations: [...(current.deviations ?? []), record],
      updatedAt: now,
    });
    this.publishTaskEvent(
      workspaceId,
      record.kind === 'blocked' ? REALTIME_EVENTS.TASK_SPINE_BLOCKED : REALTIME_EVENTS.TASK_SPINE_DEVIATION_RECORDED,
      next,
      { deviation: record },
    );
    return next;
  }

  async verifyCompletion(workspaceId: string, userId: string, planId: string, args: {
    output: unknown;
    evidence?: PlanEvidenceRef[];
    judge?: TaskCompletionJudge;
  }): Promise<{ plan: ChatPlan; passed: boolean; verification: PlanVerification }> {
    const verifying = this.setStatus(workspaceId, userId, planId, 'verifying');
    const judged = args.judge
      ? await args.judge({ plan: verifying, output: args.output, evidence: args.evidence })
      : deterministicCompletionJudge(verifying, args.output, args.evidence);
    const verification: PlanVerification = {
      id: randomUUID(),
      status: judged.status,
      criteria: judged.criteria,
      output: args.output,
      verifiedAt: new Date().toISOString(),
      verifier: judged.verifier,
    };
    const passed = verification.status === 'passed' && verification.criteria.every((criterion) => criterion.passed);
    const plan = this.revise(workspaceId, userId, {
      ...verifying,
      status: passed ? 'completed' : 'blocked',
      verification,
      updatedAt: verification.verifiedAt,
    });
    this.publishTaskEvent(
      workspaceId,
      passed ? REALTIME_EVENTS.TASK_SPINE_VERIFIED : REALTIME_EVENTS.TASK_SPINE_BLOCKED,
      plan,
      { verification, passed },
    );
    return { plan, passed, verification };
  }

  emitRedirect(workspaceId: string, plan: ChatPlan, args: {
    instruction: string;
    reason?: string;
    injected?: boolean;
    actorId?: string;
  }): void {
    this.publishTaskEvent(workspaceId, REALTIME_EVENTS.TASK_SPINE_REDIRECTED, plan, {
      instruction: args.instruction,
      reason: args.reason,
      injected: Boolean(args.injected),
      actorId: args.actorId,
    });
  }

  attachMessage(workspaceId: string, plan: ChatPlan, messageId: string): ChatPlan {
    const attached = { ...plan, messageId };
    this.db.update(schema.plans).set({ messageId }).where(and(
      eq(schema.plans.id, plan.id),
      eq(schema.plans.workspaceId, workspaceId),
    )).run();
    this.db.update(schema.planVersions).set({ content: attached }).where(and(
      eq(schema.planVersions.planId, plan.id),
      eq(schema.planVersions.version, plan.version),
    )).run();
    return attached;
  }

  private byId(workspaceId: string, planId: string): ChatPlan {
    const row = this.db.select({ content: schema.planVersions.content })
      .from(schema.planVersions)
      .innerJoin(schema.plans, eq(schema.plans.id, schema.planVersions.planId))
      .where(and(eq(schema.plans.workspaceId, workspaceId), eq(schema.plans.id, planId)))
      .orderBy(desc(schema.planVersions.version))
      .get();
    if (!row) throw new Error('Plan not found.');
    return row.content as ChatPlan;
  }

  private insertVersion(workspaceId: string, userId: string, plan: ChatPlan): void {
    this.db.insert(schema.planVersions).values({
      id: randomUUID(),
      workspaceId,
      planId: plan.id,
      version: plan.version,
      content: plan,
      createdBy: userId,
    }).run();
  }

  private revise(workspaceId: string, userId: string, plan: ChatPlan): ChatPlan {
    const next = { ...plan, version: plan.version + 1 };
    this.syncTopRow(workspaceId, next);
    this.insertVersion(workspaceId, userId, next);
    this.syncMessage(next);
    return next;
  }

  private syncTopRow(workspaceId: string, plan: ChatPlan): void {
    this.db.update(schema.plans).set({
      conversationId: plan.conversationId ?? null,
      messageId: plan.messageId ?? null,
      runIds: plan.runIds ?? [],
      sessionId: plan.sessionId ?? null,
      title: plan.title,
      objective: plan.objective,
      status: plan.status,
      activeVersion: plan.version,
      approvedVersion: plan.approvedVersion ?? null,
      decisions: plan.decisions ?? [],
      deviations: plan.deviations ?? [],
      verification: plan.verification ?? null,
      updatedAt: plan.updatedAt,
    }).where(and(eq(schema.plans.id, plan.id), eq(schema.plans.workspaceId, workspaceId))).run();
  }

  private syncMessage(plan: ChatPlan): void {
    if (!plan.messageId) return;
    const row = this.db.select().from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.id, plan.messageId)).get();
    if (!row) return;
    const metadata = row.metadata && typeof row.metadata === 'object'
      ? row.metadata as Record<string, unknown>
      : {};
    this.db.update(schema.conversationMessages).set({ metadata: { ...metadata, plan } })
      .where(eq(schema.conversationMessages.id, plan.messageId)).run();
  }

  private publishTaskEvent(
    workspaceId: string,
    event: RealtimeEventName,
    plan: ChatPlan,
    extra: Record<string, unknown> = {},
  ): void {
    const runIds = plan.runIds ?? [];
    const stepTrack = projectPlanSteps(plan);
    this.bus?.publish(REALTIME_ROOMS.workspace(workspaceId), event, {
      workspaceId,
      taskId: plan.id,
      planId: plan.id,
      title: plan.title,
      objective: plan.objective,
      status: plan.status,
      version: plan.version,
      steps: stepTrack.steps,
      stepCurrent: stepTrack.current,
      stepTotal: stepTrack.total,
      conversationId: plan.conversationId ?? undefined,
      runIds,
      runId: runIds[runIds.length - 1],
      sessionId: plan.sessionId ?? undefined,
      decisionsCount: plan.decisions?.length ?? 0,
      deviationsCount: plan.deviations?.length ?? 0,
      verificationStatus: plan.verification?.status,
      updatedAt: plan.updatedAt,
      ...extra,
    });
  }
}

function terminalStatus(status: PlanStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function eventForStatus(status: PlanStatus): RealtimeEventName {
  if (status === 'verifying') return REALTIME_EVENTS.TASK_SPINE_VERIFYING;
  if (status === 'completed') return REALTIME_EVENTS.TASK_SPINE_COMPLETED;
  if (status === 'blocked') return REALTIME_EVENTS.TASK_SPINE_BLOCKED;
  if (status === 'failed') return REALTIME_EVENTS.TASK_SPINE_FAILED;
  return REALTIME_EVENTS.TASK_SPINE_UPDATED;
}

function deterministicCompletionJudge(
  plan: ChatPlan,
  output: unknown,
  evidence?: PlanEvidenceRef[],
): Omit<PlanVerification, 'id' | 'verifiedAt'> {
  const criteria = plan.acceptanceCriteria?.length
    ? plan.acceptanceCriteria
    : ['The agent returned a non-empty output.'];
  const hasOutput = output !== null
    && output !== undefined
    && (!(typeof output === 'string') || output.trim().length > 0)
    && (!(typeof output === 'object') || JSON.stringify(output) !== '{}');
  const verdicts: PlanVerificationCriterion[] = criteria.map((criterion) => ({
    criterion,
    passed: hasOutput,
    reason: hasOutput
      ? 'The completion supplied output for operator review; no model judge was configured for deeper semantic grading.'
      : 'The completion output was empty.',
    ...(evidence ? { evidence } : {}),
  }));
  return {
    status: verdicts.every((criterion) => criterion.passed) ? 'passed' : 'failed',
    criteria: verdicts,
    verifier: 'deterministic',
  };
}
