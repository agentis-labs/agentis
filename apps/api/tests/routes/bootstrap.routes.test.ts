import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { buildAuthRoutes } from '../../src/routes/auth.js';
import { buildBootstrapRoutes } from '../../src/routes/bootstrap.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
}, 60_000); // createTestContext spins up auth keys + DB; give hook headroom under full-suite load.

afterEach(() => ctx.close());

describe('POST /v1/bootstrap', () => {
  it('accepts a settings-issued API key and creates the documented orchestrator', async () => {
    const adapters = new AdapterManager(ctx.logger);
    const app = ctx.buildApp([
      { path: '/v1/auth', app: buildAuthRoutes({ db: ctx.db, auth: ctx.auth }) },
      {
        path: '/v1/bootstrap',
        app: buildBootstrapRoutes({
          db: ctx.db,
          auth: ctx.auth,
          bridge: {} as never,
          vault: ctx.vault,
          adapters,
          logger: ctx.logger,
          bus: ctx.bus,
        }),
      },
    ]);
    const keyResponse = await app.request('/v1/auth/api-keys', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'Bootstrap' }),
    });
    const key = (await keyResponse.json() as { key: { secret: string } }).key.secret;

    const response = await app.request('/v1/bootstrap', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'x-agentis-workspace': ctx.workspace.id,
        'x-agentis-ambient': ctx.ambient.id,
      },
      body: JSON.stringify({ agent: { name: 'The Brain', adapterType: 'codex', role: 'orchestrator' } }),
    });
    expect(response.status).toBe(201);
    const agent = ctx.db.select().from(schema.agents).where(eq(schema.agents.role, 'orchestrator')).get();
    expect(agent?.name).toBe('The Brain');
  }, 90_000); // bootstrap registers a CLI (codex) adapter — harness probing is legitimately slow; the
  // test runs in ~12s standalone but can exceed 30s under full-suite CPU contention, so allow headroom.
});
