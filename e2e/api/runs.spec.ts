/**
 * /v1/runs — list/get/cancel/ledger/scratchpad/replay.
 *
 * Most of these focus on the empty / not-found paths because spinning up a
 * full workflow run requires the engine to fan out tasks; that is covered
 * by the api-level integration suite. Here we lock the route surface.
 */
import { test, expect } from '../fixtures';
import { apiAuth, trivialGraph, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

const FAKE = '00000000-0000-0000-0000-000000000000';

test.describe('/v1/runs', () => {
  test('list returns the runs array', async ({ request }) => {
    const res = await request.get('/v1/runs', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.runs)).toBe(true);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/runs');
    expect(res.status()).toBe(401);
  });

  test('list requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/runs', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list with very large limit does not crash', async ({ request }) => {
    const res = await request.get('/v1/runs?limit=99999', { headers: ctx.headers });
    expect(res.status()).toBeLessThan(500);
  });

  test('list with limit=1 returns at most 1 run', async ({ request }) => {
    const res = await request.get('/v1/runs?limit=1', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.runs.length).toBeLessThanOrEqual(1);
  });

  test('get :id returns 404 for unknown run', async ({ request }) => {
    const res = await request.get(`/v1/runs/${FAKE}`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  test('cancel on unknown run returns 404', async ({ request }) => {
    const res = await request.post(`/v1/runs/${FAKE}/cancel`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('ledger on unknown run returns 404', async ({ request }) => {
    const res = await request.get(`/v1/runs/${FAKE}/ledger`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('scratchpad on unknown run returns 404', async ({ request }) => {
    const res = await request.get(`/v1/runs/${FAKE}/scratchpad`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('replay on unknown run returns 404', async ({ request }) => {
    const res = await request.post(`/v1/runs/${FAKE}/replay`, {
      headers: ctx.headers,
      data: { mode: 'replay-from-node' },
    });
    expect(res.status()).toBe(404);
  });

  test('replay rejects an unknown mode', async ({ request }) => {
    const res = await request.post(`/v1/runs/${FAKE}/replay`, {
      headers: ctx.headers,
      data: { mode: 'replay-from-the-moon' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('triggering a workflow run shows up in list', async ({ request }) => {
    const wf = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'RunsList', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    const run = await (await request.post(`/v1/workflows/${wf.workflow.id}/run`, { headers: ctx.headers, data: {} })).json();
    const list = await (await request.get('/v1/runs', { headers: ctx.headers })).json();
    expect(list.runs.find((r: any) => r.id === run.runId)).toBeTruthy();
  });

  test('triggered run is fetchable via get :id', async ({ request }) => {
    const wf = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'RunsGet', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    const run = await (await request.post(`/v1/workflows/${wf.workflow.id}/run`, { headers: ctx.headers, data: {} })).json();
    const res = await request.get(`/v1/runs/${run.runId}`, { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.run.id).toBe(run.runId);
    expect(body.run.workflowId).toBe(wf.workflow.id);
  });

  test('ledger of a triggered run returns an events array', async ({ request }) => {
    const wf = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'RunsLedger', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    const run = await (await request.post(`/v1/workflows/${wf.workflow.id}/run`, { headers: ctx.headers, data: {} })).json();
    const res = await request.get(`/v1/runs/${run.runId}/ledger`, { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
  });

  test('scratchpad of a triggered run returns an object', async ({ request }) => {
    const wf = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'RunsScratch', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    const run = await (await request.post(`/v1/workflows/${wf.workflow.id}/run`, { headers: ctx.headers, data: {} })).json();
    const res = await request.get(`/v1/runs/${run.runId}/scratchpad`, { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.scratchpad).toBe('object');
  });
});
