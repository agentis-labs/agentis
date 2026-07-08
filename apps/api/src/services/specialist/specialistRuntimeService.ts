import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { normalizeRole } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export type SpecialistInstanceMode = 'durable' | 'ephemeral' | 'swarm_member' | 'shadow_eval';
export type SpecialistRunStatus = 'planned' | 'running' | 'completed' | 'failed' | 'suspended';

export interface SpecialistRunTraceEntry {
  at: string;
  event: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface SpecialistRunRecord {
  id: string;
  role: string;
  agentId: string | null;
  topology: string;
  status: SpecialistRunStatus;
  task: string;
  trace: SpecialistRunTraceEntry[];
  outputSummary: string | null;
  artifactId: string | null;
  createdAt: string;
  updatedAt: string;
}

export class SpecialistRuntimeService {
  constructor(private readonly db: AgentisSqliteDb) {}

  ensureInstance(args: {
    workspaceId: string;
    role: string;
    agentId: string;
    profileId?: string | null;
    mode?: SpecialistInstanceMode;
    parentAgentId?: string | null;
    reportsTo?: string | null;
    leaseExpiresAt?: string | null;
  }): string {
    const role = normalizeRole(args.role);
    const existing = this.db.select({ id: schema.specialistInstances.id }).from(schema.specialistInstances)
      .where(and(eq(schema.specialistInstances.workspaceId, args.workspaceId), eq(schema.specialistInstances.agentId, args.agentId)))
      .get();
    const now = new Date().toISOString();
    if (existing) {
      this.db.update(schema.specialistInstances).set({
        role,
        specialistProfileId: args.profileId ?? null,
        mode: args.mode ?? 'durable',
        parentAgentId: args.parentAgentId ?? null,
        reportsTo: args.reportsTo ?? null,
        leaseExpiresAt: args.leaseExpiresAt ?? null,
        lastUsedAt: now,
        updatedAt: now,
      }).where(eq(schema.specialistInstances.id, existing.id)).run();
      return existing.id;
    }
    const id = randomUUID();
    this.db.insert(schema.specialistInstances).values({
      id,
      workspaceId: args.workspaceId,
      role,
      agentId: args.agentId,
      specialistProfileId: args.profileId ?? null,
      mode: args.mode ?? 'durable',
      parentAgentId: args.parentAgentId ?? null,
      reportsTo: args.reportsTo ?? null,
      leaseExpiresAt: args.leaseExpiresAt ?? null,
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }

  recordPlannedRun(args: {
    workspaceId: string;
    routingDecisionId?: string | null;
    role: string;
    agentId?: string | null;
    topology: string;
    task: string;
    artifactPolicy?: Record<string, unknown>;
    budgetPolicy?: Record<string, unknown>;
    trace?: SpecialistRunTraceEntry[];
  }): SpecialistRunRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.insert(schema.specialistRuns).values({
      id,
      workspaceId: args.workspaceId,
      routingDecisionId: args.routingDecisionId ?? null,
      role: normalizeRole(args.role),
      agentId: args.agentId ?? null,
      topology: args.topology,
      status: 'planned',
      task: args.task,
      artifactPolicy: args.artifactPolicy ?? {},
      budgetPolicy: args.budgetPolicy ?? {},
      trace: args.trace ?? [{ at: now, event: 'planned', summary: `Planned ${args.topology} specialist run.` }],
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.getRun(args.workspaceId, id)!;
  }

  updateRun(workspaceId: string, runId: string, patch: {
    status?: SpecialistRunStatus;
    outputSummary?: string | null;
    artifactId?: string | null;
    traceEvent?: Omit<SpecialistRunTraceEntry, 'at'>;
  }): SpecialistRunRecord | null {
    const existing = this.getRun(workspaceId, runId);
    if (!existing) return null;
    const now = new Date().toISOString();
    const trace = patch.traceEvent
      ? [...existing.trace, { at: now, ...patch.traceEvent }]
      : existing.trace;
    this.db.update(schema.specialistRuns).set({
      status: patch.status ?? existing.status,
      outputSummary: patch.outputSummary ?? existing.outputSummary,
      artifactId: patch.artifactId ?? existing.artifactId,
      trace,
      startedAt: patch.status === 'running' ? now : undefined,
      finishedAt: patch.status === 'completed' || patch.status === 'failed' ? now : undefined,
      updatedAt: now,
    }).where(and(eq(schema.specialistRuns.workspaceId, workspaceId), eq(schema.specialistRuns.id, runId))).run();
    return this.getRun(workspaceId, runId);
  }

  getRun(workspaceId: string, runId: string): SpecialistRunRecord | null {
    const row = this.db.select().from(schema.specialistRuns)
      .where(and(eq(schema.specialistRuns.workspaceId, workspaceId), eq(schema.specialistRuns.id, runId))).get();
    return row ? toRun(row) : null;
  }

  listRuns(workspaceId: string, role?: string, limit = 20): SpecialistRunRecord[] {
    const rows = role
      ? this.db.select().from(schema.specialistRuns)
        .where(and(eq(schema.specialistRuns.workspaceId, workspaceId), eq(schema.specialistRuns.role, normalizeRole(role))))
        .orderBy(desc(schema.specialistRuns.createdAt)).limit(limit).all()
      : this.db.select().from(schema.specialistRuns)
        .where(eq(schema.specialistRuns.workspaceId, workspaceId))
        .orderBy(desc(schema.specialistRuns.createdAt)).limit(limit).all();
    return rows.map(toRun);
  }
}

function toRun(row: typeof schema.specialistRuns.$inferSelect): SpecialistRunRecord {
  return {
    id: row.id,
    role: row.role,
    agentId: row.agentId,
    topology: row.topology,
    status: row.status as SpecialistRunStatus,
    task: row.task,
    trace: (row.trace as SpecialistRunTraceEntry[]) ?? [],
    outputSummary: row.outputSummary,
    artifactId: row.artifactId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
