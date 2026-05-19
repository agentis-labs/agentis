import { test, expect } from '../fixtures';
import { uiAuth, waitForShell } from './_helpers';

test('chat shows the commission state when no orchestrator exists', async ({ page, request }) => {
  await uiAuth(page, request);
  await waitForShell(page);

  await page.goto('/chat');

  await expect(page.getByText(/Commission your orchestrator/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Open agents/i }).first()).toBeVisible();
});

test('home composer routes through the orchestrator thread and shows manager scopes', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  await waitForShell(page);

  const orchestratorRes = await request.post('/v1/agents', {
    headers: auth.h,
    data: { name: 'Workspace Brain', adapterType: 'http', role: 'orchestrator' },
  });
  expect(orchestratorRes.ok()).toBeTruthy();

  const managerRes = await request.post('/v1/agents', {
    headers: auth.h,
    data: { name: 'Research Manager', adapterType: 'http', role: 'manager' },
  });
  expect(managerRes.ok()).toBeTruthy();

  await page.goto('/home');

  await expect(page.getByRole('button', { name: /Orchestrator/i })).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('Message the orchestrator').fill('Summarize the workspace state.');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page).toHaveURL(/\/chat(\?|$)/);
  await expect(page.getByText('Research Manager')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/This agent is not connected to an interactive chat harness yet/i)).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /Research Manager/i }).click();
  await expect(page.locator('section > header').getByText('Research Manager')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('section > header').getByText('Manager scope')).toBeVisible({ timeout: 10_000 });
});