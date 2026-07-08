/**
 * /v1/workspaces — list/create/get/select + ambient sub-resource.
 */
import { test, expect } from '../fixtures';
import { apiAuth } from './_helpers';

test.describe('/v1/workspaces', () => {
  test('list returns the seeded personal workspace', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.get('/v1/workspaces', { headers: a.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body.workspaces.find((w: any) => w.id === a.workspace.id)).toBeTruthy();
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/workspaces');
    expect(res.status()).toBe(401);
  });

  test('list with invalid Bearer token is rejected', async ({ request }) => {
    const res = await request.get('/v1/workspaces', { headers: { Authorization: 'Bearer xxx' } });
    expect(res.status()).toBe(401);
  });

  test('create returns 201 with the new workspace', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post('/v1/workspaces', {
      headers: a.headers,
      data: { name: 'Acme', slug: 'acme-' + Date.now().toString(36) },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.workspace.name).toBe('Acme');
    expect(typeof body.workspace.id).toBe('string');
  });

  test('create rejects an empty name', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post('/v1/workspaces', { headers: a.headers, data: { name: '', slug: 'foo' } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('create rejects an upper-case slug', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post('/v1/workspaces', { headers: a.headers, data: { name: 'X', slug: 'NotKebab' } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('create rejects a slug with spaces', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post('/v1/workspaces', { headers: a.headers, data: { name: 'X', slug: 'has space' } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects a missing body entirely', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post('/v1/workspaces', { headers: a.headers, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create requires authentication', async ({ request }) => {
    const res = await request.post('/v1/workspaces', { data: { name: 'X', slug: 'x' } });
    expect(res.status()).toBe(401);
  });

  test('get :id returns workspace + ambients', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.get(`/v1/workspaces/${a.workspace.id}`, { headers: a.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.workspace.id).toBe(a.workspace.id);
    expect(Array.isArray(body.ambients)).toBe(true);
    expect(body.ambients.length).toBeGreaterThanOrEqual(1);
    expect(body.ambients.find((x: any) => x.id === a.ambient.id)).toBeTruthy();
  });

  test('get :id returns 404 for an unknown workspace id', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.get('/v1/workspaces/00000000-0000-0000-0000-000000000000', { headers: a.headers });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe('RESOURCE_NOT_FOUND');
  });

  test('get :id is scoped to the authenticated user', async ({ request }) => {
    // The seeded user is the only user, so any random uuid behaves as "not mine".
    const a = await apiAuth(request);
    const res = await request.get('/v1/workspaces/11111111-1111-1111-1111-111111111111', { headers: a.headers });
    expect(res.status()).toBe(404);
  });

  test('post /:id/select returns workspace summary', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post(`/v1/workspaces/${a.workspace.id}/select`, { headers: a.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.workspace.id).toBe(a.workspace.id);
    expect(body.workspace.slug).toBe(a.workspace.slug);
  });

  test('post /:id/select returns 404 for unknown workspace', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post('/v1/workspaces/00000000-0000-0000-0000-000000000000/select', { headers: a.headers });
    expect(res.status()).toBe(404);
  });

  test('post /:id/ambients creates a new ambient', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post(`/v1/workspaces/${a.workspace.id}/ambients`, {
      headers: a.headers,
      data: { name: 'Staging', kind: 'staging' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.ambient.name).toBe('Staging');
    expect(typeof body.ambient.id).toBe('string');
  });

  test('post /:id/ambients defaults the kind to local', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post(`/v1/workspaces/${a.workspace.id}/ambients`, {
      headers: a.headers,
      data: { name: 'AnotherLocal' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.ambient.kind).toBe('local');
  });

  test('post /:id/ambients rejects an invalid kind', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post(`/v1/workspaces/${a.workspace.id}/ambients`, {
      headers: a.headers,
      data: { name: 'Bad', kind: 'martian-cluster' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('post /:id/ambients rejects an empty name', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post(`/v1/workspaces/${a.workspace.id}/ambients`, {
      headers: a.headers,
      data: { name: '' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('post /:id/ambients returns 404 for unknown workspace', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post('/v1/workspaces/00000000-0000-0000-0000-000000000000/ambients', {
      headers: a.headers,
      data: { name: 'Ghost' },
    });
    expect(res.status()).toBe(404);
  });

  test('post /:id/ambients/:ambientId/select records the active ambient', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post(`/v1/workspaces/${a.workspace.id}/ambients/${a.ambient.id}/select`, {
      headers: a.headers,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ambient.id).toBe(a.ambient.id);
  });

  test('post /:id/ambients/:ambientId/select returns 404 for foreign ambient id', async ({ request }) => {
    const a = await apiAuth(request);
    const res = await request.post(`/v1/workspaces/${a.workspace.id}/ambients/00000000-0000-0000-0000-000000000000/select`, {
      headers: a.headers,
    });
    expect(res.status()).toBe(404);
  });

  test('newly created workspace shows up in subsequent list', async ({ request }) => {
    const a = await apiAuth(request);
    const slug = 'list-' + Date.now().toString(36);
    await request.post('/v1/workspaces', { headers: a.headers, data: { name: 'L', slug } });
    const res = await request.get('/v1/workspaces', { headers: a.headers });
    const body = await res.json();
    expect(body.workspaces.find((w: any) => w.slug === slug)).toBeTruthy();
  });

  test('newly created ambient shows up in workspace get', async ({ request }) => {
    const a = await apiAuth(request);
    const created = await (await request.post(`/v1/workspaces/${a.workspace.id}/ambients`, {
      headers: a.headers,
      data: { name: 'Listed', kind: 'dev' },
    })).json();
    const res = await request.get(`/v1/workspaces/${a.workspace.id}`, { headers: a.headers });
    const body = await res.json();
    expect(body.ambients.find((x: any) => x.id === created.ambient.id)).toBeTruthy();
  });
});
