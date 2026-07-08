/**
 * /v1/skills — list + local manifest install.
 */
import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

test.describe('/v1/skills', () => {
  test('list contains the seeded builtin skills (echo + http_fetch)', async ({ request }) => {
    const res = await request.get('/v1/skills', { headers: ctx.headers });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills.length).toBeGreaterThan(0);
    const slugs = body.skills.map((s: any) => s.slug);
    expect(slugs).toContain('echo');
  });

  test('list requires authentication', async ({ request }) => {
    const res = await request.get('/v1/skills');
    expect(res.status()).toBe(401);
  });

  test('list requires the x-agentis-workspace header', async ({ request }) => {
    const res = await request.get('/v1/skills', { headers: { Authorization: `Bearer ${ctx.token}` } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('install-local rejects builtin runtime', async ({ request }) => {
    const res = await request.post('/v1/skills/install-local', {
      headers: ctx.headers,
      data: {
        manifest: {
          name: 'BuiltinX', slug: 'builtin-x', version: '0.0.1',
          runtime: 'builtin', entrypoint: 'x',
          capabilityTags: [], inputSchema: {}, outputSchema: {}, timeoutMs: 1000,
        },
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('install-local rejects an empty body', async ({ request }) => {
    const res = await request.post('/v1/skills/install-local', { headers: ctx.headers, data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('install-local rejects a missing manifest', async ({ request }) => {
    const res = await request.post('/v1/skills/install-local', { headers: ctx.headers, data: { manifest: null } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('install-local rejects an invalid runtime enum value', async ({ request }) => {
    const res = await request.post('/v1/skills/install-local', {
      headers: ctx.headers,
      data: {
        manifest: {
          name: 'X', slug: 'x', version: '0.0.1',
          runtime: 'wasm-warlock', entrypoint: 'x',
          capabilityTags: [], inputSchema: {}, outputSchema: {}, timeoutMs: 1000,
        },
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('install-local rejects negative timeoutMs', async ({ request }) => {
    const res = await request.post('/v1/skills/install-local', {
      headers: ctx.headers,
      data: {
        manifest: {
          name: 'X', slug: 'x-neg', version: '0.0.1',
          runtime: 'node_worker', entrypoint: 'x',
          capabilityTags: [], inputSchema: {}, outputSchema: {}, timeoutMs: -1,
        },
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('install-local accepts or rejects a slug with capitals (no crash)', async ({ request }) => {
    const res = await request.post('/v1/skills/install-local', {
      headers: ctx.headers,
      data: {
        manifest: {
          name: 'X', slug: 'NotKebab', version: '0.0.1',
          runtime: 'node_worker', entrypoint: 'x',
          capabilityTags: [], inputSchema: {}, outputSchema: {}, timeoutMs: 1000,
        },
      },
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('skill list entries carry id + slug + runtime', async ({ request }) => {
    const res = await request.get('/v1/skills', { headers: ctx.headers });
    const body = await res.json();
    for (const s of body.skills) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.slug).toBe('string');
      expect(typeof s.runtime).toBe('string');
    }
  });

  test('list response is JSON', async ({ request }) => {
    const res = await request.get('/v1/skills', { headers: ctx.headers });
    expect(res.headers()['content-type'] ?? '').toMatch(/application\/json/);
  });

  test('seeded builtin skills include http_fetch', async ({ request }) => {
    const res = await request.get('/v1/skills', { headers: ctx.headers });
    const body = await res.json();
    const slugs = body.skills.map((s: any) => s.slug);
    expect(slugs).toContain('http_fetch');
  });

  test('builtin skills report runtime=builtin', async ({ request }) => {
    const res = await request.get('/v1/skills', { headers: ctx.headers });
    const body = await res.json();
    const echo = body.skills.find((s: any) => s.slug === 'echo');
    expect(echo?.runtime).toBe('builtin');
  });
});
