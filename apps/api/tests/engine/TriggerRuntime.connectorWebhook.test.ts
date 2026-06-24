/**
 * TriggerRuntime.fireConnectorWebhook — native SaaS webhook ingress.
 *
 * Verifies a PROVIDER's own signature (here GitHub's x-hub-signature-256) using
 * the trigger's stored secret, fires the workflow once, and is idempotent on
 * replay. A forged signature is rejected. This is the seam that turns the 14
 * built-but-unreachable provider verifiers on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { TriggerRuntime, type TriggerRuntimeDeps } from '../../src/engine/TriggerRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function githubHeaders(secret: string, rawBody: string, delivery: string, event = 'push'): Record<string, string> {
  const sig = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return { 'x-hub-signature-256': sig, 'x-github-delivery': delivery, 'x-github-event': event };
}

/** A TriggerRuntime whose workflow dispatch is stubbed — we only exercise verify+idempotency+deliver. */
function makeRuntime(): { runtime: TriggerRuntime; fired: Array<Record<string, unknown>> } {
  const fired: Array<Record<string, unknown>> = [];
  const deps = {
    db: ctx.db,
    logger: ctx.logger,
    bus: ctx.bus,
    registry: {} as unknown,
    engine: {} as unknown,
    adapters: {} as unknown,
  } as unknown as TriggerRuntimeDeps;
  const runtime = new TriggerRuntime(deps);
  // Override the (public) fire() so we don't need a real engine/registry.
  (runtime as unknown as { fire: (a: { payload: Record<string, unknown> }) => Promise<{ runId: string }> }).fire =
    async (a) => { fired.push(a.payload); return { runId: `run-${fired.length}` }; };
  return { runtime, fired };
}

function seedWebhookTrigger(secret: string, connector = 'github'): string {
  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'wf', graph: { version: 1, nodes: [], edges: [] }, settings: {} }).run();
  const triggerId = randomUUID();
  ctx.db.insert(schema.triggers).values({
    id: triggerId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: wfId,
    userId: ctx.user.id,
    triggerType: 'webhook',
    config: { connector },
    status: 'active',
    webhookSecret: secret,
  }).run();
  return triggerId;
}

describe('TriggerRuntime.fireConnectorWebhook', () => {
  it('verifies a valid GitHub signature, fires once, and is idempotent on replay', async () => {
    const { runtime, fired } = makeRuntime();
    const secret = 'gh-signing-secret';
    const triggerId = seedWebhookTrigger(secret);
    const body = JSON.stringify({ action: 'opened', number: 7 });
    const headers = githubHeaders(secret, body, 'delivery-1', 'pull_request');

    const first = await runtime.fireConnectorWebhook({ triggerId, rawBody: body, headers });
    expect(first.idempotent).toBe(false);
    expect(first.eventType).toBe('pull_request');
    expect(first.runId).toBe('run-1');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ action: 'opened', number: 7, eventType: 'pull_request' });

    // Same delivery id → idempotent no-op, no second fire.
    const replay = await runtime.fireConnectorWebhook({ triggerId, rawBody: body, headers });
    expect(replay.idempotent).toBe(true);
    expect(fired).toHaveLength(1);
  });

  it('rejects a forged signature', async () => {
    const { runtime, fired } = makeRuntime();
    const triggerId = seedWebhookTrigger('the-real-secret');
    const body = JSON.stringify({ x: 1 });
    const headers = githubHeaders('WRONG-secret', body, 'delivery-2');
    await expect(runtime.fireConnectorWebhook({ triggerId, rawBody: body, headers })).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
    expect(fired).toHaveLength(0);
  });

  it('refuses a trigger with no SaaS connector (generic)', async () => {
    const { runtime } = makeRuntime();
    const triggerId = seedWebhookTrigger('s', 'generic');
    const body = '{}';
    await expect(runtime.fireConnectorWebhook({ triggerId, rawBody: body, headers: {} })).rejects.toMatchObject({
      code: 'TRIGGER_INVALID_CONFIG',
    });
  });
});
