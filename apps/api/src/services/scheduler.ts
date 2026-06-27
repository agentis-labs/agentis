import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type WorkflowGraph,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { BusMessage, EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import { buildInitialRunState } from '../engine/initialRunState.js';
import { validateWorkflowGraph } from '../engine/validateGraph.js';
import { evalCondition } from '../engine/SafeConditionParser.js';

const EVENT_CHAIN_MAX_DEPTH = 5;
const CHAIN_EVENTS = new Set<string>([
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.NODE_COMPLETED,
  REALTIME_EVENTS.NODE_FAILED,
]);

interface SchedulerDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  engine: WorkflowEngine;
  logger: Logger;
  /** Optional — scheduled-issue due sweep (Live Workspace backlog). */
  issues?: { sweepDue(now: Date): Promise<number> };
}

interface QueueWorkflowArgs {
  workflowId: string;
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  triggerId: string | null;
  inputs: Record<string, unknown>;
  reason: string;
  parentRunId?: string | null;
  chainDepth?: number;
  scheduledAt?: string | null;
  priority?: number;
}

interface QueuedWorkflowRun {
  queueId: string;
  runId: string;
  workflowId: string;
}

export class SchedulerService {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(private readonly deps: SchedulerDeps) {}

  start(intervalMs = 1_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.deps.logger.warn('scheduler.tick_failed', { err: (err as Error).message });
      });
    }, intervalMs);
    this.#timer.unref?.();
  }

  shutdown(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(now = new Date()): Promise<{ schedules: number; queues: number; issues: number }> {
    if (this.#running) return { schedules: 0, queues: 0, issues: 0 };
    this.#running = true;
    try {
      // Each sub-sweep is isolated: a failure in workflow scheduling must not
      // starve the issue sweep (and vice versa), or scheduled tasks silently
      // never fire.
      let schedules = 0;
      let queues = 0;
      let issues = 0;
      try { schedules = await this.processDueSchedules(now); } catch (err) {
        this.deps.logger.warn('scheduler.schedules_failed', { err: (err as Error).message });
      }
      try { queues = await this.processDueQueue(now); } catch (err) {
        this.deps.logger.warn('scheduler.queue_failed', { err: (err as Error).message });
      }
      if (this.deps.issues) {
        try { issues = await this.deps.issues.sweepDue(now); } catch (err) {
          this.deps.logger.warn('scheduler.issue_sweep_failed', { err: (err as Error).message });
        }
      }
      return { schedules, queues, issues };
    } finally {
      this.#running = false;
    }
  }

  async processDueSchedules(now = new Date()): Promise<number> {
    const nowIso = now.toISOString();
    const due = this.deps.db
      .select()
      .from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.status, 'active'))
      .all()
      .filter((row) => row.scheduledAt <= nowIso)
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));

    let fired = 0;
    for (const schedule of due) {
      const claimedAt = new Date().toISOString();
      this.deps.db
        .update(schema.scheduleRuns)
        .set({ status: 'firing', updatedAt: claimedAt })
        .where(eq(schema.scheduleRuns.id, schedule.id))
        .run();

      try {
        const trigger = this.deps.db
          .select()
          .from(schema.triggers)
          .where(eq(schema.triggers.id, schedule.triggerId))
          .get();
        if (!trigger || trigger.status !== 'active') {
          throw new AgentisError('TRIGGER_NOT_ACTIVE', 'Scheduled trigger is not active');
        }

        const queued = await queueWorkflowRun(this.deps, {
          workflowId: schedule.workflowId,
          workspaceId: schedule.workspaceId,
          ambientId: trigger.ambientId,
          userId: trigger.userId,
          triggerId: schedule.triggerId,
          inputs: {
            triggerType: 'schedule',
            scheduleId: schedule.id,
            scheduledAt: schedule.scheduledAt,
            firedAt: nowIso,
          },
          reason: 'schedule_due',
          scheduledAt: nowIso,
        });

        this.deps.db
          .update(schema.scheduleRuns)
          .set({ status: 'disabled', lastFiredAt: nowIso, updatedAt: new Date().toISOString() })
          .where(eq(schema.scheduleRuns.id, schedule.id))
          .run();
        this.deps.db
          .update(schema.triggers)
          .set({ lastFiredAt: nowIso, updatedAt: new Date().toISOString() })
          .where(eq(schema.triggers.id, schedule.triggerId))
          .run();
        this.deps.bus.publish(REALTIME_ROOMS.workflow(schedule.workflowId), REALTIME_EVENTS.SCHEDULE_FIRED, {
          scheduleId: schedule.id,
          workflowId: schedule.workflowId,
          triggerId: schedule.triggerId,
          queueId: queued.queueId,
          runId: queued.runId,
        });
        fired += 1;
      } catch (err) {
        this.deps.db
          .update(schema.scheduleRuns)
          .set({
            status: 'active',
            missedFires: schedule.missedFires + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.scheduleRuns.id, schedule.id))
          .run();
        this.deps.logger.warn('scheduler.schedule_fire_failed', {
          scheduleId: schedule.id,
          err: (err as Error).message,
        });
      }
    }
    return fired;
  }

  async processDueQueue(now = new Date()): Promise<number> {
    const nowIso = now.toISOString();
    const workflowIds = new Set(
      this.deps.db
        .select()
        .from(schema.workflowRunQueue)
        .where(eq(schema.workflowRunQueue.status, 'pending'))
        .all()
        .filter((item) => !item.scheduledAt || item.scheduledAt <= nowIso)
        .map((item) => item.workflowId),
    );
    for (const workflowId of workflowIds) {
      await this.deps.engine.drainWorkflowQueue(workflowId);
    }
    return workflowIds.size;
  }
}

