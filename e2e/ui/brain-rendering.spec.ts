import { test, expect } from '../fixtures';
import { uiAuth, waitForShell } from './_helpers';

test('navigates to redesigned Brain surface and opens Insights memory', async ({ page, request }) => {
  await uiAuth(page, request);
  await waitForShell(page);
  await page.goto('/brain');

  await expect(page.getByRole('heading', { name: 'The Brain', level: 1 })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Workspace intelligence map - knowledge graph - shared memory')).toBeVisible();

  await expect(page.locator('button[role="tab"]:has-text("Map")')).toBeVisible();
  await expect(page.locator('button[role="tab"]:has-text("Knowledge")')).toBeVisible();
  await expect(page.locator('button[role="tab"]:has-text("Insights")')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Configure Brain' })).toBeVisible();

  await page.locator('button[role="tab"]:has-text("Insights")').click();
  await expect(page).toHaveURL(/\/brain\?tab=insights$/);
  await expect(page.getByText('Brain Health', { exact: true })).toBeVisible({ timeout: 10000 });

  await expect(page.getByPlaceholder('What should this surface always remember?')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Save to workspace memory' })).toBeVisible();
});
