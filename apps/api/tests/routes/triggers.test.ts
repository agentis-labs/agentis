/**
 * /v1/triggers — route unit tests.
 *
 * TriggerRuntime is stubbed via vi.fn() — runtime side effects (cron schedule,
 * persistent listener wiring) live in their own engine test suites.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildTriggerRoutes } from '../../src/routes/triggers.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';

let ctx: TestContext;
let runtime: { activate: ReturnType<typeof vi.fn>; deactivate: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  ctx = await createTestContext();
  runtime = {
    activate: vi.fn().mockResolvedValue(undefined),
    deactivate: vi.fn().mockResolvedValue(undefined),
  };
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/triggers',
      app: buildTriggerRoutes({
        db: ctx.db,
        auth: ctx.auth,
        runtime: runtime as unknown as TriggerRuntime,
      }),
    },
  ]);
}

function seedWorkflow() {
  const id = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'WF',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      settings: {},
    })
    .run();
  return id;
}

describe('POST /v1/triggers', () => {
  it('creates a webhook trigger and returns the secret exactly once', async () => {
    const wfId = seedWorkflow();
    const res = await app().request('/v1/triggers', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ workflowId: wfId, triggerType: 'webhook' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; webhookSecret: string };
    expect(body.webhookSecret).toBeTruthy();
  });

  it('does NOT return a secret for non-webhook triggers', async () => {
    const wfId = seedWorkflow();
    const res = await app().request('/v1/triggers', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ workflowId: wfId, triggerType: 'manual' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.webhookSecret).toBeUndefined();
  });

  it('returns 404 for an unknown workflow', async () => {
    const res = await app().request('/v1/triggers', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ workflowId: randomUUID(), triggerType: 'manual' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('GET /v1/triggers', () => {
  it('lists triggers and strips webhookSecret', async () => {
    const wfId = seedWorkflow();
    await app().request('/v1/triggers', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ workflowId: wfId, triggerType: 'webhook' }),
    });
    const res = await app().request('/v1/triggers', { headers: ctx.authHeaders });
    const text = await res.text();
    expect(text).not.toContain('webhookSecret');
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/triggers');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /v1/triggers/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await app().request(`/v1/triggers/${randomUUID()}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /v1/triggers/:id', () => {
  it('deletes the trigger and calls runtime.deactivate', async () => {
    const wfId = seedWorkflow();
    const create = await app().request('/v1/triggers', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ workflowId: wfId, triggerType: 'manual' }),
    });
    const { id } = (await create.json()) as { id: string };
    const res = await app().request(`/v1/triggers/${id}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    expect(runtime.deactivate).toHaveBeenCalledWith(id);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app().request(`/v1/triggers/${randomUUID()}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(404);
  });
});
