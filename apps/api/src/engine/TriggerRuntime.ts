/**
 * TriggerRuntime — V1-SPEC §7.
 *
 * Three trigger types are wired here:
 *  - cron: node-cron schedule. Rehydrated on boot from active triggers.
 *  - webhook: WebhookRouter consults this to look up the configured trigger
 *    + secret + idempotency window. The runtime exposes `fireWebhook()`.
 *  - persistent_listener: `AgentAdapter.createPersistentListener` is invoked
 *    once per active trigger and the returned handle is stashed for cleanup.
 *
 * `manual` is not handled here — that's a UI-side dispatch through
 * `/v1/workflows/:id/run`.
 *
 * `fire()` is the single entrypoint that creates a WorkflowRun row and asks
 * the engine to start it. Every fire path (cron, webhook, listener) goes
 * through it so observability is uniform.
 */

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { CONSTANTS, AgentisError, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { ActiveWorkflowRegistry, ActiveTrigger } from './ActiveWorkflowRegistry.js';
import type { WorkflowEngine } from './WorkflowEngine.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import { buildInitialRunState } from './initialRunState.js';

interface CronLib {
  schedule(expression: string, callback: () => void, options?: { scheduled?: boolean; timezone?: string }): {
    start(): void;
    stop(): void;
  };
  validate(expression: string): boolean;
}

let cachedCron:
  | { kind: 'available'; cron: CronLib }
  | { kind: 'unavailable'; reason: string }
  | undefined;

async function loadCron() {
  if (cachedCron) return cachedCron;
  try {
    const mod = (await import('node-cron' as string)) as { default?: CronLib } & CronLib;
    cachedCron = { kind: 'available', cron: (mod.default ?? mod) as CronLib };
  } catch (err) {
    cachedCron = { kind: 'unavailable', reason: (err as Error).message };
  }
  return cachedCron;
}

export interface TriggerRuntimeDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  registry: ActiveWorkflowRegistry;
  engine: WorkflowEngine;
  adapters: AdapterManager;
}

export class TriggerRuntime {
  constructor(private readonly deps: TriggerRuntimeDeps) {}

  /** Rehydrate every active trigger from DB on boot. */
  async hydrate(): Promise<void> {
    const active = this.deps.registry.loadActiveFromDb();
    for (const t of active) {
      try {
        await this.activate(t);
      } catch (err) {
        this.deps.logger.error('trigger.hydrate_failed', { triggerId: t.triggerId, err: (err as Error).message });
      }
    }
  }

  /** Activate a trigger row. Idempotent — re-activating replaces the cleanup. */
  async activate(t: ActiveTrigger): Promise<void> {
    await this.deps.registry.deactivate(t.triggerId).catch(() => {});
    switch (t.triggerType) {
      case 'cron':
        await this.#activateCron(t);
        return;
      case 'webhook':
        // Webhooks are stateless — they just need the row to be marked active
        // and the secret to be present. WebhookRouter handles dispatch.
        this.deps.registry.activate(t, async () => {});
        return;
      case 'persistent_listener':
        await this.#activatePersistentListener(t);
        return;
      case 'manual':
        return; // no runtime resources
    }
  }

  async deactivate(triggerId: string): Promise<void> {
    await this.deps.registry.deactivate(triggerId);
  }

