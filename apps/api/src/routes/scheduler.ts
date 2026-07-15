/**
 * /v1/scheduler — Engine 10x schedule, event-chain, and queue surface.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const scheduleCreateSchema = z.object({
  workflowId: z.string().uuid(),
  triggerId: z.string().uuid(),
  scheduledAt: z.string().datetime(),
});

const schedulePatchSchema = z.object({
  scheduledAt: z.string().datetime().optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
});

const subscriptionCreateSchema = z.object({
  sourceWorkflowId: z.string().uuid(),
  targetWorkflowId: z.string().uuid(),
  eventType: z.enum(['run.completed', 'run.accomplished', 'run.failed', 'node.completed', 'node.failed']),
  sourceNodeId: z.string().min(1).optional(),
  filterExpression: z.string().max(2000).optional(),
  inputMapping: z.record(z.string(), z.string()).default({}),
  coalescePolicy: z.string().default('always_enqueue'),
  catchupPolicy: z.string().default('enqueue_missed_with_cap:5'),
  enabled: z.boolean().default(true),
});

const subscriptionPatchSchema = subscriptionCreateSchema.partial();

export function buildSchedulerRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/schedules', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.workspaceId, ws.workspaceId))
      .all()
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
    return c.json({ schedules: rows });
  });

  app.post('/schedules', async (c) => {
    const ws = getWorkspace(c);
    const body = scheduleCreateSchema.parse(await c.req.json());
    assertWorkflow(deps.db, ws.workspaceId, body.workflowId);
    assertTrigger(deps.db, ws.workspaceId, body.triggerId, body.workflowId);
    const id = randomUUID();
    deps.db.insert(schema.scheduleRuns).values({
      id,
      workspaceId: ws.workspaceId,
      workflowId: body.workflowId,
      triggerId: body.triggerId,
      scheduledAt: body.scheduledAt,
      status: 'active',
    }).run();
    return c.json({ schedule: deps.db.select().from(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, id)).get() }, 201);
  });

  app.patch('/schedules/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    assertSchedule(deps.db, ws.workspaceId, id);
    const body = schedulePatchSchema.parse(await c.req.json());
    deps.db.update(schema.scheduleRuns).set({ ...body, updatedAt: new Date().toISOString() }).where(eq(schema.scheduleRuns.id, id)).run();
    return c.json({ ok: true });
  });

  app.delete('/schedules/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    assertSchedule(deps.db, ws.workspaceId, id);
    deps.db.delete(schema.scheduleRuns).where(eq(schema.scheduleRuns.id, id)).run();
    return c.json({ ok: true });
  });

  app.get('/subscriptions', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.workflowEventSubscriptions)
      .where(eq(schema.workflowEventSubscriptions.workspaceId, ws.workspaceId))
      .all();
    return c.json({ subscriptions: rows });
  });

  app.post('/subscriptions', async (c) => {
    const ws = getWorkspace(c);
    const body = subscriptionCreateSchema.parse(await c.req.json());
    assertWorkflow(deps.db, ws.workspaceId, body.sourceWorkflowId);
    assertWorkflow(deps.db, ws.workspaceId, body.targetWorkflowId);
    const id = randomUUID();
    deps.db.insert(schema.workflowEventSubscriptions).values({
      id,
      workspaceId: ws.workspaceId,
      sourceWorkflowId: body.sourceWorkflowId,
      targetWorkflowId: body.targetWorkflowId,
      eventType: body.eventType,
      sourceNodeId: body.sourceNodeId ?? null,
      filterExpression: body.filterExpression ?? null,
      inputMapping: body.inputMapping,
      coalescePolicy: body.coalescePolicy,
      catchupPolicy: body.catchupPolicy,
      enabled: body.enabled,
    }).run();
    return c.json({ subscription: deps.db.select().from(schema.workflowEventSubscriptions).where(eq(schema.workflowEventSubscriptions.id, id)).get() }, 201);
  });

  app.patch('/subscriptions/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    assertSubscription(deps.db, ws.workspaceId, id);
    const body = subscriptionPatchSchema.parse(await c.req.json());
    deps.db.update(schema.workflowEventSubscriptions).set({ ...body, updatedAt: new Date().toISOString() }).where(eq(schema.workflowEventSubscriptions.id, id)).run();
    return c.json({ ok: true });
  });

  app.delete('/subscriptions/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    assertSubscription(deps.db, ws.workspaceId, id);
    deps.db.delete(schema.workflowEventSubscriptions).where(eq(schema.workflowEventSubscriptions.id, id)).run();
    return c.json({ ok: true });
  });

  app.get('/deliveries', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db.select().from(schema.workflowEventDeliveries)
      .where(eq(schema.workflowEventDeliveries.workspaceId, ws.workspaceId))
      .all()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return c.json({ deliveries: rows });
  });

  /**
   * Release a dead delivery for the durable worker. Delivered rows are never
   * replayed into a second target run: their stable queue idempotency key is an
   * immutable proof that the orchestration transition already happened.
   */
  app.post('/deliveries/:id/retry', (c) => {
    const ws = getWorkspace(c);
    const delivery = assertDelivery(deps.db, ws.workspaceId, c.req.param('id'));
    if (delivery.status === 'delivered' || delivery.status === 'skipped') {
      return c.json({ ok: true, status: delivery.status, replayed: false, targetRunId: delivery.targetRunId });
    }
    if (delivery.status === 'processing') {
      return c.json({ ok: false, status: delivery.status, reason: 'delivery_is_leased' }, 409);
    }
    const now = new Date().toISOString();
    deps.db.update(schema.workflowEventDeliveries).set({
      status: 'pending', availableAt: now, leaseOwner: null, leaseExpiresAt: null,
      lastError: null, updatedAt: now,
    }).where(eq(schema.workflowEventDeliveries.id, delivery.id)).run();
    return c.json({ ok: true, status: 'pending', replayed: true });
  });

  app.get('/queue', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.workflowRunQueue)
      .where(eq(schema.workflowRunQueue.workspaceId, ws.workspaceId))
      .all()
      .sort((left, right) => {
        const priorityDiff = right.priority - left.priority;
        if (priorityDiff !== 0) return priorityDiff;
        return left.enqueuedAt.localeCompare(right.enqueuedAt);
      });
    return c.json({ items: rows });
  });

  app.post('/queue/:id/cancel', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    assertQueueItem(deps.db, ws.workspaceId, id);
    deps.db.update(schema.workflowRunQueue).set({ status: 'dropped', updatedAt: new Date().toISOString() }).where(eq(schema.workflowRunQueue.id, id)).run();
    return c.json({ ok: true });
  });

  app.post('/queue/:id/promote', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const item = assertQueueItem(deps.db, ws.workspaceId, id);
    deps.db.update(schema.workflowRunQueue).set({ priority: item.priority + 1, updatedAt: new Date().toISOString() }).where(eq(schema.workflowRunQueue.id, id)).run();
    return c.json({ ok: true });
  });

  return app;
}

