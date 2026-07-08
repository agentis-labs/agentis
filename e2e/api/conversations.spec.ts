/**
 * /v1/conversations + /v1/agents/:id/terminal — operator chat surface.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

const FAKE = '00000000-0000-0000-0000-000000000000';

test.describe('/v1/conversations', () => {
  test('list returns the conversations array', async ({ request }) => {
    const res = await request.get('/v1/conversations', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.conversations)).toBe(true);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/conversations');
    expect(res.status()).toBe(401);
  });

  test('list requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/conversations', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list response is JSON', async ({ request }) => {
    const res = await request.get('/v1/conversations', { headers: ctx.headers });
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });

  test('get :agentId returns 404 for unknown agent', async ({ request }) => {
    const res = await request.get(`/v1/conversations/${FAKE}`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('send :agentId returns 404 for unknown agent', async ({ request }) => {
    const res = await request.post(`/v1/conversations/${FAKE}/send`, {
      headers: ctx.headers,
      data: { body: 'hi' },
    });
    expect(res.status()).toBe(404);
  });

  test('send rejects an empty body', async ({ request }) => {
    const res = await request.post(`/v1/conversations/${FAKE}/send`, {
      headers: ctx.headers,
      data: { body: '' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('continue :agentId/:sessionId returns 404 for unknown agent', async ({ request }) => {
    const res = await request.post(`/v1/conversations/${FAKE}/continue/some-session`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('read :agentId returns 404 for unknown agent', async ({ request }) => {
    const res = await request.post(`/v1/conversations/${FAKE}/read`, { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('orchestrator routes return 404 when the workspace has no orchestrator', async ({ request }) => {
    const fresh = await apiAuth(request);
    const res = await request.get('/v1/conversations/orchestrator', { headers: fresh.headers });
    expect(res.status()).toBe(404);
  });

  test('orchestrator routes resolve the workspace orchestrator thread', async ({ request }) => {
    const fresh = await apiAuth(request);
    const createRes = await request.post('/v1/agents', {
      headers: fresh.headers,
      data: { name: 'Workspace Orchestrator', adapterType: 'http', role: 'orchestrator' },
    });
    expect(createRes.ok()).toBeTruthy();

    const getRes = await request.get('/v1/conversations/orchestrator', { headers: fresh.headers });
    expect(getRes.ok()).toBeTruthy();
    const body = await getRes.json();
    expect(body.agent.name).toContain('Orchestrator');
    expect(body.conversation.agentId).toBe(body.agent.id);
    expect(Array.isArray(body.messages)).toBe(true);

    const readRes = await request.post('/v1/conversations/orchestrator/read', { headers: fresh.headers });
    expect(readRes.ok()).toBeTruthy();
  });

  test('orchestrator SSE send streams the fallback reply when no chat harness is connected', async ({ request }) => {
    const fresh = await apiAuth(request);
    const createRes = await request.post('/v1/agents', {
      headers: fresh.headers,
      data: { name: 'Primary Orchestrator', adapterType: 'http', role: 'orchestrator' },
    });
    expect(createRes.ok()).toBeTruthy();

    const res = await request.post('/v1/conversations/orchestrator/send', {
      headers: { ...fresh.headers, accept: 'text/event-stream' },
      data: { body: 'hello orchestrator' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type'] ?? '').toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toContain('event: delta');
    expect(text).toContain('This agent is not connected to an interactive chat harness yet');
    expect(text).toContain('event: message');
  });
});

test.describe('/v1/agents/:agentId/terminal', () => {
  let terminalCtx: ApiAuthCtx;

  test.beforeEach(async ({ request }) => {
    terminalCtx = await apiAuth(request);
  });

  test('GET on unknown agent returns 404', async ({ request }) => {
    const res = await request.get(`/v1/agents/${FAKE}/terminal`, { headers: terminalCtx.headers });
    expect(res.status()).toBe(404);
  });

  test('GET requires authentication', async ({ request }) => {
    const res = await request.get(`/v1/agents/${FAKE}/terminal`);
    expect(res.status()).toBe(401);
  });

  test('GET respects the limit query parameter cap', async ({ request }) => {
    const res = await request.get(`/v1/agents/${FAKE}/terminal?limit=99999`, { headers: terminalCtx.headers });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
