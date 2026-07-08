/**
 * D32 — Security headers middleware contract.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { securityHeaders } from '../../src/middleware/securityHeaders.js';

function build(productionMode: boolean) {
  const app = new Hono();
  app.use('*', securityHeaders({ productionMode }));
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('securityHeaders', () => {
  it('sets the conservative default headers on every response', async () => {
    const res = await build(false).request('/x');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('omits Strict-Transport-Security in non-production mode', async () => {
    const res = await build(false).request('/x');
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('emits Strict-Transport-Security in production mode', async () => {
    const res = await build(true).request('/x');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });
});
