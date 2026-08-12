import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanService } from '../../src/services/planService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('mission completion evidence', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('does not accept an optimistic final answer as proof of a build', async () => {
    const plans = new PlanService(ctx.db, ctx.bus);
    const plan = plans.createTask({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      objective: 'Build and verify a lead workflow',
      acceptanceCriteria: ['All requested deliverables are persisted.', 'Verification passes before completion.'],
    });
    const result = await plans.verifyCompletion(ctx.workspace.id, ctx.user.id, plan.id, {
      output: { text: 'Everything is working perfectly.' },
      evidence: [{ label: 'Final chat message' }],
      receipts: [],
    });
    expect(result.passed).toBe(false);
    expect(result.verification.outcome).toBe('not_accomplished');
    expect(result.verification.criteria.map((criterion) => criterion.reason).join(' ')).toMatch(/No successful persisted mutation|No successful functional verification/);
  });

  it('accepts the mission only when persisted work and functional proof are observed', async () => {
    const plans = new PlanService(ctx.db, ctx.bus);
    const plan = plans.createTask({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      objective: 'Build and verify an App interface',
      acceptanceCriteria: ['All requested deliverables are persisted.', 'Verification passes before completion.'],
    });
    const now = new Date().toISOString();
    const result = await plans.verifyCompletion(ctx.workspace.id, ctx.user.id, plan.id, {
      output: { text: 'Verified revision rev-1.' },
      receipts: [
        { id: 'receipt-mutation', kind: 'persisted_mutation', status: 'passed', tool: 'agentis.ui.render', resourceKind: 'app', resourceId: 'app-1', revisionId: 'rev-1', semanticHash: 'hash-1', observedAt: now },
        { id: 'receipt-verify', kind: 'functional_verification', status: 'passed', tool: 'agentis.app.verify', resourceKind: 'app', resourceId: 'app-1', revisionId: 'rev-1', semanticHash: 'hash-1', observedAt: now },
      ],
    });
    expect(result.passed).toBe(true);
    expect(result.verification.outcome).toBe('accomplished');
  });

  it('rejects functional evidence for a different or unidentified resource', async () => {
    const plans = new PlanService(ctx.db, ctx.bus);
    const plan = plans.createTask({ workspaceId: ctx.workspace.id, userId: ctx.user.id, objective: 'Build and verify a workflow' });
    const now = new Date().toISOString();
    const result = await plans.verifyCompletion(ctx.workspace.id, ctx.user.id, plan.id, {
      output: { text: 'Done' },
      receipts: [
        { id: 'mutation', kind: 'persisted_mutation', status: 'passed', tool: 'build', resourceId: 'wf-1', revisionId: 'rev-1', observedAt: now },
        { id: 'wrong-proof', kind: 'functional_verification', status: 'passed', tool: 'verify', resourceId: 'wf-2', revisionId: 'rev-1', observedAt: now },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.verification.outcome).toBe('not_accomplished');
  });
});
