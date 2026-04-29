/**
 * Approvals UI — empty state, navigation, and the dock surfacing.
 *
 * V1 has no public POST /v1/approvals — approvals are only created by the
 * engine on a checkpoint node. We therefore exercise the UI surfaces a
 * fresh tenant always sees: the inbox-zero state and the sidebar entry.
 */
import { test, expect } from '../fixtures';
import { uiAuth, waitForShell } from './_helpers';

test('Approvals page renders the inbox-zero state on a fresh tenant', async ({ page, request }) => {
  await uiAuth(page, request);
  await waitForShell(page);
  await page.locator('a[title="Approvals"]').click();
  await expect(page).toHaveURL(/\/approvals$/);
  await expect(page.getByRole('heading', { name: /Approvals/i })).toBeVisible();
  await expect(page.getByText(/No pending approvals/i)).toBeVisible();
});

test('Approvals page heading uses the spec name (no "Inbox" rename)', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.goto('/approvals');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Approvals/i);
});

test('sidebar Approvals entry is reachable from any page', async ({ page, request }) => {
  await uiAuth(page, request);
  await waitForShell(page);
  // The dashboard also renders a PendingApprovalsDock that links to
  // /approvals, so we don't assert link cardinality — just that the
  // sidebar entry is one of them and navigates there.
  await page.locator('aside a[href="/approvals"]').click();
  await expect(page).toHaveURL(/\/approvals$/);
});

test('approvals API directly returns an empty list (sanity for the empty state)', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  const res = await request.get('/v1/approvals?status=pending', { headers: auth.h });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.approvals).toEqual([]);
});
