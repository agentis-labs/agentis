/**
 * D32 — JWKS endpoint contract.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { decodeProtectedHeader } from 'jose';
import { buildJwksRoutes } from '../../src/routes/jwks.js';
import { createTestContext } from '../_helpers/createTestContext.js';

describe('GET /.well-known/jwks.json', () => {
  it('returns the RS256 public key in JWK format with use=sig and a stable kid', async () => {
    const ctx = await createTestContext();
    try {
      const app = new Hono();
      app.route('/.well-known', buildJwksRoutes({ auth: ctx.auth }));

      const res = await app.request('/.well-known/jwks.json');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('max-age=3600');
      const body = await res.json() as { keys: Array<{ kty: string; alg: string; use: string; kid: string; n?: string; e?: string }> };
      expect(body.keys).toHaveLength(1);
      const [jwk] = body.keys;
      expect(jwk.kty).toBe('RSA');
      expect(jwk.alg).toBe('RS256');
      expect(jwk.use).toBe('sig');
      expect(jwk.kid).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(jwk.n).toBeTruthy();
      expect(jwk.e).toBeTruthy();
    } finally {
      ctx.close();
    }
  });

  it('issued tokens carry the JWKS kid in the protected header', async () => {
    const ctx = await createTestContext();
    try {
      const header = decodeProtectedHeader(ctx.accessToken);
      expect(header.alg).toBe('RS256');
      expect(typeof header.kid).toBe('string');
      const jwks = await ctx.auth.jwks();
      expect(header.kid).toBe(jwks.keys[0]!.kid);
    } finally {
      ctx.close();
    }
  });
});
