/**
 * UI-spec helpers — bridges the browser session and an authenticated API
 * client so a single spec can both seed entities (over `request`) and drive
 * the React app (over `page`).
 *
 * Usage:
 *   const auth = await uiAuth(page, request);
 *   await request.post('/v1/agents', { headers: auth.h, data: { … } });
 *   await page.goto('/agents');
 *
 * Why a separate helper instead of reusing `apiAuth`: `apiAuth` resets +
 * logs in via the API but does not paint the SPA shell. `signIn` from
 * `fixtures.ts` drives the login form but doesn't return tokens. We need
 * both, and we want to avoid double-resetting.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { TEST_PASSWORD, TEST_USERNAME } from '../fixtures';

export interface UiAuthCtx {
  /** Bearer access token (matches the one stored in localStorage). */
  token: string;
  /** Refresh token (used to seed localStorage so the SPA stays signed in). */
  refreshToken: string;
  /** Personal workspace id (also stored under `agentis.workspace`). */
  workspaceId: string;
  /** Default ambient on the personal workspace. */
  ambientId: string;
  /** User id of the seeded operator. */
  userId: string;
  /** Headers to use for direct `request.*` calls. */
  h: Record<string, string>;
}

/**
 * Generates a unique synthetic IPv4 per call so every login bypasses the
 * D32 per-IP login throttle (5/min per (IP,username) + 20/min per IP).
 * The rate-limit middleware honours `x-forwarded-for` (see clientIp), so
 * setting a fresh IP keeps each test in its own bucket.
 *
 * NOTE: the production rate-limit invariant is asserted by
 * `apps/api/tests/routes/authRateLimit.test.ts`; this helper does not
 * weaken it — it only ensures the e2e suite stays under-quota.
 */
let __ipCounter = 0;
function syntheticForwardedIp() {
  __ipCounter += 1;
  // 10.x.x.x is RFC1918 — won't collide with anything real on the host.
  const a = 10;
  const b = (__ipCounter >> 16) & 0xff;
  const c = (__ipCounter >> 8) & 0xff;
  const d = __ipCounter & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * Reset state, mint an access token via the API, and prime the SPA's
 * localStorage so the next `page.goto('/')` lands directly on the
 * dashboard — no second login round-trip and no rate-limit pressure.
 *
 * Why we don't reuse `signIn` from `fixtures.ts`: it drives the form a
 * second time per test, which over the 30+ ui specs blows past the
 * 20/min per-IP login ceiling. Token-injection is faster and equivalent.
 */
export async function uiAuth(page: Page, request: APIRequestContext): Promise<UiAuthCtx> {
  const xff = syntheticForwardedIp();

  // 1) Wipe state.
  const resetRes = await request.post('/v1/_test/reset', { headers: { 'x-forwarded-for': xff } });
  expect(resetRes.ok(), `reset returned ${resetRes.status()}`).toBeTruthy();
  const seed = await resetRes.json();

  // 2) Mint an access token via the API (single login per test).
  const loginRes = await request.post('/v1/auth/login', {
    headers: { 'x-forwarded-for': xff },
    data: { username: TEST_USERNAME, password: TEST_PASSWORD },
  });
  expect(loginRes.ok(), `login returned ${loginRes.status()}`).toBeTruthy();
  const session = await loginRes.json();

  // 3) Inject tokens + workspace into localStorage BEFORE the SPA mounts
  //    so it skips the LoginPage redirect.
  const inject = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId: seed.workspace.id,
    ambientId: seed.ambient.id,
  };
  await page.addInitScript((data) => {
    window.localStorage.setItem('agentis.access', data.accessToken);
    window.localStorage.setItem('agentis.refresh', data.refreshToken);
    window.localStorage.setItem('agentis.workspace', data.workspaceId);
    if (data.ambientId) window.localStorage.setItem('agentis.ambient', data.ambientId);
  }, inject);
  await page.goto('/fleet');

  return {
    token: session.accessToken,
    refreshToken: session.refreshToken,
    workspaceId: seed.workspace.id,
    ambientId: seed.ambient.id,
    userId: session.user.id,
    h: {
      Authorization: `Bearer ${session.accessToken}`,
      'x-agentis-workspace': seed.workspace.id,
      'content-type': 'application/json',
    },
  };
}

/**
 * Waits for the side nav to be visible — a robust signal the dashboard is
 * mounted. The sidebar `<Link>`s render only a glyph as visible text and
 * use `title` for the accessible name, so we match by title attribute.
 */
export async function waitForShell(page: Page) {
  await expect(page.locator('a[title="Workflows"]')).toBeVisible({ timeout: 10_000 });
}
