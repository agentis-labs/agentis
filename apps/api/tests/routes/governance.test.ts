/**
 * /v1/governance/summary — surfaces existing audit/budget/approval/fleet data.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildGovernanceRoutes } from '../../src/routes/governance.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let adapters: AdapterManager;

beforeEach(async () => { ctx = await createTestContext(); adapters = new AdapterManager(ctx.logger); });
afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/governance', app: buildGovernanceRoutes({ db: ctx.db, auth: ctx.auth, adapters }) }]);
}

function seedAgent(adapterType: string, spend: number): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name: `agent-${adapterType}`, adapterType, capabilityTags: [], config: {}, status: 'online',
    currentMonthSpendCents: spend,
  }).run();
  return id;
}

describe('/v1/governance/summary', () => {
  it('composes fleet, cost, approvals and audit into one snapshot', async () => {
    const a1 = seedAgent('claude_code', 120);
    seedAgent('cursor', 80);

    // A spend event today.
    ctx.db.insert(schema.budgetEvents).values({
      id: randomUUID(), workspaceId: ctx.workspace.id, agentId: a1, eventType: 'spend', amountCents: 50, balanceAfterCents: 950,
    }).run();
    // A pending approval.
    ctx.db.insert(schema.approvalRequests).values({
      id: randomUUID(), workspaceId: ctx.workspace.id, userId: ctx.user.id, status: 'pending',
      title: 'Risky deploy', summary: 'approve?', source: 'workflow_checkpoint',
    }).run();

    const res = await app().request('/v1/governance/summary', { headers: ctx.authHeaders });
    const body = await res.json() as {
      fleet: { totalAgents: number; byAdapter: Record<string, { total: number; spendCents: number }> };
      cost: { spendTodayCents: number; monthlySpendCents: number };
      approvals: { pending: number };
      audit: { recentCount: number };
    };

    expect(body.fleet.totalAgents).toBe(2);
    expect(body.fleet.byAdapter.claude_code!.total).toBe(1);
    expect(body.fleet.byAdapter.claude_code!.spendCents).toBe(120);
    expect(body.cost.monthlySpendCents).toBe(200);
    expect(body.cost.spendTodayCents).toBe(50);
    expect(body.approvals.pending).toBe(1);
    expect(typeof body.audit.recentCount).toBe('number');
  });
});
