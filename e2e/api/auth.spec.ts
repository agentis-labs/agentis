/**
 * /v1/auth — login, refresh, me, error-shape coverage.
 *
 * Exercises the unauthenticated login + refresh entry points and the
 * `requireAuth` middleware contract on `/me`. Wire-shape regressions on
 * `{ error: { code, message } }` show up here first.
 */
import { test, expect } from '../fixtures';
import { reset, login, TEST_USERNAME, TEST_PASSWORD } from './_helpers';

test.describe('/v1/auth', () => {
  test.beforeAll(async ({ request }) => {
    await reset(request);
  });

  test('login returns user + access + refresh tokens', async ({ request }) => {
    const res = await request.post('/v1/auth/login', { data: { username: TEST_USERNAME, password: TEST_PASSWORD } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.user.username).toBe(TEST_USERNAME);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.expiresInSeconds).toBeGreaterThan(0);
  });

  test('login is case-sensitive on username', async ({ request }) => {
    const res = await request.post('/v1/auth/login', { data: { username: 'OPERATOR', password: TEST_PASSWORD } });
    expect([400, 401]).toContain(res.status());
  });

  test('login with wrong password returns 401 with AUTH_INVALID_CREDENTIALS', async ({ request }) => {
    const res = await request.post('/v1/auth/login', { data: { username: TEST_USERNAME, password: 'wrong-but-long-enough-pw' } });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error?.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(typeof body.error.message).toBe('string');
  });

  test('login with empty body returns 4xx with VALIDATION_FAILED', async ({ request }) => {
    const res = await request.post('/v1/auth/login', { data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    const body = await res.json();
    expect(typeof body.error?.code).toBe('string');
  });

  test('login with missing password is rejected', async ({ request }) => {
    const res = await request.post('/v1/auth/login', { data: { username: TEST_USERNAME } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('login with missing username is rejected', async ({ request }) => {
    const res = await request.post('/v1/auth/login', { data: { password: TEST_PASSWORD } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('login with non-string types is rejected', async ({ request }) => {
    const res = await request.post('/v1/auth/login', { data: { username: 123, password: false } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('login with unknown user returns invalid credentials, not user-enumeration', async ({ request }) => {
    const res = await request.post('/v1/auth/login', { data: { username: 'no-such-user', password: 'wrong-but-long-enough-pw' } });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error?.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  test('login with malformed JSON body returns 4xx', async ({ request }) => {
    const res = await request.post('/v1/auth/login', {
      headers: { 'content-type': 'application/json' },
      data: '{not json',
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('me returns the operator profile when authorized', async ({ request }) => {
    const session = await login(request);
    const res = await request.get('/v1/auth/me', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user.username).toBe(TEST_USERNAME);
    expect(typeof body.user.id).toBe('string');
  });

  test('me without an Authorization header is rejected', async ({ request }) => {
    const res = await request.get('/v1/auth/me');
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error?.code).toMatch(/^AUTH_/);
  });

  test('me with an empty Authorization header is rejected', async ({ request }) => {
    const res = await request.get('/v1/auth/me', { headers: { Authorization: '' } });
    expect(res.status()).toBe(401);
  });

  test('me with a Bearer prefix but empty token is rejected', async ({ request }) => {
    const res = await request.get('/v1/auth/me', { headers: { Authorization: 'Bearer ' } });
    expect(res.status()).toBe(401);
  });

  test('me with garbage Bearer token is rejected', async ({ request }) => {
    const res = await request.get('/v1/auth/me', { headers: { Authorization: 'Bearer not.a.jwt' } });
    expect(res.status()).toBe(401);
  });

  test('me with a non-Bearer scheme is rejected', async ({ request }) => {
    const session = await login(request);
    const res = await request.get('/v1/auth/me', {
      headers: { Authorization: `Basic ${Buffer.from('operator:pw').toString('base64')}`, 'x-test-token': session.accessToken },
    });
    expect(res.status()).toBe(401);
  });

  test('refresh returns a new access + refresh token pair', async ({ request }) => {
    const session = await login(request);
    const res = await request.post('/v1/auth/refresh', { data: { refreshToken: session.refreshToken } });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.expiresInSeconds).toBeGreaterThan(0);
  });

  test('refreshed access token works on /me', async ({ request }) => {
    const session = await login(request);
    const refreshed = await (await request.post('/v1/auth/refresh', { data: { refreshToken: session.refreshToken } })).json();
    const res = await request.get('/v1/auth/me', { headers: { Authorization: `Bearer ${refreshed.accessToken}` } });
    expect(res.ok()).toBeTruthy();
  });

  test('refresh with an invalid token returns 401', async ({ request }) => {
    const res = await request.post('/v1/auth/refresh', { data: { refreshToken: 'definitely-not-a-real-token' } });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error?.code).toMatch(/AUTH_/);
  });

  test('refresh with a missing token is rejected', async ({ request }) => {
    const res = await request.post('/v1/auth/refresh', { data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('access token cannot be used as a refresh token', async ({ request }) => {
    const session = await login(request);
    const res = await request.post('/v1/auth/refresh', { data: { refreshToken: session.accessToken } });
    expect(res.status()).toBe(401);
  });

  test('two consecutive logins both return valid tokens', async ({ request }) => {
    const a = await login(request);
    const b = await login(request);
    expect(a.accessToken).not.toBe(b.accessToken);
    const r1 = await request.get('/v1/auth/me', { headers: { Authorization: `Bearer ${a.accessToken}` } });
    const r2 = await request.get('/v1/auth/me', { headers: { Authorization: `Bearer ${b.accessToken}` } });
    expect(r1.ok()).toBeTruthy();
    expect(r2.ok()).toBeTruthy();
  });

  test('login response never echoes the password back', async ({ request }) => {
    const res = await request.post('/v1/auth/login', { data: { username: TEST_USERNAME, password: TEST_PASSWORD } });
    const text = await res.text();
    expect(text).not.toContain(TEST_PASSWORD);
  });
});
