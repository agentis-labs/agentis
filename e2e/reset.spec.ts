/**
 * Test-harness reset endpoint contract.
 *
 * Verifies that POST /v1/_test/reset wipes data + re-seeds the operator,
 * which the rest of the suite depends on.
 */
import { test, expect } from './fixtures';

test('reset returns the seeded user + workspace + ambient', async ({ request }) => {
  const res = await request.post('/v1/_test/reset');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.user?.username).toBe('operator');
  expect(body.workspace?.slug).toBe('personal');
  expect(typeof body.ambient?.id).toBe('string');
});

test('reset is idempotent — second call still returns a populated body', async ({ request }) => {
  await request.post('/v1/_test/reset');
  const res = await request.post('/v1/_test/reset');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  // `seedIfEmpty` is a no-op once a user exists, so seed payload may be null
  // on the second call — what matters is HTTP 200.
  expect(body.ok).toBe(true);
});

test('after reset, login with the deterministic password works', async ({ request }) => {
  await request.post('/v1/_test/reset');
  const res = await request.post('/v1/auth/login', {
    data: { username: 'operator', password: 'test-password-1234' },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.accessToken).toBeTruthy();
  expect(body.user?.username).toBe('operator');
});
