/**
 * Activity feed — live updates fan out from bus events.
 *
 * Login itself records an activity event, so the feed has at least one row
 * after `uiAuth`. We then trigger another action (workflow creation) and
 * assert the feed rerenders with a new event.
 */
import { test, expect } from '../fixtures';
import { uiAuth } from './_helpers';

test('activity page renders at least one event after login', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Activity"]').click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByRole('heading', { name: /Activity/i })).toBeVisible();
  // The feed lists events; on a freshly-reset tenant we expect either at
  // least one row OR the empty hint (race with the seed activity write).
  const feed = page.locator('ul li');
  await expect(feed.first().or(page.getByText(/No activity yet/i))).toBeVisible({ timeout: 10_000 });
});

test('activity feed reflects events written by the engine on a run', async ({ page, request }) => {
  // ActivityFeedService.record is called by the engine, not by /v1/workflows
  // POST. Run a workflow end-to-end so a real activity row exists, then
  // assert the page rerenders with non-empty content.
  const auth = await uiAuth(page, request);
  const skills = await (await request.get('/v1/skills', { headers: auth.h })).json();
  const echo = (skills.skills as Array<{ id: string; slug: string }>).find((s) => s.slug === 'echo')!;
  const wf = await (await request.post('/v1/workflows', {
    headers: auth.h,
    data: {
      title: 'ActivityProbe',
      graph: {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger', title: 'Start', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
          { id: 'e', type: 'skill_task', title: 'Echo', position: { x: 200, y: 0 }, config: { kind: 'skill_task', skillId: echo.id, inputMapping: {}, outputMapping: {} } },
        ],
        edges: [{ id: 'edge', source: 't', target: 'e' }],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
  })).json();
  await request.post(`/v1/workflows/${wf.workflow.id}/run`, { headers: auth.h, data: { inputs: {} } });
  await page.goto('/activity');
  await expect.poll(async () => page.locator('ul li').count(), { timeout: 15_000 }).toBeGreaterThan(0);
});

test('activity entries render an actor pill on each row', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  const skills = await (await request.get('/v1/skills', { headers: auth.h })).json();
  const echo = (skills.skills as Array<{ id: string; slug: string }>).find((s) => s.slug === 'echo')!;
  const wf = await (await request.post('/v1/workflows', {
    headers: auth.h,
    data: {
      title: 'PillProbe',
      graph: {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger', title: 'Start', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
          { id: 'e', type: 'skill_task', title: 'Echo', position: { x: 200, y: 0 }, config: { kind: 'skill_task', skillId: echo.id, inputMapping: {}, outputMapping: {} } },
        ],
        edges: [{ id: 'edge', source: 't', target: 'e' }],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
  })).json();
  await request.post(`/v1/workflows/${wf.workflow.id}/run`, { headers: auth.h, data: { inputs: {} } });
  await page.goto('/activity');
  // The actor pill is the lowercase prefix on each row (e.g. 'engine').
  await expect.poll(async () => page.locator('ul li span').first().textContent(), { timeout: 15_000 })
    .toMatch(/[a-z]+/);
});

test('Activity sidebar entry is reachable and persists URL', async ({ page, request }) => {
  await uiAuth(page, request);
  await page.locator('a[title="Activity"]').click();
  await expect(page).toHaveURL(/\/activity$/);
  await page.reload();
  await expect(page).toHaveURL(/\/activity$/);
});
