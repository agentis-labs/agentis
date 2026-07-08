/**
 * /v1/tasks — read-only.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/tasks', () => {
  test('list returns a tasks array', async ({ request }) => {
    const res = await request.get('/v1/tasks', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/tasks');
    expect(res.status()).toBe(401);
  });

  test('list requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/tasks', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list with limit=1 returns at most one task', async ({ request }) => {
    const res = await request.get('/v1/tasks?limit=1', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.tasks.length).toBeLessThanOrEqual(1);
  });

  test('list with very large limit does not crash', async ({ request }) => {
    const res = await request.get('/v1/tasks?limit=99999', { headers: ctx.headers });
    expect(res.status()).toBeLessThan(500);
  });

  test('list filtered by an unknown agentId returns []', async ({ request }) => {
    const res = await request.get('/v1/tasks?agentId=00000000-0000-0000-0000-000000000000', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.tasks.length).toBe(0);
  });

  test('list response is JSON', async ({ request }) => {
    const res = await request.get('/v1/tasks', { headers: ctx.headers });
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });
});
