/**
 * §5.3 workspace/day budget route + §6.4 pin-to-workspace artifact route.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { schema } from '@agentis/db/sqlite';
import { buildBudgetRoutes } from '../../src/routes/budgets.js';
import { buildArtifactRoutes } from '../../src/routes/artifacts.js';
import { ArtifactService } from '../../src/services/artifactService.js';
import { AssetStore } from '../../src/services/assetStore.js';
import { BudgetService } from '../../src/services/budget.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AuditTrailService } from '../../src/services/auditTrail.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function budgetApp() {
  const budget = new BudgetService({
    db: ctx.db, bus: ctx.bus,
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    audit: new AuditTrailService(ctx.db, ctx.logger),
  });
  return ctx.buildApp([{ path: '/v1/budgets', app: buildBudgetRoutes({ db: ctx.db, auth: ctx.auth, budget }) }]);
}

function artifactApp() {
  const artifacts = new ArtifactService(ctx.db, ctx.logger, ctx.bus);
  const assets = new AssetStore(tmpdir(), artifacts, ctx.db, ctx.logger);
  return ctx.buildApp([{ path: '/v1/artifacts', app: buildArtifactRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus, artifacts, assets }) }]);
}

describe('/v1/budgets workspace daily ceiling', () => {
  it('sets and reports the workspace daily budget', async () => {
    const a = budgetApp();
    const patch = await a.request('/v1/budgets/workspace', { method: 'PATCH', headers: ctx.authHeaders, body: JSON.stringify({ dailyBudgetCents: 5000 }) });
    expect(patch.status).toBe(200);

    const list = await a.request('/v1/budgets', { headers: ctx.authHeaders });
    const body = await list.json() as { dailyBudgetCents: number | null; todaySpendCents: number };
    expect(body.dailyBudgetCents).toBe(5000);
    expect(body.todaySpendCents).toBe(0);
  });

  it('clears the ceiling with null', async () => {
    const a = budgetApp();
    await a.request('/v1/budgets/workspace', { method: 'PATCH', headers: ctx.authHeaders, body: JSON.stringify({ dailyBudgetCents: 100 }) });
    await a.request('/v1/budgets/workspace', { method: 'PATCH', headers: ctx.authHeaders, body: JSON.stringify({ dailyBudgetCents: null }) });
    const list = await a.request('/v1/budgets', { headers: ctx.authHeaders });
    expect((await list.json() as { dailyBudgetCents: number | null }).dailyBudgetCents).toBeNull();
  });
});

describe('/v1/artifacts pin-to-workspace', () => {
  function seedArtifact(): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    ctx.db.insert(schema.artifacts).values({
      id, workspaceId: ctx.workspace.id, userId: ctx.user.id,
      type: 'document', title: 'Report', content: 'x', metadata: {}, createdAt: now, updatedAt: now,
    }).run();
    return id;
  }

  it('pins an artifact and surfaces it under ?pinned=true', async () => {
    const a = artifactApp();
    const id = seedArtifact();

    const before = await a.request('/v1/artifacts?pinned=true', { headers: ctx.authHeaders });
    expect((await before.json() as { artifacts: unknown[] }).artifacts).toHaveLength(0);

    const pin = await a.request(`/v1/artifacts/${id}/pin`, { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ pinned: true }) });
    expect(pin.status).toBe(200);
    expect((await pin.json() as { artifact: { pinned: boolean } }).artifact.pinned).toBe(true);

    const after = await a.request('/v1/artifacts?pinned=true', { headers: ctx.authHeaders });
    expect((await after.json() as { artifacts: Array<{ id: string }> }).artifacts.map((x) => x.id)).toContain(id);

    const unpin = await a.request(`/v1/artifacts/${id}/pin`, { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ pinned: false }) });
    expect((await unpin.json() as { artifact: { pinned: boolean } }).artifact.pinned).toBe(false);
  });
});
