/**
 * /v1/credentials — encrypted-secret CRUD.
 *
 * Verifies the at-rest contract: plaintext `value` is never returned on
 * read endpoints. Mutations are exercised against the seeded workspace.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/credentials', () => {
  test('list is empty for a freshly seeded workspace', async ({ request }) => {
    const res = await request.get('/v1/credentials', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.credentials)).toBe(true);
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/credentials');
    expect(res.status()).toBe(401);
  });

  test('list requires the workspace header', async ({ request }) => {
    const res = await request.get('/v1/credentials', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create returns 201 with id + name', async ({ request }) => {
    const res = await request.post('/v1/credentials', {
      headers: ctx.headers,
      data: { name: 'CredA', credentialType: 'generic', value: 'sup3r-s3cr3t-value' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('CredA');
    expect(typeof body.id).toBe('string');
  });

  test('create rejects an empty body', async ({ request }) => {
    const res = await request.post('/v1/credentials', { headers: ctx.headers, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects a missing value', async ({ request }) => {
    const res = await request.post('/v1/credentials', {
      headers: ctx.headers,
      data: { name: 'NoVal', credentialType: 'generic' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('create rejects a missing name', async ({ request }) => {
    const res = await request.post('/v1/credentials', {
      headers: ctx.headers,
      data: { credentialType: 'generic', value: 'x-1234567890' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('list never echoes the plaintext value', async ({ request }) => {
    const secret = 'do-not-leak-pls-' + Date.now();
    await request.post('/v1/credentials', {
      headers: ctx.headers,
      data: { name: 'NoLeak', credentialType: 'generic', value: secret },
    });
    const res = await request.get('/v1/credentials', { headers: ctx.headers });
    const text = await res.text();
    expect(text).not.toContain(secret);
  });

  test('patch on unknown id returns 404', async ({ request }) => {
    const res = await request.patch('/v1/credentials/00000000-0000-0000-0000-000000000000', {
      headers: ctx.headers,
      data: { name: 'X' },
    });
    expect(res.status()).toBe(404);
  });

  test('delete on unknown id returns 404', async ({ request }) => {
    const res = await request.delete('/v1/credentials/00000000-0000-0000-0000-000000000000', { headers: ctx.headers });
    expect(res.status()).toBe(404);
  });

  test('patch updates the name', async ({ request }) => {
    const created = await (await request.post('/v1/credentials', {
      headers: ctx.headers,
      data: { name: 'PatchOld', credentialType: 'generic', value: 'pw-12345678' },
    })).json();
    const res = await request.patch(`/v1/credentials/${created.id}`, {
      headers: ctx.headers,
      data: { name: 'PatchNew' },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('delete removes the credential', async ({ request }) => {
    const created = await (await request.post('/v1/credentials', {
      headers: ctx.headers,
      data: { name: 'DelMe', credentialType: 'generic', value: 'pw-12345678' },
    })).json();
    const res = await request.delete(`/v1/credentials/${created.id}`, { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const list = await (await request.get('/v1/credentials', { headers: ctx.headers })).json();
    expect(list.credentials.find((c: any) => c.id === created.id)).toBeFalsy();
  });

  test('list entries do NOT contain a "value" field', async ({ request }) => {
    const res = await request.get('/v1/credentials', { headers: ctx.headers });
    const body = await res.json();
    for (const c of body.credentials) {
      expect(c.value).toBeUndefined();
    }
  });
});
