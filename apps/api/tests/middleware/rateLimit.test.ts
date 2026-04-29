/**
 * D32 — In-memory token-bucket rate limiter contract.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRateLimiter } from '../../src/middleware/rateLimit.js';
import { errorHandler } from '../../src/middleware/error.js';
import { createLogger } from '../../src/logger.js';

function build(opts: { limit: number; windowMs: number }) {
  const app = new Hono();
  app.onError(errorHandler(createLogger({ level: 'error' })));
  app.use('*', createRateLimiter({
    limit: opts.limit,
    windowMs: opts.windowMs,
    keyFn: (c) => c.req.header('x-test-key') ?? null,
  }));
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('createRateLimiter', () => {
  it('allows up to `limit` requests then 429s with OPERATION_RATE_LIMITED', async () => {
    const app = build({ limit: 3, windowMs: 60_000 });
    const headers = { 'x-test-key': 'k1' };
    for (let i = 0; i < 3; i += 1) {
      const ok = await app.request('/x', { headers });
      expect(ok.status).toBe(200);
    }
    const blocked = await app.request('/x', { headers });
    expect(blocked.status).toBe(429);
    const body = await blocked.json() as { error: { code: string; details?: { retryAfterSeconds?: number } } };
    expect(body.error.code).toBe('OPERATION_RATE_LIMITED');
    expect(body.error.details?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('isolates buckets by key', async () => {
    const app = build({ limit: 1, windowMs: 60_000 });
    expect((await app.request('/x', { headers: { 'x-test-key': 'a' } })).status).toBe(200);
    expect((await app.request('/x', { headers: { 'x-test-key': 'a' } })).status).toBe(429);
    expect((await app.request('/x', { headers: { 'x-test-key': 'b' } })).status).toBe(200);
  });

  it('skips limiting when keyFn returns null', async () => {
    const app = build({ limit: 1, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/x'); // no x-test-key → null
      expect(res.status).toBe(200);
    }
  });

  it('replenishes tokens after the window elapses', async () => {
    const app = build({ limit: 1, windowMs: 50 });
    const headers = { 'x-test-key': 'k2' };
    expect((await app.request('/x', { headers })).status).toBe(200);
    expect((await app.request('/x', { headers })).status).toBe(429);
    await new Promise((r) => setTimeout(r, 100));
    expect((await app.request('/x', { headers })).status).toBe(200);
  });
});
