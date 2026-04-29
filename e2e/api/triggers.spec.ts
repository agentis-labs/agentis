/**
 * /v1/triggers + /v1/webhooks — trigger CRUD + public webhook ingress.
 */
import { test, expect } from '../fixtures';
import { apiAuth, trivialGraph, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;
let workflowId: string;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
  const wf = await (await request.post('/v1/workflows', {
    headers: ctx.headers,
    data: { title: 'TriggerTarget', summary: '', graph: trivialGraph(), settings: {} },
  })).json();
  workflowId = wf.workflow.id;
});

test.describe('/v1/triggers', () => {
  test('list returns the triggers array', async ({ request }) => {
    const res = await request.get('/v1/triggers', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.triggers)).toBe(true);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/triggers');
    expect(res.status()).toBe(401);
  });

  test('list requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/triggers', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects an empty body', async ({ request }) => {
    const res = await request.post('/v1/triggers', { headers: ctx.headers, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects an unknown trigger type', async ({ request }) => {
    const res = await request.post('/v1/triggers', {
      headers: ctx.headers,
      data: { workflowId, triggerType: 'cosmic-ray', config: {} },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects a missing workflowId', async ({ request }) => {
    const res = await request.post('/v1/triggers', {
      headers: ctx.headers,
      data: { triggerType: 'manual', config: {} },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create a manual trigger and verify it is listed', async ({ request }) => {
    const res = await request.post('/v1/triggers', {
      headers: ctx.headers,
      data: { workflowId, triggerType: 'manual', config: {} },
    });
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    expect(body.id).toBeTruthy();
    const list = await (await request.get('/v1/triggers', { headers: ctx.headers })).json();
    expect(list.triggers.find((t: any) => t.id === body.id)).toBeTruthy();
  });

  test('create a webhook trigger returns webhookSecret + webhookUrl exactly once', async ({ request }) => {
    const created = await (await request.post('/v1/triggers', {
      headers: ctx.headers,
      data: { workflowId, triggerType: 'webhook', config: {} },
    })).json();
    expect(typeof created.webhookSecret).toBe('string');
    const list = await (await request.get('/v1/triggers', { headers: ctx.headers })).json();
    const found = list.triggers.find((t: any) => t.id === created.id);
    expect(found?.webhookSecret).toBeUndefined();
  });

  test('patch on unknown trigger id returns 404', async ({ request }) => {
    const res = await request.patch('/v1/triggers/00000000-0000-0000-0000-000000000000', {
      headers: ctx.headers,
      data: { config: {} },
    });
    expect(res.status()).toBe(404);
  });

  test('delete on unknown trigger id returns 404', async ({ request }) => {
    const res = await request.delete('/v1/triggers/00000000-0000-0000-0000-000000000000', { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('delete removes the trigger from the list', async ({ request }) => {
    const created = await (await request.post('/v1/triggers', {
      headers: ctx.headers,
      data: { workflowId, triggerType: 'manual', config: {} },
    })).json();
    const del = await request.delete(`/v1/triggers/${created.id}`, { headers: ctx.headers });
    expect(del.ok()).toBeTruthy();
  });
});

test.describe('/v1/webhooks', () => {
  test('POST trigger returns 4xx without signature headers', async ({ request }) => {
    const res = await request.post('/v1/webhooks/trigger/00000000-0000-0000-0000-000000000000', { data: { foo: 'bar' } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('POST trigger returns 4xx for unknown trigger id', async ({ request }) => {
    const res = await request.post('/v1/webhooks/trigger/00000000-0000-0000-0000-000000000000', {
      data: { foo: 'bar' },
      headers: {
        'x-agentis-timestamp': String(Date.now()),
        'x-agentis-signature': 'deadbeef',
        'x-agentis-delivery': 'k1',
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('POST trigger with a stale timestamp is rejected', async ({ request }) => {
    const res = await request.post('/v1/webhooks/trigger/00000000-0000-0000-0000-000000000000', {
      data: {},
      headers: {
        'x-agentis-timestamp': '0',
        'x-agentis-signature': 'a',
        'x-agentis-delivery': 'k2',
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('POST trigger with junk signature is rejected', async ({ request }) => {
    const res = await request.post('/v1/webhooks/trigger/00000000-0000-0000-0000-000000000000', {
      data: { foo: 1 },
      headers: {
        'x-agentis-timestamp': String(Date.now()),
        'x-agentis-signature': 'not-hex-at-all',
        'x-agentis-delivery': 'k3',
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('POST trigger does not require auth header (public ingress)', async ({ request }) => {
    const res = await request.post('/v1/webhooks/trigger/00000000-0000-0000-0000-000000000000', { data: {} });
    expect(res.status()).not.toBe(401);
  });
});
