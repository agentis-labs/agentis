/**
 * Shared Playwright fixtures.
 *
 * `resetState` — POST /v1/_test/reset (drops every row + re-seeds with the
 *   deterministic `test-password-1234` operator). Use as `test.beforeEach`.
 * `signIn`     — fills the LoginPage form and asserts the dashboard
 *   navigates away from `/login`.
 */
import { test as base, expect, type Page } from '@playwright/test';

export const TEST_USERNAME = 'operator';
export const TEST_PASSWORD = 'test-password-1234';

export async function resetState(request: { post: (url: string) => Promise<{ ok: () => boolean }> }) {
  const res = await request.post('/v1/_test/reset');
  expect(res.ok()).toBeTruthy();
}

export async function signIn(page: Page) {
  await page.goto('/');
  await page.getByText('Username').waitFor({ state: 'visible', timeout: 10_000 });
  // Username is the first text input; it's pre-filled with "operator".
  const inputs = page.locator('input').filter({ hasNot: page.locator('[type="password"]') });
  await inputs.first().fill(TEST_USERNAME);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: /Sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

export const test = base.extend<{ resetState: () => Promise<void> }>({
  resetState: async ({ request }, use) => {
    await use(async () => {
      const res = await request.post('/v1/_test/reset');
      expect(res.ok()).toBeTruthy();
    });
  },
});

export { expect };
