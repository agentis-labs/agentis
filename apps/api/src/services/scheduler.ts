import { createHash, randomUUID } from 'node:crypto';
import { and, eq, lte, or, sql } from 'drizzle-orm';
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
import { readRunVerdictOutcome } from './workflow/runOutcome.js';

const EVENT_CHAIN_MAX_DEPTH = 5;
const EVENT_DELIVERY_LEASE_MS = 60_000;
const EVENT_DELIVERY_POLL_MS = 1_000;
const EVENT_DELIVERY_MAX_ATTEMPTS = 5;
const QUEUE_CLAIM_LEASE_MS = 5 * 60_000;
const SCHEDULE_CLAIM_LEASE_MS = 5 * 60_000;
const CHAIN_EVENTS = new Set<string>([
  REALTIME_EVENTS.RUN_COMPLETED,
  REALTIME_EVENTS.RUN_ACCOMPLISHED,
  REALTIME_EVENTS.RUN_FAILED,
  REALTIME_EVENTS.NODE_COMPLETED,
  REALTIME_EVENTS.NODE_FAILED,
]);

export interface SchedulerDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  engine: WorkflowEngine;
  logger: Logger;
  /** Optional — scheduled-issue due sweep (Live Workspace backlog). */
  issues?: { sweepDue(now: Date): Promise<number> };
}

export interface QueueWorkflowArgs {
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
  /** Stable caller identity. Reusing it returns the original queue/run pair. */
  idempotencyKey?: string | null;
}

interface QueuedWorkflowRun {
  queueId: string;
  runId: string;
  workflowId: string;
}

export class SchedulerService {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  // Throttled background sweeps registered by other subsystems (Living Apps
  // proactivity / abandonment). Each runs at most once per `everyMs`.
  readonly #appSweeps: Array<{ name: string; everyMs: number; lastRun: number; run: (now: Date) => Promise<number> }> = [];

  constructor(private readonly deps: SchedulerDeps) {}

  /**
   * Register a throttled background sweep (Living Apps §4.5 / M2). Runs inside the
   * existing tick loop, isolated so a failure never starves the others. `everyMs`
   * caps frequency (the tick fires every ~1s; a due/abandon sweep needn't).
   */
  registerSweep(name: string, everyMs: number, run: (now: Date) => Promise<number>): void {
    this.#appSweeps.push({ name, everyMs, lastRun: 0, run });
  }

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
      // Throttled Living Apps sweeps (proactive follow-ups, abandoned contacts).
      const nowMs = now.getTime();
      for (const sweep of this.#appSweeps) {
        if (nowMs - sweep.lastRun < sweep.everyMs) continue;
        sweep.lastRun = nowMs;
        try { await sweep.run(now); } catch (err) {
          this.deps.logger.warn(`scheduler.${sweep.name}_failed`, { err: (err as Error).message });
        }
      }
      return { schedules, queues, issues };
    } finally {
      this.#running = false;
    }
  }

  async processDueSchedules(now = new Date()): Promise<number> {
    const nowIso = now.toISOString();
    const staleClaimCutoff = new Date(now.getTime() - SCHEDULE_CLAIM_LEASE_MS).toISOString();
    const due = this.deps.db
      .select()
      .from(schema.scheduleRuns)
      .where(or(
        eq(schema.scheduleRuns.status, 'active'),
        and(eq(schema.scheduleRuns.status, 'firing'), lte(schema.scheduleRuns.updatedAt, staleClaimCutoff)),
      ))
      .all()
      .filter((row) => row.scheduledAt <= nowIso)
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));

    let fired = 0;
    for (const schedule of due) {
      const claimedAt = new Date().toISOString();
      const claimed = this.deps.db
        .update(schema.scheduleRuns)
        .set({ status: 'firing', updatedAt: claimedAt })
        .where(and(
          eq(schema.scheduleRuns.id, schedule.id),
          schedule.status === 'active'
            ? eq(schema.scheduleRuns.status, 'active')
            : and(eq(schema.scheduleRuns.status, 'firing'), lte(schema.scheduleRuns.updatedAt, staleClaimCutoff)),
        ))
        .run();
      if (claimed.changes === 0) continue;

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
          idempotencyKey: `schedule:${schedule.id}:${schedule.scheduledAt}`,
        });

        this.deps.db
          .update(schema.scheduleRuns)
          .set({ status: 'disabled', lastFiredAt: nowIso, updatedAt: new Date().toISOString() })
          .where(and(
            eq(schema.scheduleRuns.id, schedule.id),
            eq(schema.scheduleRuns.status, 'firing'),
            eq(schema.scheduleRuns.updatedAt, claimedAt),
          ))
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
          .where(and(
            eq(schema.scheduleRuns.id, schedule.id),
            eq(schema.scheduleRuns.status, 'firing'),
            eq(schema.scheduleRuns.updatedAt, claimedAt),
          ))
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
    // A process can die after claiming a queue row but before startRun observes
    // it. Only CREATED runs are safe to release; RUNNING/terminal runs prove the
    // claim crossed the execution boundary and must never be started twice.
    const staleCutoff = new Date(now.getTime() - QUEUE_CLAIM_LEASE_MS).toISOString();
    const staleClaims = this.deps.db.select().from(schema.workflowRunQueue)
      .where(and(eq(schema.workflowRunQueue.status, 'dequeued'), lte(schema.workflowRunQueue.updatedAt, staleCutoff)))
      .all();
    for (const item of staleClaims) {
      const runId = item.runId ?? runIdFromInitialState(item.initialState);
      const run = runId
        ? this.deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()
        : null;
      if (run?.status !== 'CREATED') continue;
      this.deps.db.update(schema.workflowRunQueue)
        .set({ status: 'pending', updatedAt: nowIso })
        .where(and(
          eq(schema.workflowRunQueue.id, item.id),
          eq(schema.workflowRunQueue.status, 'dequeued'),
          lte(schema.workflowRunQueue.updatedAt, staleCutoff),
        ))
        .run();
    }
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
      // Same clock the due-filter used, so a row that is not yet due cannot slip
      // in on a later timestamp mid-sweep.
      await this.deps.engine.drainWorkflowQueue(workflowId, now);
    }
    return workflowIds.size;
  }
}

