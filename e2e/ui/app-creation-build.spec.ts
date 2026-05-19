import { expect, test } from '../fixtures';
import { uiAuth, waitForShell } from './_helpers';

test('new app identity launcher opens canvas with orchestrator build chat docked', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  await waitForShell(page);

  const orchestrator = await request.post('/v1/agents', {
    headers: auth.h,
    data: {
      name: 'Workspace Brain',
      adapterType: 'http',
      role: 'orchestrator',
      config: { url: 'http://127.0.0.1:9' },
    },
  });
  expect(orchestrator.ok(), `orchestrator create returned ${orchestrator.status()}`).toBeTruthy();

  await page.goto('/apps/new');
  await page.getByLabel('App name').fill('Zero Inbox SDR');
  await page.getByRole('button', { name: /Open canvas with orchestrator/i }).click();

  await expect(page).toHaveURL(/\/apps\/zero-inbox-sdr\?layer=canvas&build=1/);
  await expect(page.getByRole('tab', { name: /Canvas/i })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('complementary', { name: 'Chat panel' })).toBeVisible();
  await expect(page.locator('aside[aria-label="Chat panel"] header').getByText('Workspace Brain')).toBeVisible();
});
