import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type AppBlueprint,
  type BlueprintValidationIssue,
  type BlueprintValidationResult,
  type BuildDiagnostic,
  type BuildEvidence,
  type BuildSession,
  type BuildSessionStatus,
  type BuildStage,
  type WorkspaceSnapshot,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';

type BlueprintTopology = Pick<
  AppBlueprint,
  'roles' | 'swarms' | 'workflows' | 'collections' | 'interfaces'
>;

export interface CreateBuildSessionInput {
  workspaceId: string;
  userId: string;
  ownerAgentId?: string | null;
  conversationId?: string | null;
  appId?: string | null;
  name: string;
  intent: string;
  topology: BlueprintTopology;
  acceptanceCriteria: string[];
  capabilityCatalogHash?: string | null;
}

function semanticKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'app';
}

function ordinalFeatureName(value: string): boolean {
  return /(?:^|\s)(?:v|version)\s*\d+(?:\s|$|[.:_-])/i.test(value.trim());
}

function duplicateIssues(
  values: Array<{ key: string }>,
  path: string,
): BlueprintValidationIssue[] {
  const seen = new Set<string>();
  const issues: BlueprintValidationIssue[] = [];
  values.forEach((value, index) => {
    const key = value.key.trim();
    if (seen.has(key)) {
      issues.push({ code: 'DUPLICATE_KEY', path: `${path}.${index}.key`, message: `Duplicate semantic key '${key}'.` });
    }
    seen.add(key);
  });
  return issues;
}

