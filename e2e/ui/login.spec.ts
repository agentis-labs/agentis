/**
 * Login UI flow extension (D29 base spec covers the basics; this file fills
 * the side-cases the original `login.spec.ts` left out).
 */
import { test, expect, signIn, TEST_PASSWORD, TEST_USERNAME } from '../fixtures';
import { waitForShell } from './_helpers';

test.beforeEach(async ({ request }) => {
  await request.post('/v1/_test/reset');
});

test('login lands on /fleet by default and renders the side nav', async ({ page }) => {
  await signIn(page);
  await waitForShell(page);
  await expect(page).toHaveURL(/\/fleet$/);
});

test('signing out renders the LoginPage in place (no URL change required)', async ({ page }) => {
  await signIn(page);
  await waitForShell(page);
  await page.getByRole('button', { name: /Sign out/i }).click();
  // App.tsx flips `authed` instead of navigating, so the LoginPage takes
  // over the current route — assert the form, not the URL.
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByText('Username')).toBeVisible();
});

test('navigating to a protected URL while logged out redirects to login', async ({ page }) => {
  await page.goto('/agents');
  await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 10_000 });
});

test('login with empty password surfaces a validation/credentials error', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Username').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /Sign in/i }).click();
  // The API returns either VALIDATION_FAILED (zod) or AUTH_INVALID_CREDENTIALS
  // depending on schema strictness — both surface in the danger banner.
  await expect(page.getByText(/Invalid|Login failed|required|VALIDATION/i)).toBeVisible({ timeout: 10_000 });
});

test('login form pre-fills the seeded username', async ({ page }) => {
  await page.goto('/');
  const usernameInput = page.locator('input').filter({ hasNot: page.locator('[type="password"]') }).first();
  await expect(usernameInput).toHaveValue(TEST_USERNAME);
  // Sanity: the seeded password is what other specs rely on.
  expect(TEST_PASSWORD).toBe('test-password-1234');
});
