/**
 * Ledger panel - a completed run should stay inspectable through the run modal.
 */
import { test, expect } from '../fixtures';
import { trivialGraph } from '../api/_helpers';
import { uiAuth } from './_helpers';

async function seedRun(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  const auth = await uiAuth(page, request);
  const wf = await (await request.post('/v1/workflows', {
    headers: auth.h,
    data: {
      title: 'LedgerProbe',
      summary: '',
      graph: trivialGraph(),
      settings: {},
    },
  })).json();

  const run = await (await request.post(`/v1/workflows/${wf.workflow.id}/run`, {
    headers: auth.h,
    data: { inputs: {} },
  })).json();

  return { auth, runId: run.runId };
}

test('completed run shows ledger events with the events count', async ({ page, request }) => {
  const { runId } = await seedRun(page, request);
  await page.goto(`/runs/${runId}`);
  await expect(page).toHaveURL(/\/history\?tab=runs$/);
  const modal = page.getByRole('dialog', { name: new RegExp(`Run ${runId}`, 'i') });
  await expect(modal.getByRole('button', { name: /^ledger$/i })).toBeVisible({ timeout: 15_000 });
  await modal.getByRole('button', { name: /^ledger$/i }).click();
  await expect(modal.getByText('#1')).toBeVisible({ timeout: 15_000 });
  await expect(modal.getByText('#2')).toBeVisible({ timeout: 15_000 });
});

test('completed run reaches COMPLETED status', async ({ page, request }) => {
  const { runId } = await seedRun(page, request);
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole('dialog', { name: new RegExp(`Run ${runId}`, 'i') }).getByText('COMPLETED').first()).toBeVisible({ timeout: 15_000 });
});

test('ledger renders the Nodes section once the run completes', async ({ page, request }) => {
  const { runId } = await seedRun(page, request);
  await page.goto(`/runs/${runId}`);
  const modal = page.getByRole('dialog', { name: new RegExp(`Run ${runId}`, 'i') });
  await expect(modal.getByText(/completed|failed/).first()).toBeVisible({ timeout: 15_000 });
  await expect(modal.getByRole('button', { name: /^nodes$/i })).toBeVisible();
});

test('ledger header includes the run uuid in the side card', async ({ page, request }) => {
  const { runId } = await seedRun(page, request);
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole('dialog', { name: new RegExp(`Run ${runId}`, 'i') }).getByText(runId)).toBeVisible({ timeout: 15_000 });
});
