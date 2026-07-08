import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHarnessRoutes } from '../../src/routes/harness.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
const originalOpenAiModel = process.env.OPENAI_MODEL;
const originalCodexHome = process.env.CODEX_HOME;
let tempCodexHome: string | null = null;

beforeEach(async () => {
  ctx = await createTestContext();
  tempCodexHome = mkdtempSync(join(tmpdir(), 'agentis-codex-home-'));
  process.env.CODEX_HOME = tempCodexHome;
  delete process.env.OPENAI_MODEL;
});

afterEach(() => {
  if (originalOpenAiModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalOpenAiModel;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (tempCodexHome) rmSync(tempCodexHome, { recursive: true, force: true });
  tempCodexHome = null;
  ctx.close();
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/harness',
      app: buildHarnessRoutes({ db: ctx.db, auth: ctx.auth }),
    },
  ]);
}

describe('/v1/harness install routes', () => {
  it('lists install options with claude_code auto-installable', async () => {
    const response = await app().request('/v1/harness/install-options', {
      headers: ctx.authHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      adapters: Array<{ adapterType: string; canAutoInstall: boolean }>;
    };
    const claude = body.adapters.find((adapter) => adapter.adapterType === 'claude_code');
    expect(claude?.canAutoInstall).toBe(true);
    const http = body.adapters.find((adapter) => adapter.adapterType === 'http');
    expect(http?.canAutoInstall).toBe(false);
  });

  it('lists selectable LLM models for a runtime', async () => {
    const response = await app().request('/v1/harness/models/codex', {
      headers: ctx.authHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      defaultModel: string | null;
      models: Array<{ id: string; label: string; provider: string }>;
    };
    // gpt-5.5 is the fallback default — it works on both ChatGPT-account and
    // API-key Codex auth (the `*-codex` ids are rejected on a ChatGPT account).
    expect(body.defaultModel).toBe('gpt-5.5');
    expect(body.models.some((model) => model.id === 'gpt-5.5' && model.provider === 'OpenAI')).toBe(true);
    // The `*-codex` ids stay available for API-key users.
    expect(body.models.some((model) => model.id === 'gpt-5.3-codex' && model.provider === 'OpenAI')).toBe(true);
  });

  it('prefers the configured runtime default model from the environment', async () => {
    process.env.OPENAI_MODEL = 'gpt-real-runtime';
    const response = await app().request('/v1/harness/models/codex', {
      headers: ctx.authHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      defaultModel: string | null;
      defaultLabel: string;
      models: Array<{ id: string; label: string; provider: string }>;
    };
    expect(body.defaultModel).toBe('gpt-real-runtime');
    expect(body.defaultLabel).toBe('Detected runtime default');
    expect(body.models.some((model) => model.id === 'gpt-real-runtime' && model.provider === 'OpenAI')).toBe(true);
  });

  it('detects the real Codex runtime model from CODEX_HOME config.toml', async () => {
    writeFileSync(join(tempCodexHome, 'config.toml'), 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\nservice_tier = "default"\n');
    process.env.CODEX_HOME = tempCodexHome;
    delete process.env.OPENAI_MODEL;

    const response = await app().request('/v1/harness/models/codex', {
      headers: ctx.authHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      defaultModel: string | null;
      defaultLabel: string;
      models: Array<{ id: string; provider: string }>;
    };
    expect(body.defaultModel).toBe('gpt-5.5');
    expect(body.defaultLabel).toBe('Detected runtime default');
    expect(body.models.some((model) => model.id === 'gpt-5.5' && model.provider === 'OpenAI')).toBe(true);
  });

  it('rejects an install for a non-auto-installable harness', async () => {
    const response = await app().request('/v1/harness/install', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ adapterType: 'http' }),
    });
    expect(response.status).toBe(422);
  });

  it('rejects an install with no adapter type', async () => {
    const response = await app().request('/v1/harness/install', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(422);
  });
});
