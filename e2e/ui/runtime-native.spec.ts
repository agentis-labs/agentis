import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '../fixtures';
import { uiAuth } from './_helpers';

test('runtime-native agent view exposes the real profile end to end', async ({ page, request }) => {
  test.setTimeout(90_000);
  const home = mkdtempSync(join(tmpdir(), 'agentis-e2e-hermes-'));
  try {
    writeFileSync(join(home, 'SOUL.md'), '# Native Hermes identity\n\nBe precise.', 'utf8');
    writeFileSync(join(home, 'config.yaml'), 'model:\n  default: native/model\n', 'utf8');
    writeFileSync(join(home, '.env'), 'RUNTIME_SECRET=must-not-leak\n', 'utf8');
    mkdirSync(join(home, 'skills', 'native-runtime'), { recursive: true });
    writeFileSync(
      join(home, 'skills', 'native-runtime', 'SKILL.md'),
      '# Native runtime skill',
      'utf8',
    );

    const auth = await uiAuth(page, request);
    const created = await request.post('/v1/agents', {
      headers: auth.h,
      data: {
        name: 'Runtime Native Hermes',
        adapterType: 'hermes_agent',
        role: 'worker',
        config: {
          binaryPath: process.execPath,
          command: process.execPath,
          env: { HERMES_HOME: home },
        },
      },
    });
    expect(created.status(), `agent create returned ${created.status()}`).toBe(201);
    const agent = await created.json() as { id: string };

    const runtimeResponse = await request.get(`/v1/agents/${agent.id}/runtime`, {
      headers: auth.h,
    });
    expect(runtimeResponse.ok()).toBeTruthy();
    const runtime = await runtimeResponse.json();
    expect(runtime.runtime.currentModel).toMatchObject({
      value: 'native/model',
      source: 'profile',
      verified: true,
    });

    const resourcesResponse = await request.get(`/v1/agents/${agent.id}/runtime/resources`, {
      headers: auth.h,
    });
    expect(resourcesResponse.ok()).toBeTruthy();
    const resources = await resourcesResponse.json() as {
      resources: Array<{ id: string; name: string; sensitive: boolean }>;
    };
    expect(resources.resources.map((resource) => resource.name)).toEqual(
      expect.arrayContaining(['SOUL.md', 'config.yaml', '.env', 'skills/native-runtime/SKILL.md']),
    );

    const secret = resources.resources.find((resource) => resource.name === '.env');
    expect(secret?.sensitive).toBe(true);
    const secretResponse = await request.get(
      `/v1/agents/${agent.id}/runtime/resources/${encodeURIComponent(secret!.id)}`,
      { headers: auth.h },
    );
    expect(await secretResponse.json()).toMatchObject({ content: '[redacted]' });

    await page.goto(`/agents/${agent.id}?tab=instructions`);
    await expect(page.getByRole('heading', { name: 'Runtime Native Hermes' })).toBeVisible();
    await expect(page.getByText('SOUL.md', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('skills/native-runtime/SKILL.md', { exact: true })).toBeVisible();
    await expect(page.getByText('# Native Hermes identity', { exact: false })).toBeVisible();

    await page.getByRole('tab', { name: 'Runtime' }).click();
    await expect(page.getByRole('heading', { name: 'Hermes Agent' })).toBeVisible();
    await expect(page.getByText('native/model', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Effective context')).toBeVisible();
    await expect(page.getByText('Conversation sessions')).toBeVisible();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
