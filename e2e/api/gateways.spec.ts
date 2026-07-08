/**
 * /v1/gateways — fleet pairing surface.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

const FAKE = '00000000-0000-0000-0000-000000000000';

test.describe('/v1/gateways', () => {
  test('list returns the gateways array', async ({ request }) => {
    const res = await request.get('/v1/gateways', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.gateways)).toBe(true);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/gateways');
    expect(res.status()).toBe(401);
  });

  test('list requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/gateways', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('get :id on unknown id returns 404', async ({ request }) => {
    const res = await request.get(`/v1/gateways/${FAKE}`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('pair rejects an empty body', async ({ request }) => {
    const res = await request.post('/v1/gateways/pair', { headers: ctx.headers, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('pair rejects a missing url', async ({ request }) => {
    const res = await request.post('/v1/gateways/pair', {
      headers: ctx.headers,
      data: { name: 'g1', token: 'local-test-token' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('pair rejects a missing token', async ({ request }) => {
    const res = await request.post('/v1/gateways/pair', {
      headers: ctx.headers,
      data: { name: 'g1', url: 'https://gateway.example.com' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('pair rejects a non-https url', async ({ request }) => {
    const res = await request.post('/v1/gateways/pair', {
      headers: ctx.headers,
      data: { name: 'g1', url: 'not-a-url', token: 'local-test-token' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('patch :id on unknown id returns 404', async ({ request }) => {
    const res = await request.patch(`/v1/gateways/${FAKE}`, { headers: ctx.headers, data: { name: 'x' } });
    expect(res.status()).toBe(404);
  });

  test('sync :id on unknown id returns 404', async ({ request }) => {
    const res = await request.post(`/v1/gateways/${FAKE}/sync`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('delete :id on unknown id returns 404', async ({ request }) => {
    const res = await request.delete(`/v1/gateways/${FAKE}`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });
});
