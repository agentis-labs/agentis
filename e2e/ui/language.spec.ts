import { test, expect } from '../fixtures';
import { uiAuth, waitForShell } from './_helpers';

test('the display-language preference updates the shell and persists across reloads', async ({
  page,
  request,
}) => {
  await uiAuth(page, request);
  await waitForShell(page);

  await page.getByRole('button', { name: 'Open profile menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await page.locator('#agentis-language').selectOption('pt-BR');
  await expect(page.getByRole('heading', { name: 'Configurações' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('agentis.locale')))
    .toBe('pt-BR');

  await page.reload();
  await waitForShell(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
});