  async #activateCron(t: ActiveTrigger): Promise<void> {
    const expression = String((t.config as { expression?: string }).expression ?? '');
    if (!expression) throw new AgentisError('TRIGGER_INVALID_CONFIG', 'cron trigger requires `expression`');
    const loaded = await loadCron();
    if (loaded.kind === 'unavailable') {
      this.deps.logger.warn('trigger.cron_unavailable', { reason: loaded.reason });
      throw new AgentisError('TRIGGER_INVALID_CONFIG', `node-cron not installed: ${loaded.reason}`);
    }
    const { cron } = loaded;
    if (!cron.validate(expression)) {
      throw new AgentisError('TRIGGER_INVALID_CONFIG', `invalid cron expression: ${expression}`);
    }
    const job = cron.schedule(expression, () => {
      void this.fire({ trigger: t, payload: { firedAt: new Date().toISOString() } }).catch((err) =>
        this.deps.logger.error('trigger.cron_fire_failed', { triggerId: t.triggerId, err: (err as Error).message }),
      );
    });
    job.start();
    this.deps.registry.activate(t, async () => job.stop());
  }

  async #activatePersistentListener(t: ActiveTrigger): Promise<void> {
    const agentId = String((t.config as { agentId?: string }).agentId ?? '');
    if (!agentId) throw new AgentisError('TRIGGER_INVALID_CONFIG', 'persistent_listener requires agentId');
    const reg = this.deps.adapters.get(agentId);
    if (!reg || !reg.adapter.createPersistentListener) {
      this.deps.logger.warn('trigger.listener_unavailable', { triggerId: t.triggerId, agentId });
      this.deps.registry.activate(t, async () => {});
      return;
    }
    const handle = await reg.adapter.createPersistentListener({
      triggerId: t.triggerId,
      workflowId: t.workflowId,
      triggerType: 'persistent_listener',
      config: t.config,
    });
    this.deps.registry.activate(t, async () => {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    });
  }

  /** Common fire path → create run + start engine. */
  async fire(args: { trigger: ActiveTrigger; payload: Record<string, unknown> }): Promise<{ runId: string }> {
    const workflow = this.deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, args.trigger.workflowId))
      .get();
    if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${args.trigger.workflowId} missing`);
    const graph = workflow.graph as WorkflowGraph;
    const runId = randomUUID();
    const initialState = buildInitialRunState({
      runId,
      workflowId: workflow.id,
      graph,
      inputs: args.payload,
    });
    this.deps.db
      .insert(schema.workflowRuns)
      .values({
        id: runId,
        workspaceId: args.trigger.workspaceId,
        ambientId: args.trigger.ambientId,
        workflowId: workflow.id,
        userId: args.trigger.userId,
        status: 'CREATED',
        runState: initialState as unknown as object,
        replanCount: 0,
        triggerId: args.trigger.triggerId,
        parentRunId: null,
      })
      .run();
    this.deps.db
      .update(schema.triggers)
      .set({ lastFiredAt: new Date().toISOString() })
      .where(eq(schema.triggers.id, args.trigger.triggerId))
      .run();
    await this.deps.engine.startRun({
      workspaceId: args.trigger.workspaceId,
      ambientId: args.trigger.ambientId,
      workflowId: workflow.id,
      userId: args.trigger.userId,
      triggerId: args.trigger.triggerId,
      inputs: args.payload,
      initialState,
      graph,
    });
    return { runId };
  }

  // ─────────────────────────────────────────────
  // Webhook helpers
  // ─────────────────────────────────────────────

  /**
   * Verify HMAC + timestamp + idempotency key for a webhook payload, then fire.
   * Throws AgentisError on validation failure (route handler converts to HTTP).
   */
  async fireWebhook(args: {
    triggerId: string;
    rawBody: string;
    signature: string;
    timestampHeader: string;
    deliveryId: string;
  }): Promise<{ runId: string; idempotent: boolean }> {
    const trigger = this.deps.db.select().from(schema.triggers).where(eq(schema.triggers.id, args.triggerId)).get();
    if (!trigger) throw new AgentisError('RESOURCE_NOT_FOUND', `trigger ${args.triggerId} not found`);
    if (trigger.triggerType !== 'webhook') throw new AgentisError('TRIGGER_INVALID_CONFIG', 'not a webhook trigger');
    if (trigger.status !== 'active') throw new AgentisError('TRIGGER_NOT_ACTIVE', 'trigger is not active');
    if (!trigger.webhookSecret) throw new AgentisError('TRIGGER_INVALID_CONFIG', 'trigger missing webhookSecret');

    const ts = Number(args.timestampHeader);
    if (!ts) throw new AgentisError('WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE', 'missing/invalid timestamp header');
    const skew = Math.abs(Date.now() - ts);
    if (skew > CONSTANTS.WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
      throw new AgentisError('WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE', `timestamp skew ${skew}ms exceeds tolerance`);
    }
    const expected = createHmac('sha256', trigger.webhookSecret).update(`${ts}.${args.rawBody}`).digest('hex');
    if (expected.length !== args.signature.length) {
      throw new AgentisError('WEBHOOK_SIGNATURE_INVALID', 'signature length mismatch');
    }
    let ok = false;
    try {
      ok = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(args.signature, 'hex'));
    } catch {
      ok = false;
    }
    if (!ok) throw new AgentisError('WEBHOOK_SIGNATURE_INVALID', 'invalid HMAC');

    // Idempotency dedup.
    const existing = this.deps.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.deliveryId, args.deliveryId))
      .get();
    if (existing) {
      return { runId: existing.responseRunId ?? '', idempotent: true };
    }

    const t: ActiveTrigger = {
      triggerId: trigger.id,
      workflowId: trigger.workflowId,
      workspaceId: trigger.workspaceId,
      ambientId: trigger.ambientId,
      userId: trigger.userId,
      triggerType: 'webhook',
      config: (trigger.config ?? {}) as Record<string, unknown>,
    };
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(args.rawBody) as Record<string, unknown>;
    } catch {
      payload = { raw: args.rawBody };
    }
    const result = await this.fire({ trigger: t, payload });
    this.deps.db
      .insert(schema.webhookDeliveries)
      .values({
        id: randomUUID(),
        triggerId: trigger.id,
        workspaceId: trigger.workspaceId,
        deliveryId: args.deliveryId,
        status: 'accepted',
        responseRunId: result.runId,
      })
      .run();
    return { runId: result.runId, idempotent: false };
  }
}
