/**
 * /v1/channels — black-box smoke (Batch 4 / D35).
 *
 * Full CRUD with a real agent dependency requires gateway+credential setup
 * (see gateways.spec.ts). This spec keeps to the auth/validation surface
 * + the unauth webhook ingress so we lock the wiring without coupling to
 * the openclaw fixture chain.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/channels', () => {
  test('list is empty for a freshly seeded workspace', async ({ request }) => {
    const res = await request.get('/v1/channels', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.connections)).toBe(true);
    expect(body.connections.length).toBe(0);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/channels');
    expect(res.status()).toBe(401);
  });

  test('list requires the x-agentis-workspace header', async ({ request }) => {
    const res = await request.get('/v1/channels', {
      headers: { Authorization: `Bearer ${ctx.token}` },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects an empty body (422)', async ({ request }) => {
    const res = await request.post('/v1/channels', { headers: ctx.headers, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('create rejects an unknown channel kind', async ({ request }) => {
    const res = await request.post('/v1/channels', {
      headers: ctx.headers,
      data: {
        kind: 'irc',
        name: 'X',
        agentId: '00000000-0000-0000-0000-000000000000',
        token: 'super-secret-token',
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('create rejects a cross-workspace / unknown agentId', async ({ request }) => {
    const res = await request.post('/v1/channels', {
      headers: ctx.headers,
      data: {
        kind: 'telegram',
        name: 'Tg',
        agentId: '00000000-0000-0000-0000-000000000000',
        token: 'super-secret-token',
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('delete returns 404 for an unknown id', async ({ request }) => {
    const res = await request.delete('/v1/channels/00000000-0000-0000-0000-000000000000', {
      headers: ctx.headers,
    });
    expect(res.status()).toBe(404);
  });
});

test.describe('POST /v1/webhooks/channel/:id (unauth ingress)', () => {
  test('returns 4xx for an unknown connection id (no auth required)', async ({ request }) => {
    const res = await request.post('/v1/webhooks/channel/00000000-0000-0000-0000-000000000000', {
      data: {},
    });
    // Either 404 (unknown id) or 503 (bridge unavailable in some embeddings).
    // Critically: NOT 401, since the route is on the unauth allow-list.
    expect(res.status()).not.toBe(401);
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