export class EventChainService {
  #unsubscribe: (() => void) | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  readonly #workerId = randomUUID();

  constructor(private readonly deps: SchedulerDeps) {}

  start(intervalMs = EVENT_DELIVERY_POLL_MS): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.deps.bus.subscribe((message) => {
      void this.handleMessage(message).catch((err) => {
        this.deps.logger.warn('event_chain.handle_failed', { err: (err as Error).message });
      });
    });
    this.#reclaimExpiredLeases();
    // Close the source-state-commit → ephemeral-publish crash window. Only runs
    // settled after a rule was created are eligible, bounded by its catch-up cap.
    void this.recoverMissedEvents().then(() => this.poll()).catch((err) => {
      this.deps.logger.warn('event_chain.catchup_failed', { err: (err as Error).message });
    });
    this.#timer = setInterval(() => {
      void this.poll().catch((err) => {
        this.deps.logger.warn('event_chain.poll_failed', { err: (err as Error).message });
      });
    }, intervalMs);
    this.#timer.unref?.();
  }

  shutdown(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
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

    const deliveryIds: string[] = [];
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

      const eventIdentity = stableEventIdentity(message, sourceRun.id, nodeId);
      const deliveryId = stableDeliveryId(subscription.id, eventIdentity);
      const now = new Date().toISOString();
      this.deps.db.insert(schema.workflowEventDeliveries).values({
        id: deliveryId,
        workspaceId: subscription.workspaceId,
        subscriptionId: subscription.id,
        eventIdentity,
        eventType: message.envelope.event,
        eventPayload: payload,
        eventEmittedAt: message.envelope.emittedAt,
        correlationId: message.envelope.correlationId ?? null,
        sourceRunId: sourceRun.id,
        sourceNodeId: nodeId,
        status: 'pending',
        attempts: 0,
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();
      deliveryIds.push(deliveryId);
    }
    return { fired: await this.#processDeliveries(deliveryIds) };
  }

  /**
   * Drain persisted deliveries. Public for deterministic tests and operator
   * recovery commands; concurrent callers are safe because each claim is CAS.
   */
  async poll(now = new Date()): Promise<number> {
    if (this.#polling) return 0;
    this.#polling = true;
    try {
      this.#reclaimExpiredLeases(now);
      const due = this.deps.db.select({ id: schema.workflowEventDeliveries.id })
        .from(schema.workflowEventDeliveries)
        .where(and(
          eq(schema.workflowEventDeliveries.status, 'pending'),
          lte(schema.workflowEventDeliveries.availableAt, now.toISOString()),
        ))
        .limit(100)
        .all();
      return await this.#processDeliveries(due.map((row) => row.id), now);
    } finally {
      this.#polling = false;
    }
  }

  /** Retry a parked delivery without changing its stable enqueue identity. */
  async retryDelivery(deliveryId: string): Promise<boolean> {
    const now = new Date().toISOString();
    this.deps.db.update(schema.workflowEventDeliveries).set({
      status: 'pending', availableAt: now, leaseOwner: null, leaseExpiresAt: null,
      lastError: null, updatedAt: now,
    }).where(and(
      eq(schema.workflowEventDeliveries.id, deliveryId),
      or(eq(schema.workflowEventDeliveries.status, 'dead'), eq(schema.workflowEventDeliveries.status, 'pending')),
    )).run();
    return (await this.#processDeliveries([deliveryId])) > 0;
  }

  /**
   * Reconstruct bounded terminal events from authoritative run state. This is
   * deliberately limited to runs newer than the subscription, so enabling a
   * rule never executes arbitrary historical business actions.
   */
  async recoverMissedEvents(): Promise<number> {
    const subscriptions = this.deps.db.select().from(schema.workflowEventSubscriptions)
      .where(eq(schema.workflowEventSubscriptions.enabled, true)).all();
    let recovered = 0;
    for (const subscription of subscriptions) {
      const cap = catchupCap(subscription.catchupPolicy);
      if (cap === 0 || !CHAIN_EVENTS.has(subscription.eventType)) continue;
      const candidates = this.deps.db.select().from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.workflowId, subscription.sourceWorkflowId)).all()
        .filter((run) => run.createdAt >= subscription.createdAt)
        .filter((run) => runMatchesEvent(run, subscription.eventType, subscription.sourceNodeId))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, cap);
      for (const run of candidates.reverse()) {
        const message = reconstructedRunMessage(run, subscription.eventType, subscription.sourceNodeId);
        const result = await this.handleMessage(message);
        recovered += result.fired;
      }
    }
    return recovered;
  }

  async #processDeliveries(ids: string[], now = new Date()): Promise<number> {
    let delivered = 0;
    for (const id of [...new Set(ids)]) {
      if (await this.#claimAndDeliver(id, now)) delivered += 1;
    }
    return delivered;
  }

  async #claimAndDeliver(id: string, now: Date): Promise<boolean> {
    const claimedAt = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + EVENT_DELIVERY_LEASE_MS).toISOString();
    const claimed = this.deps.db.update(schema.workflowEventDeliveries).set({
      status: 'processing',
      attempts: sql`${schema.workflowEventDeliveries.attempts} + 1`,
      leaseOwner: this.#workerId,
      leaseExpiresAt,
      updatedAt: claimedAt,
    }).where(and(
      eq(schema.workflowEventDeliveries.id, id),
      eq(schema.workflowEventDeliveries.status, 'pending'),
      lte(schema.workflowEventDeliveries.availableAt, claimedAt),
    )).run();
    if (claimed.changes === 0) return false;

    const delivery = this.deps.db.select().from(schema.workflowEventDeliveries)
      .where(eq(schema.workflowEventDeliveries.id, id)).get();
    if (!delivery) return false;
    try {
      const subscription = this.deps.db.select().from(schema.workflowEventSubscriptions)
        .where(eq(schema.workflowEventSubscriptions.id, delivery.subscriptionId)).get();
      const sourceRun = this.deps.db.select().from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, delivery.sourceRunId)).get();
      if (!subscription || !sourceRun || !subscription.enabled) {
        this.#finishDelivery(delivery.id, 'skipped', null, null);
        return false;
      }

      const reason = `event_chain:${subscription.id}`;
      if (subscription.coalescePolicy === 'coalesce_pending') {
        const existing = pendingQueueForReason(this.deps.db, subscription.targetWorkflowId, reason);
        if (existing) {
          this.#finishDelivery(delivery.id, 'skipped', existing.id, existing.runId ?? runIdFromInitialState(existing.initialState));
          return false;
        }
      } else if (subscription.coalescePolicy === 'latest_only') {
        dropPendingQueueForReason(this.deps.db, subscription.targetWorkflowId, reason);
      }

      const payload = asRecord(delivery.eventPayload);
      const scope = {
        event: { type: delivery.eventType, emittedAt: delivery.eventEmittedAt },
        payload,
        run: sourceRun,
        node: delivery.sourceNodeId ? { id: delivery.sourceNodeId } : null,
      };
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
        chainDepth: runLineageDepth(this.deps.db, sourceRun.id) + 1,
        idempotencyKey: `event-delivery:${delivery.id}`,
      });
      this.#finishDelivery(delivery.id, 'delivered', queued.queueId, queued.runId);
      this.deps.bus.publish(REALTIME_ROOMS.workflow(subscription.targetWorkflowId), REALTIME_EVENTS.EVENT_CHAIN_FIRED, {
        deliveryId: delivery.id,
        eventIdentity: delivery.eventIdentity,
        subscriptionId: subscription.id,
        sourceRunId: sourceRun.id,
        sourceWorkflowId: sourceRun.workflowId,
        targetWorkflowId: subscription.targetWorkflowId,
        eventType: delivery.eventType,
        queueId: queued.queueId,
        runId: queued.runId,
      });
      return true;
    } catch (err) {
      const terminal = delivery.attempts >= EVENT_DELIVERY_MAX_ATTEMPTS;
      const backoffMs = Math.min(60_000, delivery.attempts * delivery.attempts * 1_000);
      const failedAt = new Date().toISOString();
      this.deps.db.update(schema.workflowEventDeliveries).set({
        status: terminal ? 'dead' : 'pending',
        availableAt: terminal ? delivery.availableAt : new Date(Date.now() + backoffMs).toISOString(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: (err as Error).message.slice(0, 1_000),
        updatedAt: failedAt,
      }).where(and(
        eq(schema.workflowEventDeliveries.id, delivery.id),
        eq(schema.workflowEventDeliveries.status, 'processing'),
        eq(schema.workflowEventDeliveries.leaseOwner, this.#workerId),
      )).run();
      this.deps.logger.warn('event_chain.delivery_failed', {
        deliveryId: delivery.id, attempts: delivery.attempts, terminal,
        err: (err as Error).message,
      });
      return false;
    }
  }

  #finishDelivery(id: string, status: 'delivered' | 'skipped', queueId: string | null, runId: string | null): void {
    const now = new Date().toISOString();
    this.deps.db.update(schema.workflowEventDeliveries).set({
      status,
      targetQueueId: queueId,
      targetRunId: runId,
      deliveredAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: now,
    }).where(and(
      eq(schema.workflowEventDeliveries.id, id),
      eq(schema.workflowEventDeliveries.status, 'processing'),
      eq(schema.workflowEventDeliveries.leaseOwner, this.#workerId),
    )).run();
  }

  #reclaimExpiredLeases(now = new Date()): void {
    const nowIso = now.toISOString();
    const expired = this.deps.db.select().from(schema.workflowEventDeliveries)
      .where(eq(schema.workflowEventDeliveries.status, 'processing')).all()
      .filter((row) => !row.leaseExpiresAt || row.leaseExpiresAt <= nowIso);
    for (const row of expired) {
      const terminal = row.attempts >= EVENT_DELIVERY_MAX_ATTEMPTS;
      this.deps.db.update(schema.workflowEventDeliveries).set({
        status: terminal ? 'dead' : 'pending',
        availableAt: nowIso,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: terminal ? (row.lastError ?? 'delivery lease expired after max attempts') : row.lastError,
        updatedAt: nowIso,
      }).where(and(
        eq(schema.workflowEventDeliveries.id, row.id),
        eq(schema.workflowEventDeliveries.status, 'processing'),
      )).run();
    }
  }
}

