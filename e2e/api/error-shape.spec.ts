/**
 * Cross-cutting wire-shape contract: error envelope, status code consistency.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

const FAKE = '00000000-0000-0000-0000-000000000000';

async function expectErrorEnvelope(res: any) {
  const body = await res.json();
  expect(body.error).toBeTruthy();
  expect(typeof body.error.code).toBe('string');
  expect(typeof body.error.message).toBe('string');
}

test.describe('Error envelope contract', () => {
  test('401 from /v1/agents has error.code', async ({ request }) => {
    const res = await request.get('/v1/agents');
    expect(res.status()).toBe(401);
    await expectErrorEnvelope(res);
  });

  test('401 from /v1/workflows has error.code', async ({ request }) => {
    const res = await request.get('/v1/workflows');
    expect(res.status()).toBe(401);
    await expectErrorEnvelope(res);
  });

  test('401 from /v1/runs has error.code', async ({ request }) => {
    const res = await request.get('/v1/runs');
    expect(res.status()).toBe(401);
    await expectErrorEnvelope(res);
  });

  test('404 from /v1/agents/:id has error.code', async ({ request }) => {
    const res = await request.get(`/v1/agents/${FAKE}`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
    await expectErrorEnvelope(res);
  });

  test('404 from /v1/workflows/:id has error.code', async ({ request }) => {
    const res = await request.get(`/v1/workflows/${FAKE}`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
    await expectErrorEnvelope(res);
  });

  test('404 from /v1/runs/:id has error.code', async ({ request }) => {
    const res = await request.get(`/v1/runs/${FAKE}`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
    await expectErrorEnvelope(res);
  });

  test('422/400 from POST /v1/auth/login with empty body has error.code', async ({ request }) => {
    const res = await request.post('/v1/auth/login', { data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    await expectErrorEnvelope(res);
  });

  test('422/400 from POST /v1/workspaces with empty body has error.code', async ({ request }) => {
    const res = await request.post('/v1/workspaces', { headers: { Authorization: `Bearer ${ctx.token}` }, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    await expectErrorEnvelope(res);
  });

  test('Bearer with garbage token returns 401', async ({ request }) => {
    const res = await request.get('/v1/agents', { headers: { Authorization: 'Bearer not-a-jwt' } });
    expect(res.status()).toBe(401);
  });

  test('Empty Authorization header returns 401', async ({ request }) => {
    const res = await request.get('/v1/agents', { headers: { Authorization: '' } });
    expect(res.status()).toBe(401);
  });

  test('error.code is UPPER_SNAKE_CASE', async ({ request }) => {
    const res = await request.get('/v1/agents');
    const body = await res.json();
    expect(body.error.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  test('error response is JSON', async ({ request }) => {
    const res = await request.get('/v1/agents');
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });
});
