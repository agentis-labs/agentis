import { expect, test } from '../fixtures';
import { uiAuth } from './_helpers';

test('agents canvas renders and clicking a node opens the inline detail panel', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  const res = await request.post('/v1/agents', {
    headers: auth.h,
    data: {
      name: 'CanvasSpec',
      description: 'Canvas detail panel smoke test',
      adapterType: 'http',
      role: 'manager',
      config: { url: 'http://127.0.0.1:9' },
    },
  });
  expect(res.status(), `agent create returned ${res.status()}`).toBe(201);

  await page.goto('/agents');
  await expect(page.getByText(/Managers/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('CanvasSpec')).toBeVisible();

  await page.getByText('CanvasSpec').click();

  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole('button', { name: /Open page/i })).toBeVisible();
  await expect(page.getByText(/Spend today/i)).toBeVisible();
});