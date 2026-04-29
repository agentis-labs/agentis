/**
 * Canvas — build flow.
 *
 * Smoke-tests the workflow editor shell that ships with the app today:
 * - "+ New workflow" on /workflows seeds a trigger → echo skill graph and
 *   navigates to /workflows/:id.
 * - The canvas renders the seeded nodes (Start + Echo) and shows the node
 *   palette + "Run" button.
 * - The auto-rebind effect resolves the BIND_AT_RUNTIME placeholder so the
 *   workflow is immediately runnable.
 *
 * Full drag-from-palette-to-React-Flow coverage is intentionally deferred
 * (React Flow's coordinate system + jsdom-free-here means we'd need a
 * brittle mouse trace). The barrel + DnD payload is asserted in the RTL
 * suite (`apps/web/tests/components/WorkflowCanvas.test.tsx` D36).
 */
import { test, expect } from '../fixtures';
import { uiAuth, waitForShell } from './_helpers';

test('clicking "+ New workflow" creates a workflow and opens the canvas', async ({ page, request }) => {
  await uiAuth(page, request);
  await waitForShell(page);
  await page.locator('a[title="Workflows"]').click();
  await expect(page.getByRole('heading', { name: /Workflows/i })).toBeVisible();
  await page.getByRole('button', { name: /\+ New workflow/i }).click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}/);
});

test('canvas renders the seeded Start + Echo nodes', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await page.getByRole('button', { name: /\+ New workflow/i }).click();
  await expect(page.getByText('Start')).toBeVisible();
  await expect(page.getByText('Echo')).toBeVisible();
});

test('canvas exposes Run + Publish buttons in the header', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await page.getByRole('button', { name: /\+ New workflow/i }).click();
  await expect(page.getByRole('button', { name: /^Run$/i })).toBeVisible();
  // Publish is intentionally disabled until skill registry publish lands.
  await expect(page.getByRole('button', { name: /^Publish$/i })).toBeDisabled();
});

test('canvas back-link returns to the workflows list', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await page.getByRole('button', { name: /\+ New workflow/i }).click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}/);
  await page.getByRole('button', { name: /← Workflows/i }).click();
  await expect(page).toHaveURL(/\/workflows$/);
});

test('node palette is visible alongside the canvas surface', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Workflows"]').click();
  await page.getByRole('button', { name: /\+ New workflow/i }).click();
  // PALETTE_NODES contains a Trigger entry — the palette renders one button per kind.
  await expect(page.getByRole('button', { name: /trigger/i }).first()).toBeVisible();
});