function dependencyCycle(workflows: AppBlueprint['workflows']): string[] | null {
  const graph = new Map(workflows.map((workflow) => [workflow.key, workflow.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    if (visiting.has(key)) {
      const start = stack.indexOf(key);
      return [...stack.slice(start), key];
    }
    if (visited.has(key)) return null;
    visiting.add(key);
    stack.push(key);
    for (const dependency of graph.get(key) ?? []) {
      if (!graph.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(key);
    visited.add(key);
    return null;
  };
  for (const key of graph.keys()) {
    const cycle = visit(key);
    if (cycle) return cycle;
  }
  return null;
}

/** Pure blueprint gate shared by the tool handler and tests. */
export function validateAppBlueprint(input: {
  name: string;
  topology: BlueprintTopology;
  acceptanceCriteria: string[];
}): BlueprintValidationResult {
  const { topology } = input;
  const issues: BlueprintValidationIssue[] = [];
  if (
    topology.workflows.length === 0
    && topology.collections.length === 0
    && topology.interfaces.length === 0
  ) {
    issues.push({
      code: 'EMPTY_BLUEPRINT',
      path: 'topology',
      message: 'A new App needs at least one workflow, collection, or interface before materialization.',
    });
  }
  if (input.acceptanceCriteria.length === 0) {
    issues.push({
      code: 'MISSING_ACCEPTANCE',
      path: 'acceptanceCriteria',
      message: 'Define at least one App-level acceptance criterion before materialization.',
    });
  }
  issues.push(...duplicateIssues(topology.roles, 'roles'));
  issues.push(...duplicateIssues(topology.swarms, 'swarms'));
  issues.push(...duplicateIssues(topology.workflows, 'workflows'));
  issues.push(...duplicateIssues(topology.collections, 'collections'));
  issues.push(...duplicateIssues(topology.interfaces, 'interfaces'));

  const workflowKeys = new Set(topology.workflows.map((workflow) => workflow.key));
  const roleKeys = new Set(topology.roles.map((role) => role.key));
  const swarmKeys = new Set(topology.swarms.map((swarm) => swarm.key));
  topology.workflows.forEach((workflow, index) => {
    workflow.dependsOn.forEach((dependency) => {
      if (!workflowKeys.has(dependency)) {
        issues.push({
          code: 'UNKNOWN_DEPENDENCY',
          path: `workflows.${index}.dependsOn`,
          message: `Workflow '${workflow.key}' depends on unknown workflow '${dependency}'.`,
        });
      }
    });
    if (workflow.acceptanceCriteria.length === 0) {
      issues.push({
        code: 'MISSING_ACCEPTANCE',
        path: `workflows.${index}.acceptanceCriteria`,
        message: `Workflow '${workflow.key}' needs an evidence-checkable acceptance criterion.`,
      });
    }
    if (workflow.ownerRoleKey && !roleKeys.has(workflow.ownerRoleKey)) {
      issues.push({
        code: 'UNKNOWN_ROLE',
        path: `workflows.${index}.ownerRoleKey`,
        message: `Workflow '${workflow.key}' references unknown durable role '${workflow.ownerRoleKey}'.`,
      });
    }
    if (workflow.swarmKey && !swarmKeys.has(workflow.swarmKey)) {
      issues.push({
        code: 'UNKNOWN_SWARM',
        path: `workflows.${index}.swarmKey`,
        message: `Workflow '${workflow.key}' references unknown swarm '${workflow.swarmKey}'.`,
      });
    }
  });
  const cycle = dependencyCycle(topology.workflows);
  if (cycle) {
    issues.push({
      code: 'DEPENDENCY_CYCLE',
      path: 'workflows',
      message: `Workflow dependency cycle: ${cycle.join(' -> ')}.`,
    });
  }
  const named = [
    input.name,
    ...topology.roles.flatMap((role) => [role.key, role.role, role.name ?? '']),
    ...topology.swarms.flatMap((swarm) => [swarm.key, swarm.workerRole]),
    ...topology.workflows.flatMap((workflow) => [workflow.key, workflow.title]),
    ...topology.interfaces.flatMap((item) => [item.key, item.title]),
  ];
  named.forEach((value) => {
    if (value && ordinalFeatureName(value)) {
      issues.push({
        code: 'ORDINAL_FEATURE_NAME',
        path: 'name',
        message: `Use a stable semantic name instead of '${value}'. Revisions are stored separately.`,
      });
    }
  });
  return { valid: issues.length === 0, issues };
}

export class BuildSessionService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus?: EventBus,
  ) {}

  captureWorkspace(workspaceId: string, capabilityCatalogHash?: string | null): WorkspaceSnapshot {
    const apps = this.db.select({
      id: schema.apps.id,
      name: schema.apps.name,
      status: schema.apps.status,
      ownerAgentId: schema.apps.ownerAgentId,
    }).from(schema.apps).where(eq(schema.apps.workspaceId, workspaceId)).all();
    const workflows = this.db.select({
      id: schema.workflows.id,
      name: schema.workflows.title,
      status: schema.workflows.trustState,
      appId: schema.workflows.appId,
      ownerAgentId: schema.workflows.ownerAgentId,
      revisionId: schema.workflows.candidateRevisionId,
    }).from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all();
    const agents = this.db.select({
      id: schema.agents.id,
      name: schema.agents.name,
      status: schema.agents.status,
      kind: schema.agents.adapterType,
    }).from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).all();
    const extensions = this.db.select({
      id: schema.extensions.id,
      name: schema.extensions.name,
      status: schema.extensions.runtime,
      kind: schema.extensions.runtime,
    }).from(schema.extensions).where(eq(schema.extensions.workspaceId, workspaceId)).all();
    const knowledgeBases = this.db.select({
      id: schema.knowledgeBases.id,
      name: schema.knowledgeBases.name,
      appId: schema.knowledgeBases.scopeId,
    }).from(schema.knowledgeBases).where(eq(schema.knowledgeBases.workspaceId, workspaceId)).all();
    return {
      workspaceId,
      capturedAt: new Date().toISOString(),
      capabilityCatalogHash: capabilityCatalogHash ?? null,
      apps,
      workflows,
      agents,
      extensions,
      knowledgeBases,
    };
  }

  create(input: CreateBuildSessionInput): { blueprint: AppBlueprint; session: BuildSession } {
    const key = semanticKey(input.name);
    const previous = this.db.select({ revision: schema.appBlueprints.revision })
      .from(schema.appBlueprints)
      .where(and(eq(schema.appBlueprints.workspaceId, input.workspaceId), eq(schema.appBlueprints.semanticKey, key)))
      .orderBy(desc(schema.appBlueprints.revision))
      .get();
    const revision = (previous?.revision ?? 0) + 1;
    const validation = validateAppBlueprint({
      name: input.name,
      topology: input.topology,
      acceptanceCriteria: input.acceptanceCriteria,
    });
    const now = new Date().toISOString();
    const blueprintId = randomUUID();
    const sessionId = randomUUID();
    const snapshot = this.captureWorkspace(input.workspaceId, input.capabilityCatalogHash);
    const evidence: BuildEvidence[] = [{
      id: randomUUID(),
      kind: 'snapshot',
      label: 'Workspace inventory captured before planning',
      at: snapshot.capturedAt,
      payload: {
        capabilityCatalogHash: snapshot.capabilityCatalogHash,
        counts: {
          apps: snapshot.apps.length,
          workflows: snapshot.workflows.length,
          agents: snapshot.agents.length,
          extensions: snapshot.extensions.length,
          knowledgeBases: snapshot.knowledgeBases.length,
        },
      },
    }];
    const diagnostic: BuildDiagnostic | null = validation.valid ? null : {
      code: 'BLUEPRINT_VALIDATION_FAILED',
      message: validation.issues.map((issue) => issue.message).join(' '),
      stage: 'validate',
      retryable: true,
      remediation: 'Repair the blueprint issues and call agentis.app.plan again. No App was materialized.',
    };

    this.db.transaction((tx) => {
      tx.insert(schema.appBlueprints).values({
        id: blueprintId,
        workspaceId: input.workspaceId,
        appId: input.appId ?? null,
        semanticKey: key,
        name: input.name,
        intent: input.intent,
        revision,
        status: validation.valid ? 'validated' : 'rejected',
        topology: input.topology,
        acceptanceCriteria: input.acceptanceCriteria,
        validation,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      }).run();
      tx.insert(schema.buildSessions).values({
        id: sessionId,
        workspaceId: input.workspaceId,
        blueprintId,
        appId: input.appId ?? null,
        conversationId: input.conversationId ?? null,
        ownerAgentId: input.ownerAgentId ?? null,
        stage: validation.valid ? 'materialize' : 'validate',
        status: validation.valid ? 'validated' : 'blocked',
        snapshot,
        evidence,
        diagnostic,
        repairAttempts: 0,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      }).run();
    });
    const result = { blueprint: this.getBlueprint(input.workspaceId, blueprintId), session: this.get(input.workspaceId, sessionId) };
    this.publish(result.session);
    return result;
  }

  bindApp(workspaceId: string, sessionId: string, appId: string): BuildSession {
    const current = this.get(workspaceId, sessionId);
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.update(schema.appBlueprints).set({ appId, status: 'materializing', updatedAt: now })
        .where(and(eq(schema.appBlueprints.id, current.blueprintId), eq(schema.appBlueprints.workspaceId, workspaceId))).run();
      tx.update(schema.buildSessions).set({ appId, stage: 'materialize', status: 'running', updatedAt: now })
        .where(and(eq(schema.buildSessions.id, sessionId), eq(schema.buildSessions.workspaceId, workspaceId))).run();
    });
    const next = this.get(workspaceId, sessionId);
    this.publish(next);
    return next;
  }

  settleAppVerification(input: {
    workspaceId: string;
    appId: string;
    passed: boolean;
    summary: string;
    payload?: unknown;
    /** True only when verification actually ran the bounded deterministic repair pass. */
    repairAttempted?: boolean;
  }): BuildSession | null {
    const current = this.latestForApp(input.workspaceId, input.appId);
    if (!current || current.status === 'completed') return current;
    const now = new Date().toISOString();
    const evidence = [...current.evidence, {
      id: randomUUID(),
      kind: 'verification' as const,
      label: input.summary,
      at: now,
      resourceType: 'app',
      resourceId: input.appId,
      payload: input.payload,
    }];
    const repairAttempts = input.repairAttempted
      ? Math.min(current.repairAttempts + 1, 1)
      : current.repairAttempts;
    const hasRepairBudget = repairAttempts < 1;
    const diagnostic: BuildDiagnostic | null = input.passed ? null : {
      code: 'APP_VERIFICATION_BLOCKED',
      message: input.summary,
      stage: 'verify',
      resourceType: 'app',
      resourceId: input.appId,
      retryable: hasRepairBudget,
      remediation: hasRepairBudget
        ? 'Apply the deterministic repair plan once, then verify the App again.'
        : 'The bounded repair attempt is exhausted. Operator input is required.',
    };
    const status: BuildSessionStatus = input.passed ? 'completed' : 'blocked';
    this.db.transaction((tx) => {
      tx.update(schema.buildSessions).set({
        stage: input.passed ? 'deliver' : 'repair',
        status,
        evidence,
        diagnostic,
        completedAt: input.passed ? now : null,
        repairAttempts,
        updatedAt: now,
      }).where(and(eq(schema.buildSessions.id, current.id), eq(schema.buildSessions.workspaceId, input.workspaceId))).run();
      tx.update(schema.appBlueprints).set({
        status: input.passed ? 'verified' : 'materializing',
        updatedAt: now,
      }).where(eq(schema.appBlueprints.id, current.blueprintId)).run();
    });
    const next = this.get(input.workspaceId, current.id);
    this.publish(next);
    return next;
  }

  get(workspaceId: string, sessionId: string): BuildSession {
    const row = this.db.select().from(schema.buildSessions)
      .where(and(eq(schema.buildSessions.workspaceId, workspaceId), eq(schema.buildSessions.id, sessionId))).get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `build session not found: ${sessionId}`);
    return this.presentSession(row);
  }

  getBlueprint(workspaceId: string, blueprintId: string): AppBlueprint {
    const row = this.db.select().from(schema.appBlueprints)
      .where(and(eq(schema.appBlueprints.workspaceId, workspaceId), eq(schema.appBlueprints.id, blueprintId))).get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `App blueprint not found: ${blueprintId}`);
    const topology = row.topology as BlueprintTopology;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      appId: row.appId ?? null,
      semanticKey: row.semanticKey,
      name: row.name,
      intent: row.intent,
      revision: row.revision,
      status: row.status as AppBlueprint['status'],
      ...topology,
      acceptanceCriteria: row.acceptanceCriteria as string[],
      validation: row.validation as BlueprintValidationResult,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  latestForApp(workspaceId: string, appId: string): BuildSession | null {
    const row = this.db.select().from(schema.buildSessions)
      .where(and(eq(schema.buildSessions.workspaceId, workspaceId), eq(schema.buildSessions.appId, appId)))
      .orderBy(desc(schema.buildSessions.updatedAt)).get();
    return row ? this.presentSession(row) : null;
  }

  latestForConversation(workspaceId: string, conversationId: string): BuildSession | null {
    const row = this.db.select().from(schema.buildSessions)
      .where(and(eq(schema.buildSessions.workspaceId, workspaceId), eq(schema.buildSessions.conversationId, conversationId)))
      .orderBy(desc(schema.buildSessions.updatedAt)).get();
    return row ? this.presentSession(row) : null;
  }

  list(workspaceId: string, limit = 50): BuildSession[] {
    return this.db.select().from(schema.buildSessions)
      .where(eq(schema.buildSessions.workspaceId, workspaceId))
      .orderBy(desc(schema.buildSessions.updatedAt))
      .limit(Math.min(Math.max(limit, 1), 200)).all()
      .map((row) => this.presentSession(row));
  }

  private presentSession(row: typeof schema.buildSessions.$inferSelect): BuildSession {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      blueprintId: row.blueprintId,
      appId: row.appId ?? null,
      conversationId: row.conversationId ?? null,
      ownerAgentId: row.ownerAgentId ?? null,
      stage: row.stage as BuildStage,
      status: row.status as BuildSessionStatus,
      snapshot: row.snapshot as WorkspaceSnapshot,
      evidence: row.evidence as BuildEvidence[],
      diagnostic: row.diagnostic as BuildDiagnostic | null,
      repairAttempts: row.repairAttempts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt ?? null,
    };
  }

  private publish(session: BuildSession): void {
    this.bus?.publish(REALTIME_ROOMS.workspace(session.workspaceId), REALTIME_EVENTS.BUILD_SESSION_UPDATED, {
      workspaceId: session.workspaceId,
      buildSessionId: session.id,
      blueprintId: session.blueprintId,
      appId: session.appId ?? null,
      conversationId: session.conversationId ?? null,
      ownerAgentId: session.ownerAgentId ?? null,
      stage: session.stage,
      status: session.status,
      updatedAt: session.updatedAt,
    });
    this.bus?.publish(REALTIME_ROOMS.workspace(session.workspaceId), REALTIME_EVENTS.APP_BLUEPRINT_UPDATED, {
      workspaceId: session.workspaceId,
      blueprintId: session.blueprintId,
      appId: session.appId ?? null,
      status: session.status,
    });
  }
}
