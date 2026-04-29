/**
 * /v1/activity, /v1/approvals, /v1/dashboard — read-only operator surface.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/activity', () => {
  test('list returns the events array', async ({ request }) => {
    const res = await request.get('/v1/activity', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/activity');
    expect(res.status()).toBe(401);
  });

  test('list requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/activity', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list with limit=1 returns at most one event', async ({ request }) => {
    const res = await request.get('/v1/activity?limit=1', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.events.length).toBeLessThanOrEqual(1);
  });

  test('list with very large limit does not crash', async ({ request }) => {
    const res = await request.get('/v1/activity?limit=99999', { headers: ctx.headers });
    expect(res.status()).toBeLessThan(500);
  });

  test('list response is JSON', async ({ request }) => {
    const res = await request.get('/v1/activity', { headers: ctx.headers });
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });
});

test.describe('/v1/approvals', () => {
  test('list with default filter returns the approvals array', async ({ request }) => {
    const res = await request.get('/v1/approvals', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.approvals)).toBe(true);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/approvals');
    expect(res.status()).toBe(401);
  });

  test('list requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/approvals', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list with status=pending returns the array', async ({ request }) => {
    const res = await request.get('/v1/approvals?status=pending', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
  });

  test('list with status=all returns the array', async ({ request }) => {
    const res = await request.get('/v1/approvals?status=all', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
  });

  test('resolve on unknown id returns 404', async ({ request }) => {
    const res = await request.post('/v1/approvals/00000000-0000-0000-0000-000000000000/resolve', {
      headers: ctx.headers,
      data: { decision: 'approve' },
    });
    expect(res.status()).toBe(404);
  });

  test('resolve rejects an invalid decision', async ({ request }) => {
    const res = await request.post('/v1/approvals/00000000-0000-0000-0000-000000000000/resolve', {
      headers: ctx.headers,
      data: { decision: 'maybe' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('resolve rejects an empty body', async ({ request }) => {
    const res = await request.post('/v1/approvals/00000000-0000-0000-0000-000000000000/resolve', {
      headers: ctx.headers,
      data: {},
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});

test.describe('/v1/dashboard', () => {
  test('fleet-overview returns the documented shape', async ({ request }) => {
    const res = await request.get('/v1/dashboard/fleet-overview', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.agents.total).toBe('number');
    expect(typeof body.agents.online).toBe('number');
    expect(typeof body.gateways.total).toBe('number');
    expect(typeof body.gateways.connected).toBe('number');
    expect(typeof body.workflows.total).toBe('number');
    expect(typeof body.runs.active).toBe('number');
    expect(typeof body.approvals.pending).toBe('number');
  });

  test('fleet-overview includes operator profile', async ({ request }) => {
    const res = await request.get('/v1/dashboard/fleet-overview', { headers: ctx.headers });
    const body = await res.json();
    expect(body.operator.username).toBe('operator');
  });

  test('fleet-overview requires authentication', async ({ request }) => {
    const res = await request.get('/v1/dashboard/fleet-overview');
    expect(res.status()).toBe(401);
  });

  test('fleet-overview requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/dashboard/fleet-overview', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('fleet-overview response is JSON', async ({ request }) => {
    const res = await request.get('/v1/dashboard/fleet-overview', { headers: ctx.headers });
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });

  test('fleet-overview reports recent runs as an array', async ({ request }) => {
    const res = await request.get('/v1/dashboard/fleet-overview', { headers: ctx.headers });
    const body = await res.json();
    expect(Array.isArray(body.runs.recent)).toBe(true);
  });
});
