/**
 * Command palette — Ctrl+K opens, Escape closes, queries hit
 * /v1/command/search.
 */
import { test, expect } from '../fixtures';
import { uiAuth, waitForShell } from './_helpers';

test('Ctrl+K opens the command palette input', async ({ page, request }) => {
  await uiAuth(page, request);
  await waitForShell(page);
  await page.keyboard.press('Control+K');
  await expect(page.getByPlaceholder(/Search workflows, agents, gateways, runs, approvals/i)).toBeVisible();
});

test('Escape closes the command palette', async ({ page, request }) => {
  await uiAuth(page, request);
  await waitForShell(page);
  await page.keyboard.press('Control+K');
  const input = page.getByPlaceholder(/Search workflows, agents, gateways, runs, approvals/i);
  await expect(input).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).not.toBeVisible();
});

test('palette finds an agent created via API', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  await waitForShell(page);
  await request.post('/v1/agents', {
    headers: auth.h,
    data: { name: 'PaletteHermes', adapterType: 'http', capabilityTags: ['probe'], config: { baseUrl: 'http://127.0.0.1', dispatchPath: '/dispatch' } },
  });
  await page.keyboard.press('Control+K');
  await page.getByPlaceholder(/Search workflows, agents, gateways, runs, approvals/i).fill('Palette');
  await expect(page.getByRole('button', { name: /PaletteHermes/i })).toBeVisible({ timeout: 10_000 });
});

test('Enter on a palette hit navigates to its href', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  await waitForShell(page);
  const created = await (await request.post('/v1/agents', {
    headers: auth.h,
    data: { name: 'PaletteNav', adapterType: 'http', capabilityTags: [], config: { baseUrl: 'http://127.0.0.1', dispatchPath: '/dispatch' } },
  })).json();

  await page.keyboard.press('Control+K');
  await page.getByPlaceholder(/Search workflows, agents, gateways, runs, approvals/i).fill('PaletteNav');
  await expect(page.getByRole('button', { name: /PaletteNav/i })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  // The hit links to either the agent page or its conversation; both are valid spec destinations.
  await expect(page).toHaveURL(new RegExp(`/agents/${created.id}|/conversations/${created.id}`));
});

test('"⌘K to search" hint is visible in the top header', async ({ page, request }) => {
  await uiAuth(page, request);
  await waitForShell(page);
  await expect(page.getByText(/⌘K to search/i)).toBeVisible();
});
