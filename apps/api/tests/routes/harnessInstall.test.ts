import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHarnessRoutes } from '../../src/routes/harness.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
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
