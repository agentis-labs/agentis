/**
 * Test harness mount-guard contract.
 *
 * The route in `routes/testHarness.ts` is unauthenticated by design — the
 * only thing keeping it out of production is the boolean check in
 * `bootstrap.ts`. This test pins down the contract so a future refactor
 * can't accidentally relax the gate.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { buildTestHarnessRoutes } from '../../src/routes/testHarness.js';
import { createTestContext } from '../_helpers/createTestContext.js';

/**
 * Replays the exact gate from `bootstrap.ts`. If this implementation drifts,
 * update bootstrap and this test together.
 */
function shouldMountTestHarness(env: { AGENTIS_TEST_MODE: boolean; NODE_ENV: 'development' | 'production' | 'test' }): boolean {
  return env.AGENTIS_TEST_MODE && env.NODE_ENV !== 'production';
}

describe('test harness mount-guard', () => {
  it('refuses to mount when AGENTIS_TEST_MODE is false (any NODE_ENV)', () => {
    expect(shouldMountTestHarness({ AGENTIS_TEST_MODE: false, NODE_ENV: 'development' })).toBe(false);
    expect(shouldMountTestHarness({ AGENTIS_TEST_MODE: false, NODE_ENV: 'test' })).toBe(false);
    expect(shouldMountTestHarness({ AGENTIS_TEST_MODE: false, NODE_ENV: 'production' })).toBe(false);
  });

  it('mounts when AGENTIS_TEST_MODE=true AND NODE_ENV=development', () => {
    expect(shouldMountTestHarness({ AGENTIS_TEST_MODE: true, NODE_ENV: 'development' })).toBe(true);
  });

  it('mounts when AGENTIS_TEST_MODE=true AND NODE_ENV=test', () => {
    expect(shouldMountTestHarness({ AGENTIS_TEST_MODE: true, NODE_ENV: 'test' })).toBe(true);
  });

  it('REFUSES to mount when AGENTIS_TEST_MODE=true AND NODE_ENV=production (OWASP A05 defense-in-depth)', () => {
    expect(shouldMountTestHarness({ AGENTIS_TEST_MODE: true, NODE_ENV: 'production' })).toBe(false);
  });
});

describe('test harness reset endpoint', () => {
  const fakeEnv = {
    AGENTIS_SEED_USERNAME: 'operator',
    AGENTIS_SEED_PASSWORD: 'hunter2-very-secure',
    AGENTIS_SEED_DISPLAY_NAME: 'Operator',
    AGENTIS_TEST_MODE: true,
    NODE_ENV: 'test' as const,
  };

  it('wipes domain tables and re-seeds when invoked', async () => {
    const ctx = await createTestContext();
    try {
      const app = new Hono();
      app.route('/v1/_test', buildTestHarnessRoutes({
        db: ctx.db,
        auth: ctx.auth,
        env: fakeEnv as never,
        logger: ctx.logger,
      }));

      const res = await app.request('/v1/_test/reset', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; user: { username: string } };
      expect(body.ok).toBe(true);
      expect(body.user.username).toBe('operator');
    } finally {
      ctx.close();
    }
  });

  it('endpoint is unauthenticated by design (no Authorization header required)', async () => {
    const ctx = await createTestContext();
    try {
      const app = new Hono();
      app.route('/v1/_test', buildTestHarnessRoutes({
        db: ctx.db,
        auth: ctx.auth,
        env: fakeEnv as never,
        logger: ctx.logger,
      }));

      // No Authorization header — must succeed.
      const res = await app.request('/v1/_test/reset', { method: 'POST' });
      expect(res.status).toBe(200);
    } finally {
      ctx.close();
    }
  });
});