export class EventChainService {
  #unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.deps.bus.subscribe((message) => {
      void this.handleMessage(message).catch((err) => {
        this.deps.logger.warn('event_chain.handle_failed', { err: (err as Error).message });
      });
    });
  }

  shutdown(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async handleMessage(message: BusMessage): Promise<{ fired: number }> {
    if (!CHAIN_EVENTS.has(message.envelope.event)) return { fired: 0 };
    if (!message.room.startsWith('run:')) return { fired: 0 };

    const payload = asRecord(message.envelope.payload);
    const runId = typeof payload.runId === 'string' ? payload.runId : message.room.slice('run:'.length);
    const sourceRun = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
    if (!sourceRun || !sourceRun.workflowId) return { fired: 0 };

    const subscriptions = this.deps.db
      .select()
      .from(schema.workflowEventSubscriptions)
      .where(
        and(
          eq(schema.workflowEventSubscriptions.sourceWorkflowId, sourceRun.workflowId),
          eq(schema.workflowEventSubscriptions.eventType, message.envelope.event),
          eq(schema.workflowEventSubscriptions.enabled, true),
        ),
      )
      .all();

    let fired = 0;
    for (const subscription of subscriptions) {
      const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : null;
      if (subscription.sourceNodeId && subscription.sourceNodeId !== nodeId) continue;

      const scope = {
        event: { type: message.envelope.event, emittedAt: message.envelope.emittedAt },
        payload,
        run: sourceRun,
        node: nodeId ? { id: nodeId } : null,
      };
      if (subscription.filterExpression) {
        try {
          if (!evalCondition(subscription.filterExpression, scope)) continue;
        } catch (err) {
          this.deps.logger.warn('event_chain.filter_invalid', {
            subscriptionId: subscription.id,
            err: (err as Error).message,
          });
          continue;
        }
      }

      const nextDepth = runLineageDepth(this.deps.db, sourceRun.id) + 1;
      if (nextDepth > EVENT_CHAIN_MAX_DEPTH) {
        this.deps.logger.warn('event_chain.depth_exceeded', {
          subscriptionId: subscription.id,
          sourceRunId: sourceRun.id,
          maxDepth: EVENT_CHAIN_MAX_DEPTH,
        });
        continue;
      }

      const reason = `event_chain:${subscription.id}`;
      if (subscription.coalescePolicy === 'coalesce_pending') {
        const existing = pendingQueueForReason(this.deps.db, subscription.targetWorkflowId, reason);
        if (existing) continue;
      } else if (subscription.coalescePolicy === 'latest_only') {
        dropPendingQueueForReason(this.deps.db, subscription.targetWorkflowId, reason);
      }

      const inputs = mapEventInputs(subscription.inputMapping as Record<string, string>, scope);
      const queued = await queueWorkflowRun(this.deps, {
        workflowId: subscription.targetWorkflowId,
        workspaceId: subscription.workspaceId,
        ambientId: sourceRun.ambientId,
        userId: sourceRun.userId,
        triggerId: null,
        inputs,
        reason,
        parentRunId: sourceRun.id,
        chainDepth: nextDepth,
      });
      this.deps.bus.publish(REALTIME_ROOMS.workflow(subscription.targetWorkflowId), REALTIME_EVENTS.EVENT_CHAIN_FIRED, {
        subscriptionId: subscription.id,
        sourceRunId: sourceRun.id,
        sourceWorkflowId: sourceRun.workflowId,
        targetWorkflowId: subscription.targetWorkflowId,
        eventType: message.envelope.event,
        queueId: queued.queueId,
        runId: queued.runId,
      });
      fired += 1;
    }
    return { fired };
  }
}

