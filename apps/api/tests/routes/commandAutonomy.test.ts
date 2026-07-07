/**
 * /v1/command/autonomy — per-workspace opt-in for the autonomous Command Heartbeat.
 * Autonomy is effective only when BOTH the deployment master and the per-workspace
 * switch are on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { buildCommandAutonomyRoutes } from '../../src/routes/commandAutonomy.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function appWith(master: boolean) {
  return ctx.buildApp([{ path: '/v1/command', app: buildCommandAutonomyRoutes({ db: ctx.db, auth: ctx.auth, master }) }]);
}

describe('/v1/command/autonomy', () => {
  it('defaults off; PUT toggles; effective requires the master', async () => {
    const app = appWith(true);
    let res = await app.request('/v1/command/autonomy', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, master: true, effective: false });

    res = await app.request('/v1/command/autonomy', { method: 'PUT', headers: ctx.authHeaders, body: JSON.stringify({ enabled: true }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, master: true, effective: true });

    res = await app.request('/v1/command/autonomy', { headers: ctx.authHeaders });
    expect(await res.json()).toMatchObject({ enabled: true, effective: true });
  });

  it('master off keeps effective false even when the workspace opted in', async () => {
    const app = appWith(false);
    await app.request('/v1/command/autonomy', { method: 'PUT', headers: ctx.authHeaders, body: JSON.stringify({ enabled: true }) });
    const res = await app.request('/v1/command/autonomy', { headers: ctx.authHeaders });
    expect(await res.json()).toMatchObject({ enabled: true, master: false, effective: false });
  });

  it('rejects a non-boolean body', async () => {
    const app = appWith(true);
    const res = await app.request('/v1/command/autonomy', { method: 'PUT', headers: ctx.authHeaders, body: JSON.stringify({ enabled: 'yes' }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
