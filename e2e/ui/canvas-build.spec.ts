/**
 * Canvas build-flow smoke tests.
 *
 * Full drag-from-palette-to-React-Flow coverage remains in the component
 * suite because browser-coordinate traces are unnecessarily brittle here.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { uiAuth, waitForShell } from './_helpers';

async function createBlankWorkflow(page: Page) {
  await page.getByRole('button', { name: 'New workflow', exact: true }).first().click();
  await page.getByRole('button', { name: /Create new/i }).click();
  await expect(page.getByRole('heading', { name: 'New workflow', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}/);
}

test('clicking New workflow creates a workflow and opens the canvas', async ({ page, request }) => {
  await uiAuth(page, request);
  await waitForShell(page);
  await page.locator('a[title="Workflows"]').click();
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible();
  await createBlankWorkflow(page);
});

test('canvas opens a blank workflow with the node palette ready', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await createBlankWorkflow(page);
  await expect(page.getByRole('heading', { name: 'Palette', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /trigger/i }).first()).toBeVisible();
});

test('canvas exposes Test run + Publish buttons in the header', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await createBlankWorkflow(page);
  await expect(page.getByRole('button', { name: 'Test run', exact: true })).toBeVisible();
  const publish = page.getByRole('button', { name: /^Publish$/i });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.getByText('Manual workflow')).toBeVisible();
});

test('canvas back-link returns to the workflows list', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await createBlankWorkflow(page);
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await expect(page).toHaveURL(/\/workflows$/);
});

test('node palette is visible alongside the canvas surface', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await createBlankWorkflow(page);
  await expect(page.getByRole('button', { name: /trigger/i }).first()).toBeVisible();
});
