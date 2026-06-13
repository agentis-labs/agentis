/**
 * TriggerRuntime — V1-SPEC §7. Cron / webhook / listener / fire path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AgentisError, CONSTANTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';
import { ActiveWorkflowRegistry, type ActiveTrigger } from '../../src/engine/ActiveWorkflowRegistry.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import type { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: ActiveWorkflowRegistry;
let engine: { startRun: ReturnType<typeof vi.fn> };
let adapters: { get: ReturnType<typeof vi.fn> };
let runtime: TriggerRuntime;

beforeEach(async () => {
  ctx = await createTestContext();
  registry = new ActiveWorkflowRegistry(ctx.db, ctx.logger);
  engine = { startRun: vi.fn().mockResolvedValue({ runId: 'unused', workflowId: 'unused' }) };
  adapters = { get: vi.fn().mockReturnValue(undefined) };
  runtime = new TriggerRuntime({
    db: ctx.db,
    logger: ctx.logger,
    registry,
    engine: engine as unknown as WorkflowEngine,
    adapters: adapters as unknown as AdapterManager,
    bus: ctx.bus,
  });
});
afterEach(() => ctx.close());

const trivialGraph: WorkflowGraph = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'T', type: 'trigger', title: 'T', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
  ],
  edges: [],
};

function seedTrigger(opts: {
  type: 'cron' | 'webhook' | 'persistent_listener' | 'manual';
  config?: Record<string, unknown>;
  webhookSecret?: string;
  status?: string;
  graph?: WorkflowGraph;
}) {
  const wfId = randomUUID();
  const triggerId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'trigger-wf',
      graph: opts.graph ?? trivialGraph,
      settings: {},
    })
    .run();
  ctx.db
    .insert(schema.triggers)
    .values({
      id: triggerId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      triggerType: opts.type,
      config: opts.config ?? {},
      status: opts.status ?? 'paused',
      webhookSecret: opts.webhookSecret ?? null,
    })
    .run();
  return { wfId, triggerId };
}

describe('TriggerRuntime — fire()', () => {
  it('creates a workflow_runs row and calls engine.startRun', async () => {
    const { wfId, triggerId } = seedTrigger({ type: 'manual' });
    const t: ActiveTrigger = {
      triggerId,
      workflowId: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      triggerType: 'manual',
      config: {},
    };
    const { runId } = await runtime.fire({ trigger: t, payload: { hello: 'world' } });
    expect(engine.startRun).toHaveBeenCalledOnce();
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    expect(row?.workflowId).toBe(wfId);
    expect(row?.triggerId).toBe(triggerId);
    expect(row?.status).toBe('CREATED');
    // lastFiredAt updated.
    const trigRow = ctx.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get();
    expect(trigRow?.lastFiredAt).toBeTruthy();
  });

  it('normalizes the graph before dispatch and heals the stored row (parity with API run path)', async () => {
    // A graph synthesized with an operationId the connector does not support.
    // The manual `/run` path heals the stored row via loadWorkflow; the trigger
    // path must converge it too, so the canvas/exports don't keep showing a stale
    // draft that differs from what every scheduled/webhook run executes.
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'T', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'send', type: 'integration', title: 'Send', position: { x: 200, y: 0 }, config: { kind: 'integration', integrationId: 'agentmail', operationId: 'send_email', inputs: {} } as never },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'send' }],
    };
    const { wfId, triggerId } = seedTrigger({ type: 'cron', graph });
    const t: ActiveTrigger = {
      triggerId,
      workflowId: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      triggerType: 'cron',
      config: {},
    };
    await runtime.fire({ trigger: t, payload: {} });
    // Dispatched graph was normalized.
    const dispatched = engine.startRun.mock.calls[0]?.[0] as { graph: WorkflowGraph } | undefined;
    const sentOp = (dispatched?.graph.nodes.find((n) => n.id === 'send')?.config as { operationId?: string } | undefined)?.operationId;
    expect(sentOp).toBe('send_message');
    // Stored row healed too — the next fire is a no-op normalization.
    const persisted = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, wfId)).get();
    const storedOp = ((persisted?.graph as WorkflowGraph).nodes.find((n) => n.id === 'send')?.config as { operationId?: string } | undefined)?.operationId;
    expect(storedOp).toBe('send_message');
  });

  it('throws RESOURCE_NOT_FOUND when workflow is missing', async () => {
    const t: ActiveTrigger = {
      triggerId: randomUUID(),
      workflowId: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      triggerType: 'manual',
      config: {},
    };
    await expect(runtime.fire({ trigger: t, payload: {} })).rejects.toThrow(AgentisError);
  });
});

describe('TriggerRuntime — fireWebhook()', () => {
  const SECRET = 'super-secret-key';

  function signedHeaders(body: string) {
    const ts = String(Date.now());
    const sig = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    return { ts, sig };
  }

  it('rejects unknown trigger with RESOURCE_NOT_FOUND', async () => {
    await expect(
      runtime.fireWebhook({
        triggerId: randomUUID(),
        rawBody: '{}',
        signature: 'x',
        timestampHeader: '0',
        deliveryId: 'd1',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects non-active trigger with TRIGGER_NOT_ACTIVE', async () => {
    const { triggerId } = seedTrigger({ type: 'webhook', webhookSecret: SECRET, status: 'paused' });
    const body = '{}';
    const { ts, sig } = signedHeaders(body);
    await expect(
      runtime.fireWebhook({ triggerId, rawBody: body, signature: sig, timestampHeader: ts, deliveryId: 'd1' }),
    ).rejects.toThrow(AgentisError);
  });

  it('rejects timestamp out of tolerance', async () => {
    const { triggerId } = seedTrigger({ type: 'webhook', webhookSecret: SECRET, status: 'active' });
    const body = '{}';
    const oldTs = String(Date.now() - CONSTANTS.WEBHOOK_TIMESTAMP_TOLERANCE_MS - 5_000);
    const sig = createHmac('sha256', SECRET).update(`${oldTs}.${body}`).digest('hex');
    await expect(
      runtime.fireWebhook({ triggerId, rawBody: body, signature: sig, timestampHeader: oldTs, deliveryId: 'd1' }),
    ).rejects.toThrow(/tolerance/);
  });

  it('rejects bad HMAC with WEBHOOK_SIGNATURE_INVALID', async () => {
    const { triggerId } = seedTrigger({ type: 'webhook', webhookSecret: SECRET, status: 'active' });
    const body = '{"x":1}';
    const ts = String(Date.now());
    const wrongSig = createHmac('sha256', 'wrong-secret').update(`${ts}.${body}`).digest('hex');
    await expect(
      runtime.fireWebhook({ triggerId, rawBody: body, signature: wrongSig, timestampHeader: ts, deliveryId: 'd1' }),
    ).rejects.toThrow(/HMAC|signature/i);
  });

  it('accepts a valid signed delivery and creates a run', async () => {
    const { triggerId } = seedTrigger({ type: 'webhook', webhookSecret: SECRET, status: 'active' });
    const body = '{"x":42}';
    const { ts, sig } = signedHeaders(body);
    const result = await runtime.fireWebhook({
      triggerId,
      rawBody: body,
      signature: sig,
      timestampHeader: ts,
      deliveryId: 'delivery-1',
    });
    expect(result.idempotent).toBe(false);
    expect(result.runId).toBeTruthy();
    expect(engine.startRun).toHaveBeenCalledOnce();
    // Delivery row recorded.
    const dr = ctx.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.deliveryId, 'delivery-1'))
      .get();
    expect(dr?.responseRunId).toBe(result.runId);
  });

  it('replays a duplicate deliveryId as idempotent', async () => {
    const { triggerId } = seedTrigger({ type: 'webhook', webhookSecret: SECRET, status: 'active' });
    const body = '{"x":42}';
    const { ts, sig } = signedHeaders(body);
    const first = await runtime.fireWebhook({
      triggerId,
      rawBody: body,
      signature: sig,
      timestampHeader: ts,
      deliveryId: 'dup-1',
    });
    const second = await runtime.fireWebhook({
      triggerId,
      rawBody: body,
      signature: sig,
      timestampHeader: ts,
      deliveryId: 'dup-1',
    });
    expect(second.idempotent).toBe(true);
    expect(second.runId).toBe(first.runId);
    // engine called only once across both attempts.
    expect(engine.startRun).toHaveBeenCalledOnce();
  });

  it('scopes the same deliveryId independently per webhook trigger', async () => {
    const firstTrigger = seedTrigger({ type: 'webhook', webhookSecret: SECRET, status: 'active' }).triggerId;
    const secondTrigger = seedTrigger({ type: 'webhook', webhookSecret: SECRET, status: 'active' }).triggerId;
    const body = '{"x":42}';
    const { ts, sig } = signedHeaders(body);
    const first = await runtime.fireWebhook({ triggerId: firstTrigger, rawBody: body, signature: sig, timestampHeader: ts, deliveryId: 'shared-id' });
    const second = await runtime.fireWebhook({ triggerId: secondTrigger, rawBody: body, signature: sig, timestampHeader: ts, deliveryId: 'shared-id' });
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(false);
    expect(engine.startRun).toHaveBeenCalledTimes(2);
  });
});

describe('TriggerRuntime — activate()', () => {
  it('webhook activation marks trigger active and registers a no-op cleanup', async () => {
    const { triggerId } = seedTrigger({ type: 'webhook', webhookSecret: 's' });
    const t: ActiveTrigger = {
      triggerId,
      workflowId: 'wf',
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      triggerType: 'webhook',
      config: {},
    };
    await runtime.activate(t);
    expect(registry.get(triggerId)).toBeDefined();
    const row = ctx.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get();
    expect(row?.status).toBe('active');
  });

  it('manual activation is a no-op (no registry entry)', async () => {
    const { triggerId } = seedTrigger({ type: 'manual' });
    const t: ActiveTrigger = {
      triggerId,
      workflowId: 'wf',
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      triggerType: 'manual',
      config: {},
    };
    await runtime.activate(t);
    expect(registry.get(triggerId)).toBeUndefined();
  });

  it('persistent_listener with no agentId throws TRIGGER_INVALID_CONFIG', async () => {
    const { triggerId } = seedTrigger({ type: 'persistent_listener' });
    const t: ActiveTrigger = {
      triggerId,
      workflowId: 'wf',
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      triggerType: 'persistent_listener',
      config: {},
    };
    await expect(runtime.activate(t)).rejects.toThrow(/agentId/);
  });

  it('persistent_listener with unknown agent registers an empty cleanup (degrades gracefully)', async () => {
    const { triggerId } = seedTrigger({
      type: 'persistent_listener',
      config: { agentId: 'missing-agent' },
    });
    const t: ActiveTrigger = {
      triggerId,
      workflowId: 'wf',
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      triggerType: 'persistent_listener',
      config: { agentId: 'missing-agent' },
    };
    await runtime.activate(t);
    expect(registry.get(triggerId)).toBeDefined();
  });
});
