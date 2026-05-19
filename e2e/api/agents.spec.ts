/**
 * /v1/agents — list/get/create/update/delete + workspace scoping.
 *
 * Note: creating an `openclaw` adapter requires a paired gateway + device
 * token credential, so we focus on validation + listing here. End-to-end
 * agent lifecycle that needs a real gateway is exercised in gateways.spec.ts.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/agents', () => {
  test('list is empty for a freshly seeded workspace', async ({ request }) => {
    const res = await request.get('/v1/agents', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBe(0);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/agents');
    expect(res.status()).toBe(401);
  });

  test('list requires the x-agentis-workspace header', async ({ request }) => {
    const res = await request.get('/v1/agents', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list response is JSON', async ({ request }) => {
    const res = await request.get('/v1/agents', { headers: ctx.headers });
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });

  test('list returns connectionSummary for each agent', async ({ request }) => {
    const created = await request.post('/v1/agents', {
      headers: ctx.headers,
      data: {
        name: 'Summary Agent',
        adapterType: 'http',
        role: 'worker',
        config: { url: 'http://127.0.0.1:9' },
      },
    });
    expect(created.status()).toBe(201);

    const res = await request.get('/v1/agents', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Summary Agent',
          connectionSummary: expect.objectContaining({
            apps: expect.any(Array),
            workflows: expect.any(Array),
            totalApps: expect.any(Number),
            totalWorkflows: expect.any(Number),
          }),
        }),
      ]),
    );
  });

  test('get :id returns 404 for an unknown id', async ({ request }) => {
    const res = await request.get('/v1/agents/00000000-0000-0000-0000-000000000000', { headers: ctx.headers });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe('RESOURCE_NOT_FOUND');
  });

  test('get :id requires authentication', async ({ request }) => {
    const res = await request.get('/v1/agents/00000000-0000-0000-0000-000000000000');
    expect(res.status()).toBe(401);
  });

  test('create rejects an empty body', async ({ request }) => {
    const res = await request.post('/v1/agents', { headers: ctx.headers, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('create rejects an unknown adapterType', async ({ request }) => {
    const res = await request.post('/v1/agents', {
      headers: ctx.headers,
      data: { name: 'X', adapterType: 'totally-made-up' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects missing name', async ({ request }) => {
    const res = await request.post('/v1/agents', {
      headers: ctx.headers,
      data: { adapterType: 'http' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects missing adapterType', async ({ request }) => {
    const res = await request.post('/v1/agents', {
      headers: ctx.headers,
      data: { name: 'NoType' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create requires authentication', async ({ request }) => {
    const res = await request.post('/v1/agents', { data: { name: 'X', adapterType: 'http' } });
    expect(res.status()).toBe(401);
  });

  test('patch on unknown id returns 404', async ({ request }) => {
    const res = await request.patch('/v1/agents/00000000-0000-0000-0000-000000000000', {
      headers: ctx.headers,
      data: { name: 'New' },
    });
    expect(res.status()).toBe(404);
  });

  test('delete on unknown id returns 404', async ({ request }) => {
    const res = await request.delete('/v1/agents/00000000-0000-0000-0000-000000000000', { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('terminal/send on unknown agent returns 404', async ({ request }) => {
    const res = await request.post('/v1/agents/00000000-0000-0000-0000-000000000000/terminal/send', {
      headers: ctx.headers,
      data: { body: 'hello' },
    });
    expect(res.status()).toBe(404);
  });

  test('cancel-task on unknown agent returns 404', async ({ request }) => {
    const res = await request.post('/v1/agents/00000000-0000-0000-0000-000000000000/cancel-task/00000000-0000-0000-0000-000000000001', {
      headers: ctx.headers,
    });
    expect(res.status()).toBe(404);
  });

  test('GET /v1/agents/:id/terminal returns 404 for unknown agent', async ({ request }) => {
    const res = await request.get('/v1/agents/00000000-0000-0000-0000-000000000000/terminal', { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('terminal/send rejects an empty body', async ({ request }) => {
    const res = await request.post('/v1/agents/00000000-0000-0000-0000-000000000000/terminal/send', {
      headers: ctx.headers,
      data: { body: '' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list does not leak any agents from another workspace seed', async ({ request }) => {
    // After reset only the operator user exists; their seeded workspace has 0 agents.
    const res = await request.get('/v1/agents', { headers: ctx.headers });
    const body = await res.json();
    for (const a of body.agents) expect(a.workspaceId).toBe(ctx.workspace.id);
  });
});
