import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import { buildInitialRunState } from '../engine/initialRunState.js';

export class RoutineService {
  constructor(private readonly deps: { db: AgentisSqliteDb; engine: WorkflowEngine; bus: EventBus }) {}

  list(workspaceId: string) {
    return this.deps.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.workspaceId, workspaceId))
      .all()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  create(args: {
    workspaceId: string;
    userId: string;
    workflowId: string;
    title: string;
    description?: string | null;
    status?: string;
    variables?: Record<string, unknown>;
  }) {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      userId: args.userId,
      workflowId: args.workflowId,
      title: args.title,
      description: args.description ?? null,
      status: args.status ?? 'paused',
      concurrencyPolicy: 'coalesce_if_active',
      catchUpPolicy: 'skip_missed',
      variables: args.variables ?? {},
      lastRunId: null,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insert(schema.routines).values(row).run();
    this.deps.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.ROUTINE_CREATED, row);
    return row;
  }

  update(workspaceId: string, id: string, patch: Record<string, unknown>) {
    const existing = this.get(workspaceId, id);
    if (!existing) return null;
    const next = {
      title: typeof patch.title === 'string' ? patch.title : existing.title,
      description: patch.description === undefined ? existing.description : (patch.description as string | null),
      status: typeof patch.status === 'string' ? patch.status : existing.status,
      concurrencyPolicy: typeof patch.concurrencyPolicy === 'string' ? patch.concurrencyPolicy : existing.concurrencyPolicy,
      catchUpPolicy: typeof patch.catchUpPolicy === 'string' ? patch.catchUpPolicy : existing.catchUpPolicy,
      variables: patch.variables && typeof patch.variables === 'object' ? patch.variables as Record<string, unknown> : existing.variables as Record<string, unknown>,
      updatedAt: new Date().toISOString(),
    };
    this.deps.db.update(schema.routines).set(next).where(eq(schema.routines.id, id)).run();
    const routine = { ...existing, ...next };
    this.deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.ROUTINE_UPDATED, routine);
    return routine;
  }

  get(workspaceId: string, id: string) {
    return this.deps.db
      .select()
      .from(schema.routines)
      .where(and(eq(schema.routines.id, id), eq(schema.routines.workspaceId, workspaceId)))
      .get();
  }

  async fire(args: { workspaceId: string; userId: string; routineId: string; overrideVariables?: Record<string, unknown> }) {
    const routine = this.get(args.workspaceId, args.routineId);
    if (!routine || routine.status === 'archived') return null;
    const workflow = this.deps.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, routine.workflowId), eq(schema.workflows.workspaceId, args.workspaceId)))
      .get();
    if (!workflow) return null;
    const runId = randomUUID();
    const graph = workflow.graph as WorkflowGraph;
    const inputs = { ...(routine.variables as Record<string, unknown>), ...(args.overrideVariables ?? {}), routineId: routine.id };
    const state = buildInitialRunState({ runId, workflowId: workflow.id, graph, inputs });
    this.deps.db
      .insert(schema.workflowRuns)
      .values({
        id: runId,
        workspaceId: args.workspaceId,
        ambientId: workflow.ambientId,
        workflowId: workflow.id,
        userId: args.userId,
        status: 'CREATED',
        runState: state,
        triggerId: null,
      })
      .run();
    this.deps.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.RUN_CREATED, {
      runId,
      workflowId: workflow.id,
      ambientId: workflow.ambientId,
      routineId: routine.id,
    });
    await this.deps.engine.startRun({
      workspaceId: args.workspaceId,
      ambientId: workflow.ambientId,
      workflowId: workflow.id,
      userId: args.userId,
      triggerId: null,
      inputs,
      initialState: state,
      graph,
    });
    const now = new Date().toISOString();
    this.deps.db
      .update(schema.routines)
      .set({ lastRunId: runId, lastRunAt: now, updatedAt: now })
      .where(eq(schema.routines.id, routine.id))
      .run();
    return { runId, workflowId: workflow.id };
  }
}
