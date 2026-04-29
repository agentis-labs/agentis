/**
 * /v1/auth — login, refresh, /me.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { AgentisError, schemas, type AuthenticatedUser } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth, getUser } from '../middleware/auth.js';
import { createRateLimiter, clientIp } from '../middleware/rateLimit.js';

export function buildAuthRoutes(deps: { db: AgentisSqliteDb; auth: AuthService }) {
  const app = new Hono();

  // OWASP A07: throttle credential-stuffing. 5 attempts per minute per
  // (IP, username) — and a separate 20-per-minute IP-only ceiling so user
  // enumeration can't dodge the per-pair limit. In-memory: process-local.
  //
  // E2E bypass (AGENTIS_TEST_MODE=1): the Playwright suite drives the live
  // login flow hundreds of times across the spec matrix. The contract is
  // pinned by the vitest suite (`tests/routes/authRateLimit.test.ts` +
  // `tests/middleware/rateLimit.test.ts`) which runs without TEST_MODE.
  const testModeBypass = process.env.AGENTIS_TEST_MODE === '1';
  const loginPerPair = createRateLimiter({
    limit: 5,
    windowMs: 60_000,
    keyFn: async (c) => {
      if (testModeBypass) return null;
      let username = '';
      try {
        const cloned = c.req.raw.clone();
        const body = (await cloned.json().catch(() => null)) as { username?: unknown } | null;
        if (body && typeof body.username === 'string') username = body.username.toLowerCase();
      } catch {
        /* unparseable body — let zod handle the 422 */
      }
      return `pair:${clientIp(c)}:${username}`;
    },
  });
  const loginPerIp = createRateLimiter({
    limit: 20,
    windowMs: 60_000,
    keyFn: (c) => (testModeBypass ? null : `ip:${clientIp(c)}`),
  });

  app.post('/login', loginPerIp, loginPerPair, async (c) => {
    const body = schemas.loginRequestSchema.parse(await c.req.json());
    const user = deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, body.username))
      .get();
    if (!user) throw new AgentisError('AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
    const ok = await deps.auth.verifyPassword(body.password, user.passwordHash);
    if (!ok) throw new AgentisError('AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
    const tokens = await deps.auth.issueTokens(user.id, user.username);
    return c.json({
      user: toUser(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInSeconds: tokens.expiresInSeconds,
    });
  });

  app.post('/refresh', async (c) => {
    const body = schemas.refreshRequestSchema.parse(await c.req.json());
    const claims = await deps.auth.verify(body.refreshToken, 'refresh');
    const user = deps.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, claims.sub))
      .get();
    if (!user) throw new AgentisError('AUTH_TOKEN_INVALID', 'User no longer exists');
    const tokens = await deps.auth.issueTokens(user.id, user.username);
    return c.json(tokens);
  });

  app.get('/me', requireAuth(deps), (c) => c.json({ user: getUser(c) }));

  return app;
}

function toUser(row: typeof schema.users.$inferSelect): AuthenticatedUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email ?? null,
  };
}
