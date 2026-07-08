/**
 * /v1/packages — installable manifest registry.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/packages', () => {
  test('list returns the packages array', async ({ request }) => {
    const res = await request.get('/v1/packages', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.packages)).toBe(true);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/packages');
    expect(res.status()).toBe(401);
  });

  test('list requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/packages', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list is JSON', async ({ request }) => {
    const res = await request.get('/v1/packages', { headers: ctx.headers });
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });

  test('get :id on unknown id returns 404', async ({ request }) => {
    const res = await request.get('/v1/packages/00000000-0000-0000-0000-000000000000', { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('install-local rejects an empty body', async ({ request }) => {
    const res = await request.post('/v1/packages/install-local', { headers: ctx.headers, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('install-local rejects without permissionsAcknowledged', async ({ request }) => {
    const res = await request.post('/v1/packages/install-local', {
      headers: ctx.headers,
      data: { manifest: { kind: 'workflow', slug: 'x', version: '0.0.1' } },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('install-local rejects an invalid manifest', async ({ request }) => {
    const res = await request.post('/v1/packages/install-local', {
      headers: ctx.headers,
      data: { manifest: { kind: 'unknown' }, permissionsAcknowledged: true },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('delete :id on unknown id returns 404', async ({ request }) => {
    const res = await request.delete('/v1/packages/00000000-0000-0000-0000-000000000000', { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });
});
