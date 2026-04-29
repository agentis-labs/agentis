/**
 * /v1/openapi.json + /v1/docs — public OpenAPI 3.1 surface + Scalar UI.
 */
import { test, expect } from '../fixtures';

test.describe('OpenAPI document', () => {
  test('GET /v1/openapi.json is reachable without auth', async ({ request }) => {
    const res = await request.get('/v1/openapi.json');
    expect(res.ok()).toBeTruthy();
  });

  test('OpenAPI version starts with 3.', async ({ request }) => {
    const body = await (await request.get('/v1/openapi.json')).json();
    expect(body.openapi).toMatch(/^3\./);
  });

  test('OpenAPI document carries the Agentis title', async ({ request }) => {
    const body = await (await request.get('/v1/openapi.json')).json();
    expect(typeof body.info?.title).toBe('string');
    expect(body.info.title.toLowerCase()).toContain('agentis');
  });

  test('OpenAPI document defines paths', async ({ request }) => {
    const body = await (await request.get('/v1/openapi.json')).json();
    expect(typeof body.paths).toBe('object');
    expect(Object.keys(body.paths).length).toBeGreaterThan(0);
  });

  test('OpenAPI document declares the /v1/auth/login endpoint', async ({ request }) => {
    const body = await (await request.get('/v1/openapi.json')).json();
    expect(body.paths['/v1/auth/login']).toBeTruthy();
  });

  test('OpenAPI document declares the /v1/workspaces endpoint', async ({ request }) => {
    const body = await (await request.get('/v1/openapi.json')).json();
    expect(body.paths['/v1/workspaces']).toBeTruthy();
  });

  test('OpenAPI document declares a security scheme', async ({ request }) => {
    const body = await (await request.get('/v1/openapi.json')).json();
    expect(typeof body.components?.securitySchemes).toBe('object');
  });

  test('GET /v1/docs serves the Scalar UI HTML', async ({ request }) => {
    const res = await request.get('/v1/docs');
    expect(res.ok()).toBeTruthy();
    const text = await res.text();
    expect(text.toLowerCase()).toContain('<html');
  });
});
