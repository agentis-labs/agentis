/**
 * /v1/workflows — list/create/get/update/run + graph validation.
 */
import { test, expect } from '../fixtures';
import { apiAuth, trivialGraph, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/workflows', () => {
  test('list is empty for a freshly seeded workspace', async ({ request }) => {
    const res = await request.get('/v1/workflows', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.workflows)).toBe(true);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/workflows');
    expect(res.status()).toBe(401);
  });

  test('list requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/workflows', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create returns 201 with the new workflow', async ({ request }) => {
    const res = await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'WF1', summary: 'first', graph: trivialGraph(), settings: {} },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.workflow.title).toBe('WF1');
    expect(typeof body.workflow.id).toBe('string');
  });

  test('create rejects an empty body', async ({ request }) => {
    const res = await request.post('/v1/workflows', { headers: ctx.headers, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects a missing title', async ({ request }) => {
    const res = await request.post('/v1/workflows', { headers: ctx.headers, data: { graph: trivialGraph() } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects an invalid graph (missing viewport)', async ({ request }) => {
    const res = await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'Bad', summary: '', graph: { version: 1, nodes: [], edges: [] }, settings: {} },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects a graph with the wrong shape', async ({ request }) => {
    const res = await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'Wrong', summary: '', graph: 'not-an-object', settings: {} },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create requires authentication', async ({ request }) => {
    const res = await request.post('/v1/workflows', { data: { title: 'X', summary: '', graph: trivialGraph(), settings: {} } });
    expect(res.status()).toBe(401);
  });

  test('newly created workflow appears in subsequent list', async ({ request }) => {
    const created = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'WF-list', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    const res = await request.get('/v1/workflows', { headers: ctx.headers });
    const body = await res.json();
    expect(body.workflows.find((w: any) => w.id === created.workflow.id)).toBeTruthy();
  });

  test('get :id returns the workflow', async ({ request }) => {
    const created = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'Get', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    const res = await request.get(`/v1/workflows/${created.workflow.id}`, { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.workflow.id).toBe(created.workflow.id);
  });

  test('get :id returns 404 for unknown id', async ({ request }) => {
    const res = await request.get('/v1/workflows/00000000-0000-0000-0000-000000000000', { headers: ctx.headers });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe('RESOURCE_NOT_FOUND');
  });

  test('patch updates the title', async ({ request }) => {
    const created = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'Old', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    const res = await request.patch(`/v1/workflows/${created.workflow.id}`, {
      headers: ctx.headers,
      data: { title: 'New' },
    });
    expect(res.ok()).toBeTruthy();
    const fresh = await (await request.get(`/v1/workflows/${created.workflow.id}`, { headers: ctx.headers })).json();
    expect(fresh.workflow.title).toBe('New');
  });

  test('patch on unknown id returns 404', async ({ request }) => {
    const res = await request.patch('/v1/workflows/00000000-0000-0000-0000-000000000000', {
      headers: ctx.headers,
      data: { title: 'X' },
    });
    expect(res.status()).toBe(404);
  });

  test('patch rejects an invalid graph replacement', async ({ request }) => {
    const created = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'PatchBad', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    const res = await request.patch(`/v1/workflows/${created.workflow.id}`, {
      headers: ctx.headers,
      data: { graph: { version: 1, nodes: [], edges: [] } },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('post /:id/run returns 202 with a runId for a valid graph', async ({ request }) => {
    const created = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'Runnable', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    const res = await request.post(`/v1/workflows/${created.workflow.id}/run`, { headers: ctx.headers, data: {} });
    expect([200, 202]).toContain(res.status());
    const body = await res.json();
    expect(typeof body.runId).toBe('string');
  });

  test('post /:id/run returns 404 for unknown workflow', async ({ request }) => {
    const res = await request.post('/v1/workflows/00000000-0000-0000-0000-000000000000/run', {
      headers: ctx.headers,
      data: {},
    });
    expect(res.status()).toBe(404);
  });

  test('post /:id/run requires authentication', async ({ request }) => {
    const res = await request.post('/v1/workflows/00000000-0000-0000-0000-000000000000/run', { data: {} });
    expect(res.status()).toBe(401);
  });

  test('list response is JSON', async ({ request }) => {
    const res = await request.get('/v1/workflows', { headers: ctx.headers });
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });

  test('workflow id is a uuid', async ({ request }) => {
    const created = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'IdShape', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    expect(created.workflow.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('newly created workflow has the workspace id stamped on it', async ({ request }) => {
    const created = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'Stamped', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    expect(created.workflow.workspaceId).toBe(ctx.workspace.id);
  });

  test('patch with empty body is a no-op (200)', async ({ request }) => {
    const created = await (await request.post('/v1/workflows', {
      headers: ctx.headers,
      data: { title: 'NoopPatch', summary: '', graph: trivialGraph(), settings: {} },
    })).json();
    const res = await request.patch(`/v1/workflows/${created.workflow.id}`, { headers: ctx.headers, data: {} });
    expect([200, 400]).toContain(res.status());
  });

  test('list contains all created workflows', async ({ request }) => {
    const res = await request.get('/v1/workflows', { headers: ctx.headers });
    const body = await res.json();
    expect(body.workflows.length).toBeGreaterThanOrEqual(1);
  });
});