/**
 * The single enqueue-a-workflow-run seam: validates the graph, writes the run +
 * queue rows in one transaction, publishes RUN_QUEUED, and drains. Exported so
 * other orchestration layers (event chains here, the AppOrchestrator's
 * dependsOn-chains + binding schedules) start runs through the SAME path —
 * never a forked execution.
 */
export async function queueWorkflowRun(deps: SchedulerDeps, args: QueueWorkflowArgs): Promise<QueuedWorkflowRun> {
  if (args.idempotencyKey) {
    const existing = deps.db.select().from(schema.workflowRunQueue).where(and(
      eq(schema.workflowRunQueue.workspaceId, args.workspaceId),
      eq(schema.workflowRunQueue.idempotencyKey, args.idempotencyKey),
    )).get();
    if (existing) {
      const existingRunId = existing.runId ?? runIdFromInitialState(existing.initialState);
      if (!existingRunId) throw new AgentisError('INTERNAL_ERROR', 'Idempotent queue row has no workflow run identity');
      await deps.engine.drainWorkflowQueue(existing.workflowId);
      return { queueId: existing.id, runId: existingRunId, workflowId: existing.workflowId };
    }
  }
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
  try {
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
        runId,
        idempotencyKey: args.idempotencyKey ?? null,
        status: 'pending',
      }).run();
    });
  } catch (err) {
    // A concurrent producer can win the UNIQUE(workspace,idempotency_key)
    // race after our preflight. The transaction rolls back its orphan run;
    // return the winner instead of leaking a duplicate.
    if (args.idempotencyKey && /unique/i.test((err as Error).message)) {
      const existing = deps.db.select().from(schema.workflowRunQueue).where(and(
        eq(schema.workflowRunQueue.workspaceId, args.workspaceId),
        eq(schema.workflowRunQueue.idempotencyKey, args.idempotencyKey),
      )).get();
      const existingRunId = existing?.runId ?? runIdFromInitialState(existing?.initialState);
      if (existing && existingRunId) {
        await deps.engine.drainWorkflowQueue(existing.workflowId);
        return { queueId: existing.id, runId: existingRunId, workflowId: existing.workflowId };
      }
    }
    throw err;
  }
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

