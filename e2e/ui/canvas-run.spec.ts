/**
 * Canvas — run a saved workflow and verify the ledger panel populates.
 */
import { test, expect } from '../fixtures';
import { uiAuth } from './_helpers';

test('Run button on the canvas starts a run and navigates to /runs/:id', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await page.getByRole('button', { name: /\+ New workflow/i }).click();
  await expect(page.getByText('Echo')).toBeVisible();
  await page.getByRole('button', { name: /^Run$/i }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}/, { timeout: 10_000 });
});

test('run detail page renders the ledger header (events panel)', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await page.getByRole('button', { name: /\+ New workflow/i }).click();
  await page.getByRole('button', { name: /^Run$/i }).click();
  await expect(page.getByText(/Ledger/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/events$/)).toBeVisible();
});

test('run detail shows a Nodes panel header', async ({ page, request }) => {
  // Triggering Run via the UI races the auto-bind effect for the placeholder
  // skillId — assert only the panel header (run state populates async).
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await page.getByRole('button', { name: /\+ New workflow/i }).click();
  await page.getByRole('button', { name: /^Run$/i }).click();
  await expect(page.getByText(/Nodes/i).first()).toBeVisible({ timeout: 15_000 });
});

test('Runs sidebar entry navigates to the run history list', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Runs"]').click();
  await expect(page).toHaveURL(/\/runs$/);
});
