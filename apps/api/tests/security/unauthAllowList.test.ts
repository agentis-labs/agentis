/**
 * D32 — Unauthenticated allow-list constant.
 *
 * The constant in `src/security/unauthAllowList.ts` is the audit source of
 * truth. Adding an entry triggers a security review; this test pins the
 * shape so the constant cannot silently drift.
 */
import { describe, it, expect } from 'vitest';
import { UNAUTH_ALLOW_LIST } from '../../src/security/unauthAllowList.js';

describe('unauthenticated route allow-list', () => {
  it('contains exactly the V1 unauthenticated surface area (no surprises)', () => {
    const paths = UNAUTH_ALLOW_LIST.map((e) => e.path).sort();
    expect(paths).toEqual([
      '/.well-known/jwks.json',
      '/healthz',
      '/v1/_test/reset',
      '/v1/auth/launch',
      '/v1/auth/login',
      '/v1/auth/refresh',
      '/v1/docs',
      '/v1/openapi.json',
      '/v1/webhooks/channel/',
      '/v1/webhooks/trigger/',
    ]);
  });

  it('every entry has a non-empty justification', () => {
    for (const entry of UNAUTH_ALLOW_LIST) {
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(entry.methods.length).toBeGreaterThan(0);
    }
  });

  it('declares the test harness as gated (D31 cross-reference)', () => {
    const testReset = UNAUTH_ALLOW_LIST.find((e) => e.path === '/v1/_test/reset');
    expect(testReset).toBeDefined();
    expect(testReset!.reason).toMatch(/AGENTIS_TEST_MODE/);
    expect(testReset!.reason).toMatch(/NODE_ENV/);
  });

  it('webhook trigger entry uses prefix matching for the dynamic id', () => {
    const wh = UNAUTH_ALLOW_LIST.find((e) => e.path === '/v1/webhooks/trigger/');
    expect(wh).toBeDefined();
    expect(wh!.prefix).toBe(true);
    expect(wh!.reason).toMatch(/HMAC/);
  });

  it('channel webhook entry uses prefix matching and references the bridge (Batch 4)', () => {
    const ch = UNAUTH_ALLOW_LIST.find((e) => e.path === '/v1/webhooks/channel/');
    expect(ch).toBeDefined();
    expect(ch!.prefix).toBe(true);
    expect(ch!.methods).toContain('POST');
    expect(ch!.reason).toMatch(/ChannelBridge|adapter/i);
  });
});
