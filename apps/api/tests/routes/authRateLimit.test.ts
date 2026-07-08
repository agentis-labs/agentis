/**
 * D32 — /v1/auth/login throttles credential stuffing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildAuthRoutes } from '../../src/routes/auth.js';
import { createTestContext } from '../_helpers/createTestContext.js';

// The per-pair limiter buckets by (ip, username). The clientIp() helper
// only honors the `x-forwarded-for` header when AGENTIS_TRUST_PROXY=true
// (production sits behind nginx/Cloudflare). Pin it on for this suite so
// the simulated proxy headers actually segment buckets.
let previousTrustProxy: string | undefined;
beforeAll(() => {
  previousTrustProxy = process.env.AGENTIS_TRUST_PROXY;
  process.env.AGENTIS_TRUST_PROXY = 'true';
});
afterAll(() => {
  if (previousTrustProxy === undefined) delete process.env.AGENTIS_TRUST_PROXY;
  else process.env.AGENTIS_TRUST_PROXY = previousTrustProxy;
});

describe('POST /v1/auth/login rate limiting', () => {
  it('returns OPERATION_RATE_LIMITED after 5 failed attempts for the same (ip, username) pair', async () => {
    const ctx = await createTestContext();
    try {
      const app = ctx.buildApp([{ path: '/v1/auth', app: buildAuthRoutes({ db: ctx.db, auth: ctx.auth }) }]);

      const headers = {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.1',
      };
      // Use a non-existent username so the route short-circuits before bcrypt.
      // The rate limiter runs before the handler, so the 401 path is preserved.
      const body = JSON.stringify({ username: 'no-such-user', password: 'wrong-password-12345' });

      // 5 attempts allowed (each returns 401 invalid creds).
      for (let i = 0; i < 5; i += 1) {
        const res = await app.request('/v1/auth/login', { method: 'POST', headers, body });
        expect(res.status).toBe(401);
      }
      // 6th is rate-limited.
      const blocked = await app.request('/v1/auth/login', { method: 'POST', headers, body });
      expect(blocked.status).toBe(429);
      const payload = await blocked.json() as { error: { code: string } };
      expect(payload.error.code).toBe('OPERATION_RATE_LIMITED');
    } finally {
      ctx.close();
    }
  });

  it('different IPs do not share the per-pair bucket', async () => {
    const ctx = await createTestContext();
    try {
      const app = ctx.buildApp([{ path: '/v1/auth', app: buildAuthRoutes({ db: ctx.db, auth: ctx.auth }) }]);
      const body = JSON.stringify({ username: 'no-such-user', password: 'wrong-password-12345' });

      for (let i = 0; i < 5; i += 1) {
        const res = await app.request('/v1/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.2' },
          body,
        });
        expect(res.status).toBe(401);
      }
      // Different IP — fresh bucket.
      const fresh = await app.request('/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.3' },
        body,
      });
      expect(fresh.status).toBe(401);
    } finally {
      ctx.close();
    }
  });
});
