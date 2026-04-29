/**
 * Ledger panel — for a completed run the events list streams in over the
 * realtime channel and the node states reach COMPLETED.
 */
import { test, expect } from '../fixtures';
import { uiAuth } from './_helpers';

async function seedRun(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  const auth = await uiAuth(page, request);
  // Reuse the canvas seed shape so the auto-bind to `echo` skill kicks in.
  const skills = await (await request.get('/v1/skills', { headers: auth.h })).json();
  const echo = (skills.skills as Array<{ id: string; slug: string }>).find((s) => s.slug === 'echo');
  expect(echo, 'echo skill must exist after reset').toBeTruthy();

  const wf = await (await request.post('/v1/workflows', {
    headers: auth.h,
    data: {
      title: 'LedgerProbe',
      graph: {
        version: 1,
        nodes: [
          { id: 't', type: 'trigger', title: 'Start', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
          { id: 'e', type: 'skill_task', title: 'Echo', position: { x: 200, y: 0 }, config: { kind: 'skill_task', skillId: echo!.id, inputMapping: {}, outputMapping: {} } },
        ],
        edges: [{ id: 'edge', source: 't', target: 'e' }],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
  })).json();

  const run = await (await request.post(`/v1/workflows/${wf.workflow.id}/run`, {
    headers: auth.h,
    data: { inputs: { hello: 'world' } },
  })).json();
  return { auth, runId: run.runId };
}

test('completed run shows ledger events with the events count', async ({ page, request }) => {
  const { runId } = await seedRun(page, request);
  await page.goto(`/runs/${runId}`);
  await expect(page.getByText(/events$/)).toBeVisible({ timeout: 15_000 });
  // Wait for at least one event row to flush.
  await expect.poll(async () => page.locator('div.font-mono.text-xs').count(), { timeout: 15_000 }).toBeGreaterThan(0);
});

test('completed run reaches COMPLETED status', async ({ page, request }) => {
  const { runId } = await seedRun(page, request);
  await page.goto(`/runs/${runId}`);
  await expect(page.getByText('COMPLETED').first()).toBeVisible({ timeout: 15_000 });
});

test('ledger renders the Nodes section once the run completes', async ({ page, request }) => {
  const { runId } = await seedRun(page, request);
  await page.goto(`/runs/${runId}`);
  // Wait for the run to reach a terminal status so node states populate.
  await expect(page.getByText(/COMPLETED|FAILED/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Nodes/i).first()).toBeVisible();
});

test('ledger header includes the run uuid in the side card', async ({ page, request }) => {
  const { runId } = await seedRun(page, request);
  await page.goto(`/runs/${runId}`);
  await expect(page.getByText(runId)).toBeVisible({ timeout: 15_000 });
});
