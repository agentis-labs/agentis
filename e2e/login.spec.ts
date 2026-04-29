/**
 * Login → dashboard happy-path.
 *
 * Resets state at the start of the file so the seed is deterministic, then
 * runs through the operator sign-in and asserts the dashboard shell
 * renders.
 */
import { test, expect, signIn, TEST_PASSWORD } from './fixtures';

test.beforeAll(async ({ request }) => {
  await request.post('/v1/_test/reset');
});

test('operator can sign in with the deterministic seed', async ({ page }) => {
  await signIn(page);
  // Dashboard shell shows the Agentis brand somewhere on the chrome.
  await expect(page.getByText(/Agentis/i).first()).toBeVisible();
});

test('login form rejects an invalid password with a visible error', async ({ page, request }) => {
  // Make sure the seed exists so the failure is "wrong password" not "no user".
  await request.post('/v1/_test/reset');
  await page.goto('/');
  await page.getByText('Username').waitFor({ state: 'visible' });
  await page.locator('input[type="password"]').fill('this-is-the-wrong-password');
  await page.getByRole('button', { name: /Sign in/i }).click();
  await expect(page.getByText(/Invalid credentials|Login failed/i)).toBeVisible();
});

test('login persists tokens — reload keeps the user signed in', async ({ page }) => {
  await signIn(page);
  await page.reload();
  await expect(page).not.toHaveURL(/\/login/);
});

test('the deterministic seed password is exactly test-password-1234', () => {
  // Sanity check the constant the API uses; if the helper's password drifts
  // every other E2E spec breaks. This is the canary.
  expect(TEST_PASSWORD).toBe('test-password-1234');
});
