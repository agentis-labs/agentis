/**
 * Agent terminal — register an agent via the API, navigate to the agent
 * detail page, and exercise the terminal pane shell. We do not assert on
 * round-trip message delivery: that requires an outbound adapter (real
 * HTTP target / openclaw socket) which we don't stand up in CI.
 */
import { test, expect } from '../fixtures';
import { uiAuth } from './_helpers';

test('agent registered via API appears on /agents and links to its detail page', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  const res = await request.post('/v1/agents', {
    headers: auth.h,
    data: { name: 'TerminalSpec', adapterType: 'http', capabilityTags: ['e2e'], config: { url: 'http://127.0.0.1:9' } },
  });
  expect(res.status(), `agent create returned ${res.status()}`).toBe(201);
  const created = await res.json();

  await page.locator('a[title="Agents"]').click();
  await expect(page.getByText('TerminalSpec')).toBeVisible();
  await page.getByText('TerminalSpec').click();
  await expect(page).toHaveURL(new RegExp(`/agents/${created.id}`));
});

test('agent detail page renders the terminal text area + send draft', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  const created = await (await request.post('/v1/agents', {
    headers: auth.h,
    data: { name: 'PaneTest', adapterType: 'http', capabilityTags: [], config: { url: 'http://127.0.0.1:9' } },
  })).json();

  await page.goto(`/agents/${created.id}`);
  await expect(page.getByText('PaneTest')).toBeVisible({ timeout: 10_000 });
  // The terminal-send draft is a textarea with this placeholder.
  await expect(page.getByPlaceholder(/Send a message to the agent/i)).toBeVisible();
});

test('agent detail page shows "No messages yet." for a fresh agent', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  const created = await (await request.post('/v1/agents', {
    headers: auth.h,
    data: { name: 'EmptyConvo', adapterType: 'http', capabilityTags: [], config: { url: 'http://127.0.0.1:9' } },
  })).json();
  await page.goto(`/agents/${created.id}`);
  await expect(page.getByText(/No messages yet/i)).toBeVisible({ timeout: 10_000 });
});

test('navigating to /agents/<unknown-id> falls back to the loading shell', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.goto('/agents/00000000-0000-0000-0000-000000000000');
  // The page renders "Loading agent…" because the lookup never resolves.
  await expect(page.getByText(/Loading agent/i)).toBeVisible({ timeout: 5_000 });
});