function runIdFromInitialState(value: unknown): string | null {
  const runId = asRecord(value).runId;
  return typeof runId === 'string' && runId.length > 0 ? runId : null;
}

function stableEventIdentity(message: BusMessage, sourceRunId: string, sourceNodeId: string | null): string {
  const payload = asRecord(message.envelope.payload);
  const explicitOccurrence = payload.eventId ?? payload.deliveryId ?? payload.sequenceNumber ?? payload.attempt ?? null;
  const material = {
    sourceRunId,
    eventType: message.envelope.event,
    sourceNodeId,
    occurrence: explicitOccurrence,
  };
  return createHash('sha256').update(stableJson(material)).digest('hex');
}

function catchupCap(policy: string): number {
  if (policy === 'skip_missed') return 0;
  const match = /enqueue_missed_with_cap:(\d+)/u.exec(policy);
  const parsed = match ? Number(match[1]) : 5;
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 0;
}

function runMatchesEvent(
  run: typeof schema.workflowRuns.$inferSelect,
  eventType: string,
  sourceNodeId: string | null,
): boolean {
  if (eventType === REALTIME_EVENTS.RUN_COMPLETED) return run.status === 'COMPLETED';
  if (eventType === REALTIME_EVENTS.RUN_ACCOMPLISHED) {
    return run.status === 'COMPLETED' && readRunVerdictOutcome(run.runState) === 'accomplished';
  }
  if (eventType === REALTIME_EVENTS.RUN_FAILED) {
    return run.status === 'FAILED' || run.status === 'CANCELLED'
      || run.status === 'COMPLETED_WITH_ERRORS' || run.status === 'COMPLETED_WITH_CONTRACT_VIOLATION';
  }
  if (!sourceNodeId) return false;
  const nodeState = asRecord(asRecord(run.runState).nodeStates)[sourceNodeId];
  const status = asRecord(nodeState).status;
  return eventType === REALTIME_EVENTS.NODE_COMPLETED ? status === 'COMPLETED'
    : eventType === REALTIME_EVENTS.NODE_FAILED ? status === 'FAILED'
      : false;
}

function reconstructedRunMessage(
  run: typeof schema.workflowRuns.$inferSelect,
  eventType: string,
  sourceNodeId: string | null,
): BusMessage {
  const nodeState = sourceNodeId ? asRecord(asRecord(run.runState).nodeStates)[sourceNodeId] : null;
  return {
    room: REALTIME_ROOMS.run(run.id),
    envelope: {
      event: eventType as typeof REALTIME_EVENTS[keyof typeof REALTIME_EVENTS],
      emittedAt: run.updatedAt,
      payload: {
        runId: run.id,
        workflowId: run.workflowId,
        workspaceId: run.workspaceId,
        status: run.status,
        ...(eventType === REALTIME_EVENTS.RUN_ACCOMPLISHED ? { verdict: 'accomplished' } : {}),
        ...(sourceNodeId ? {
          nodeId: sourceNodeId,
          output: asRecord(nodeState).output,
          error: asRecord(nodeState).error,
        } : {}),
      },
    },
  };
}

function stableDeliveryId(subscriptionId: string, eventIdentity: string): string {
  return `wed_${createHash('sha256').update(`${subscriptionId}:${eventIdentity}`).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