async function queueWorkflowRun(deps: SchedulerDeps, args: QueueWorkflowArgs): Promise<QueuedWorkflowRun> {
  const workflow = deps.db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, args.workflowId), eq(schema.workflows.workspaceId, args.workspaceId)))
    .get();
  if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow not found');

  const graph = workflow.graph as WorkflowGraph;
  if (graph.nodes.length === 0) throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Cannot run an empty workflow');
  validateWorkflowGraph(graph);

  const runId = randomUUID();
  const queueId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: workflow.id, graph, inputs: args.inputs });
  deps.db.transaction(() => {
    deps.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      workflowId: workflow.id,
      userId: args.userId,
      triggerId: args.triggerId,
      parentRunId: args.parentRunId ?? null,
      status: 'CREATED',
      runState: initialState as unknown as object,
      replanCount: 0,
    }).run();
    deps.db.insert(schema.workflowRunQueue).values({
      id: queueId,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      workflowId: workflow.id,
      userId: args.userId,
      triggerId: args.triggerId,
      inputs: args.inputs,
      initialState: initialState as unknown as object,
      graphSnapshot: graph as unknown as object,
      scheduledAt: args.scheduledAt ?? null,
      priority: args.priority ?? 0,
      reason: args.reason,
      parentRunId: args.parentRunId ?? null,
      chainDepth: args.chainDepth ?? 0,
      status: 'pending',
    }).run();
  });
  deps.bus.publish(REALTIME_ROOMS.workflow(workflow.id), REALTIME_EVENTS.RUN_QUEUED, {
    queueId,
    runId,
    workflowId: workflow.id,
    reason: args.reason,
  });
  await deps.engine.drainWorkflowQueue(workflow.id);
  return { queueId, runId, workflowId: workflow.id };
}

function pendingQueueForReason(db: AgentisSqliteDb, workflowId: string, reason: string) {
  return db
    .select()
    .from(schema.workflowRunQueue)
    .where(and(eq(schema.workflowRunQueue.workflowId, workflowId), eq(schema.workflowRunQueue.reason, reason), eq(schema.workflowRunQueue.status, 'pending')))
    .get();
}

function dropPendingQueueForReason(db: AgentisSqliteDb, workflowId: string, reason: string): void {
  db.update(schema.workflowRunQueue)
    .set({ status: 'dropped', updatedAt: new Date().toISOString() })
    .where(and(eq(schema.workflowRunQueue.workflowId, workflowId), eq(schema.workflowRunQueue.reason, reason), eq(schema.workflowRunQueue.status, 'pending')))
    .run();
}

function runLineageDepth(db: AgentisSqliteDb, runId: string): number {
  let depth = 0;
  let cursor: string | null = runId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor) && depth <= EVENT_CHAIN_MAX_DEPTH) {
    seen.add(cursor);
    const row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, cursor)).get();
    cursor = row?.parentRunId ?? null;
    if (cursor) depth += 1;
  }
  return depth;
}

function mapEventInputs(mapping: Record<string, string>, scope: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(mapping).length === 0) return scope;
  const inputs: Record<string, unknown> = {};
  for (const [key, source] of Object.entries(mapping)) {
    inputs[key] = lookupPath(scope, source);
  }
  return inputs;
}

function lookupPath(source: unknown, path: string): unknown {
  if (!path) return source;
  let cursor: unknown = source;
  for (const part of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
