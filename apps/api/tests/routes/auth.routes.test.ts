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

function enableLaunchToken(token = 'local-launch-token') {
  ctx.secrets.launchToken = token;
  ctx.secrets.consumeLaunchToken = (candidate) => candidate === token;
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

  it('PATCH /me updates the operator display name and email address', async () => {
    const res = await app().request('/v1/auth/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'New Operator Name',
        email: 'operator@example.com',
      }),
    });
    expect(res.status).toBe(200);

    // Verify changes by calling GET /me
    const getRes = await app().request('/v1/auth/me', {
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
    });
    const body = (await getRes.json()) as { user: { displayName: string; email: string } };
    expect(body.user.displayName).toBe('New Operator Name');
    expect(body.user.email).toBe('operator@example.com');
  });
});

describe('/v1/auth/api-keys', () => {
  it('creates a key, authenticates with it, and revokes it', async () => {
    const mounted = app();
    const create = await mounted.request('/v1/auth/api-keys', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'CLI bootstrap' }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { key: { id: string; secret: string; preview: string } };
    expect(created.key.secret).toMatch(/^agt_/);

    const list = await mounted.request('/v1/auth/api-keys', { headers: ctx.authHeaders });
    expect((await list.json() as { keys: Array<{ id: string }> }).keys).toEqual([
      expect.objectContaining({ id: created.key.id }),
    ]);

    const apiKeyHeaders = {
      authorization: `Bearer ${created.key.secret}`,
      'x-agentis-workspace': ctx.workspace.id,
    };
    expect((await mounted.request('/v1/auth/me', { headers: apiKeyHeaders })).status).toBe(200);

    expect((await mounted.request(`/v1/auth/api-keys/${created.key.id}`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    })).status).toBe(200);
    expect((await mounted.request('/v1/auth/me', { headers: apiKeyHeaders })).status).toBe(401);
  });
});

describe('/v1/auth/launch', () => {
  it('does not authenticate a bare GET request', async () => {
    enableLaunchToken();
    const res = await app().request('/v1/auth/launch', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('exchanges a valid POST token for a session', async () => {
    enableLaunchToken();
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

  it('exchanges the local loopback bypass token for a session', async () => {
    enableLaunchToken();
    const previousTrustProxy = process.env.AGENTIS_TRUST_PROXY;
    process.env.AGENTIS_TRUST_PROXY = 'true';
    try {
      const res = await app().request('/v1/auth/launch', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: '127.0.0.1:5173',
          'x-forwarded-for': '127.0.0.1',
        },
        body: JSON.stringify({ token: 'local-bypass' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accessToken: string; refreshToken: string; user: { id: string } };
      expect(body.accessToken).toBeTruthy();
      expect(body.refreshToken).toBeTruthy();
      expect(body.user.id).toBe(ctx.user.id);
    } finally {
      if (previousTrustProxy === undefined) delete process.env.AGENTIS_TRUST_PROXY;
      else process.env.AGENTIS_TRUST_PROXY = previousTrustProxy;
    }
  });

  it('accepts replay of a valid launch token', async () => {
    enableLaunchToken();
    const mounted = app();
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'local-launch-token' }),
    };
    expect((await mounted.request('/v1/auth/launch', request)).status).toBe(200);
    expect((await mounted.request('/v1/auth/launch', request)).status).toBe(200);
  });

  it('rejects an invalid POST token', async () => {
    enableLaunchToken();
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
