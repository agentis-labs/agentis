/**
 * /v1/ambients — flat read for the ambient picker.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/ambients', () => {
  test('list returns the seeded local ambient', async ({ request }) => {
    const res = await request.get('/v1/ambients', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.ambients)).toBe(true);
    expect(body.ambients.find((a: any) => a.id === ctx.ambient.id)).toBeTruthy();
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/ambients');
    expect(res.status()).toBe(401);
  });

  test('list requires the x-agentis-workspace header', async ({ request }) => {
    const res = await request.get('/v1/ambients', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list with a foreign workspace id is rejected', async ({ request }) => {
    const res = await request.get('/v1/ambients', {
      headers: { Authorization: `Bearer ${ctx.token}`, 'x-agentis-workspace': '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list reflects newly created ambients', async ({ request }) => {
    const created = await (await request.post(`/v1/workspaces/${ctx.workspace.id}/ambients`, {
      headers: ctx.headers,
      data: { name: 'Visible', kind: 'staging' },
    })).json();
    const res = await request.get('/v1/ambients', { headers: ctx.headers });
    const body = await res.json();
    expect(body.ambients.find((a: any) => a.id === created.ambient.id)).toBeTruthy();
  });

  test('ambient list entries carry the expected shape', async ({ request }) => {
    const res = await request.get('/v1/ambients', { headers: ctx.headers });
    const body = await res.json();
    const sample = body.ambients[0];
    expect(typeof sample.id).toBe('string');
    expect(typeof sample.name).toBe('string');
    expect(typeof sample.kind).toBe('string');
  });

  test('ambient list does not leak secret-shaped fields', async ({ request }) => {
    const res = await request.get('/v1/ambients', { headers: ctx.headers });
    const text = await res.text();
    expect(text).not.toMatch(/password|secret|token|credential/i);
  });

  test('ambient kinds are bounded by the schema enum', async ({ request }) => {
    const res = await request.get('/v1/ambients', { headers: ctx.headers });
    const body = await res.json();
    for (const a of body.ambients) {
      expect(['local', 'dev', 'staging', 'prod', 'fleet', 'custom']).toContain(a.kind);
    }
  });

  test('list response is JSON content-type', async ({ request }) => {
    const res = await request.get('/v1/ambients', { headers: ctx.headers });
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });

  test('list response status is exactly 200', async ({ request }) => {
    const res = await request.get('/v1/ambients', { headers: ctx.headers });
    expect(res.status()).toBe(200);
  });

  test('list is consistent across two consecutive calls', async ({ request }) => {
    const r1 = await (await request.get('/v1/ambients', { headers: ctx.headers })).json();
    const r2 = await (await request.get('/v1/ambients', { headers: ctx.headers })).json();
    expect(r2.ambients.length).toBe(r1.ambients.length);
  });

  test('ambient ids are uuids', async ({ request }) => {
    const res = await request.get('/v1/ambients', { headers: ctx.headers });
    const body = await res.json();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const a of body.ambients) expect(a.id).toMatch(uuid);
  });
});