function assertWorkflow(db: AgentisSqliteDb, workspaceId: string, workflowId: string) {
  const workflow = db.select().from(schema.workflows).where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, workspaceId))).get();
  if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow not found');
  return workflow;
}

function assertTrigger(db: AgentisSqliteDb, workspaceId: string, triggerId: string, workflowId: string) {
  const trigger = db.select().from(schema.triggers).where(and(eq(schema.triggers.id, triggerId), eq(schema.triggers.workspaceId, workspaceId), eq(schema.triggers.workflowId, workflowId))).get();
  if (!trigger) throw new AgentisError('TRIGGER_INVALID_CONFIG', 'Trigger not found for workflow');
  return trigger;
}

function assertSchedule(db: AgentisSqliteDb, workspaceId: string, scheduleId: string) {
  const schedule = db.select().from(schema.scheduleRuns).where(and(eq(schema.scheduleRuns.id, scheduleId), eq(schema.scheduleRuns.workspaceId, workspaceId))).get();
  if (!schedule) throw new AgentisError('RESOURCE_NOT_FOUND', 'Schedule not found');
  return schedule;
}

function assertSubscription(db: AgentisSqliteDb, workspaceId: string, subscriptionId: string) {
  const subscription = db.select().from(schema.workflowEventSubscriptions).where(and(eq(schema.workflowEventSubscriptions.id, subscriptionId), eq(schema.workflowEventSubscriptions.workspaceId, workspaceId))).get();
  if (!subscription) throw new AgentisError('RESOURCE_NOT_FOUND', 'Subscription not found');
  return subscription;
}

function assertQueueItem(db: AgentisSqliteDb, workspaceId: string, queueItemId: string) {
  const item = db.select().from(schema.workflowRunQueue).where(and(eq(schema.workflowRunQueue.id, queueItemId), eq(schema.workflowRunQueue.workspaceId, workspaceId))).get();
  if (!item) throw new AgentisError('RESOURCE_NOT_FOUND', 'Queue item not found');
  return item;
}

function assertDelivery(db: AgentisSqliteDb, workspaceId: string, deliveryId: string) {
  const delivery = db.select().from(schema.workflowEventDeliveries).where(and(
    eq(schema.workflowEventDeliveries.id, deliveryId),
    eq(schema.workflowEventDeliveries.workspaceId, workspaceId),
  )).get();
  if (!delivery) throw new AgentisError('RESOURCE_NOT_FOUND', 'Event delivery not found');
  return delivery;
}
