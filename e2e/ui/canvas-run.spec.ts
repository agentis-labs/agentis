/**
 * Canvas - run a saved workflow and keep inspection operator-driven.
 */
import { test, expect } from '../fixtures';
import { trivialGraph } from '../api/_helpers';
import { uiAuth, waitForShell } from './_helpers';

test.setTimeout(60_000);

async function seedWorkflow(request: import('@playwright/test').APIRequestContext, headers: Record<string, string>) {
  const res = await request.post('/v1/workflows', {
    headers,
    data: {
      title: 'ModalProbe',
      summary: '',
      graph: trivialGraph(),
      settings: {},
    },
  });
  const body = await res.json();
  return body.workflow.id as string;
}

test('Run button on the canvas starts a run without auto-opening the run modal', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  const workflowId = await seedWorkflow(request, auth.h);
  await waitForShell(page);
  await page.goto(`/workflows/${workflowId}`);
  await page.getByRole('button', { name: /^Run$/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Run$/i }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${workflowId}(\\?tab=studio)?$`), { timeout: 10_000 });
  await expect(page.getByRole('dialog', { name: /Run [0-9a-f-]{36}/i })).toHaveCount(0);
});

test('run modal renders the ledger tab from the canvas flow', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  const workflowId = await seedWorkflow(request, auth.h);
  await waitForShell(page);
  await page.goto(`/workflows/${workflowId}`);
  await page.getByRole('button', { name: /^Run$/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Run$/i }).click();
  await page.getByRole('button', { name: /^Inspect run$/i }).click();
  const modal = page.getByRole('dialog', { name: /Run [0-9a-f-]{36}/i });
  await expect(modal.getByRole('button', { name: /^ledger$/i })).toBeVisible({ timeout: 15_000 });
  await modal.getByRole('button', { name: /^ledger$/i }).click();
  await expect(modal.getByText('#1')).toBeVisible({ timeout: 15_000 });
});

test('run modal shows a Nodes panel header', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  const workflowId = await seedWorkflow(request, auth.h);
  await waitForShell(page);
  await page.goto(`/workflows/${workflowId}`);
  await page.getByRole('button', { name: /^Run$/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Run$/i }).click();
  await page.getByRole('button', { name: /^Inspect run$/i }).click();
  const modal = page.getByRole('dialog', { name: /Run [0-9a-f-]{36}/i });
  await expect(modal.getByRole('button', { name: /^nodes$/i })).toBeVisible({ timeout: 15_000 });
});

test('History remains the dedicated route for workflow runs', async ({ page, request }) => {
  await uiAuth(page, request);
  await waitForShell(page);
  await page.goto('/history?tab=runs');
  await expect(page).toHaveURL(/\/history\?tab=runs$/);
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
});
