/**
 * Smoke: API health + readiness via the Vite dev proxy.
 */
import { test, expect } from './fixtures';

test('API healthz responds 200 with mode payload', async ({ request }) => {
  // Vite dev server only proxies /v1/* + /socket.io, so /healthz routes to the
  // SPA shell (HTML 200). Always probe the API port directly.
  const res = await request.get('http://127.0.0.1:3737/healthz');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body).toMatchObject({ ok: true });
});

test('OpenAPI document is reachable', async ({ request }) => {
  const res = await request.get('/v1/openapi.json');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.openapi).toMatch(/^3\./);
});
