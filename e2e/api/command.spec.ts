/**
 * /v1/command — Cmd+K palette backend.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/command/search', () => {
  test('returns hits array for a basic query', async ({ request }) => {
    const res = await request.get('/v1/command/search?q=workspace', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.hits)).toBe(true);
  });

  test('returns hits array for an empty query', async ({ request }) => {
    const res = await request.get('/v1/command/search?q=', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.hits)).toBe(true);
  });

  test('requires authentication', async ({ request }) => {
    const res = await request.get('/v1/command/search?q=x');
    expect(res.status()).toBe(401);
  });

  test('requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/command/search?q=x', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('returns JSON', async ({ request }) => {
    const res = await request.get('/v1/command/search?q=hello', { headers: ctx.headers });
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });

  test('handles a long query string without crashing', async ({ request }) => {
    const q = 'x'.repeat(500);
    const res = await request.get(`/v1/command/search?q=${q}`, { headers: ctx.headers });
    expect(res.status()).toBeLessThan(500);
  });
});
