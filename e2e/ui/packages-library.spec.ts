import { test, expect } from '../fixtures';
import { uiAuth, waitForShell } from './_helpers';

test('packages library filters abilities, workflows, and creates extensions', async ({ page, request }) => {
  const auth = await uiAuth(page, request);
  await waitForShell(page);

  await request.post('/v1/abilities', {
    headers: auth.h,
    data: {
      name: 'Support Tone',
      slug: 'support-tone',
      description: 'Keeps customer-facing replies precise and calm.',
      domainTag: 'support',
      iconEmoji: 'ST',
    },
  });

  await request.post('/v1/workflows', {
    headers: auth.h,
    data: {
      title: 'Invoice triage',
      summary: 'Routes inbound invoices for review.',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      settings: {},
    },
  });

  await page.goto('/packages');
  await expect(page.getByRole('heading', { name: 'Packages', level: 1 })).toBeVisible({ timeout: 15_000 });

  await expect(page.getByRole('tab', { name: /All/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Abilities/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Workflows/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Extensions/ })).toBeVisible();

  await expect(page.getByText('Support Tone')).toBeVisible();
  await expect(page.getByText('Invoice triage')).toBeVisible();

  await page.getByRole('tab', { name: /Abilities/ }).click();
  await expect(page.getByText('Support Tone')).toBeVisible();
  await expect(page.getByText('Invoice triage')).not.toBeVisible();

  await page.getByRole('tab', { name: /Workflows/ }).click();
  await expect(page.getByText('Invoice triage')).toBeVisible();
  await expect(page.getByText('Support Tone')).not.toBeVisible();

  await page.getByRole('tab', { name: /Extensions/ }).click();
  await expect(page.getByText('Extension runtime')).toBeVisible();

  await page.getByRole('button', { name: 'New extension' }).click();
  await page.getByLabel('Name', { exact: true }).fill('HTML Metadata Extractor');
  await expect(page.getByLabel('Slug', { exact: true })).toHaveValue('html-metadata-extractor');
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Extracts title and meta tags from an allowed HTML page.');
  await page.getByRole('button', { name: 'Create extension' }).click();

  await expect(page.getByText('Extension created')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'HTML Metadata Extractor' })).toBeVisible();
  await expect(page.getByText('html-metadata-extractor@1.0.0').first()).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).last().click();
  await expect(page.getByRole('button', { name: 'HTML Metadata Extractor' })).toBeVisible();

  await page.getByRole('tab', { name: /All/ }).click();
  await expect(page.getByRole('button', { name: 'HTML Metadata Extractor' })).toBeVisible();
  await expect(page.getByText('Support Tone')).toBeVisible();
  await expect(page.getByText('Invoice triage')).toBeVisible();
});
