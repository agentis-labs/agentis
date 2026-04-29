/**
 * /v1/runs/:id/replay — exercises all four replay modes against a fake run id.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

const FAKE = '00000000-0000-0000-0000-000000000000';

test.describe('/v1/runs/:id/replay', () => {
  test('replay-from-node returns 404 for unknown run', async ({ request }) => {
    const res = await request.post(`/v1/runs/${FAKE}/replay`, {
      headers: ctx.headers,
      data: { mode: 'replay-from-node', nodeId: 'start' },
    });
    expect(res.status()).toBe(404);
  });

  test('replay-failed-branch returns 404 for unknown run', async ({ request }) => {
    const res = await request.post(`/v1/runs/${FAKE}/replay`, {
      headers: ctx.headers,
      data: { mode: 'replay-failed-branch' },
    });
    expect(res.status()).toBe(404);
  });

  test('replay-with-edited-node returns 404 for unknown run', async ({ request }) => {
    const res = await request.post(`/v1/runs/${FAKE}/replay`, {
      headers: ctx.headers,
      data: { mode: 'replay-with-edited-node', nodeId: 'start', node: { type: 'manualTrigger', config: {} } },
    });
    expect(res.status()).toBe(404);
  });

  test('replay-from-checkpoint returns 404 for unknown run', async ({ request }) => {
    const res = await request.post(`/v1/runs/${FAKE}/replay`, {
      headers: ctx.headers,
      data: { mode: 'replay-from-checkpoint', checkpointId: FAKE },
    });
    expect(res.status()).toBe(404);
  });

  test('replay rejects an unknown mode', async ({ request }) => {
    const res = await request.post(`/v1/runs/${FAKE}/replay`, {
      headers: ctx.headers,
      data: { mode: 'time-travel' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('replay rejects an empty body', async ({ request }) => {
    const res = await request.post(`/v1/runs/${FAKE}/replay`, { headers: ctx.headers, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('replay requires authentication', async ({ request }) => {
    const res = await request.post(`/v1/runs/${FAKE}/replay`, { data: { mode: 'replay-failed-branch' } });
    expect(res.status()).toBe(401);
  });
});
