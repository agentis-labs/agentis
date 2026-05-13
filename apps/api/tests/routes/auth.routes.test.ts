/**
 * /v1/auth — integration tests via app.request().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildAuthRoutes } from '../../src/routes/auth.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function app() {
  return ctx.buildApp([{ path: '/v1/auth', app: buildAuthRoutes({ db: ctx.db, auth: ctx.auth, secrets: ctx.secrets }) }]);
}

describe('POST /v1/auth/login', () => {
  it('returns tokens on valid credentials', async () => {
    const res = await app().request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ctx.user.username, password: 'hunter2-very-secure' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; refreshToken: string; user: { id: string } };
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.id).toBe(ctx.user.id);
  });

  it('returns AUTH_INVALID_CREDENTIALS on bad password', async () => {
    const res = await app().request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ctx.user.username, password: 'wrong-password-yo' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('returns AUTH_INVALID_CREDENTIALS on unknown user', async () => {
    const res = await app().request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'hunter2-very-secure' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 422 on validation failure (password too short)', async () => {
    const res = await app().request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ctx.user.username, password: 'x' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /v1/auth/refresh', () => {
  it('returns new tokens for a valid refresh token', async () => {
    const res = await app().request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: ctx.refreshToken }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  it('rejects an access token on /refresh (kind mismatch)', async () => {
    const res = await app().request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: ctx.accessToken }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/auth/me', () => {
  it('returns the authenticated user', async () => {
    const res = await app().request('/v1/auth/me', {
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toBe(ctx.user.username);
  });

  it('rejects requests without a bearer token', async () => {
    const res = await app().request('/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed bearer token', async () => {
    const res = await app().request('/v1/auth/me', {
      headers: { Authorization: 'Bearer not-a-real-jwt' },
    });
    expect(res.status).toBe(401);
  });
});

describe('/v1/auth/launch', () => {
  it('returns tokens on bare GET for local installs', async () => {
    ctx.secrets.launchToken = 'local-launch-token';
    const res = await app().request('/v1/auth/launch', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; refreshToken: string; user: { id: string } };
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.id).toBe(ctx.user.id);
  });

  it('exchanges a valid POST token for a session', async () => {
    ctx.secrets.launchToken = 'local-launch-token';
    const res = await app().request('/v1/auth/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'local-launch-token' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; refreshToken: string; user: { id: string } };
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.id).toBe(ctx.user.id);
  });

  it('rejects an invalid POST token', async () => {
    ctx.secrets.launchToken = 'local-launch-token';
    const res = await app().request('/v1/auth/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('returns 404 when launch auth is unavailable', async () => {
    const res = await app().request('/v1/auth/launch', { method: 'GET' });
    expect(res.status).toBe(404);
  });
});
