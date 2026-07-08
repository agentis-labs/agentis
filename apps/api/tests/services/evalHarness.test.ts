/**
 * EvalHarness — agent-experience (AX) evaluation (§3.2). Proves the regression gate:
 * cold-start build tasks are graded on OUTCOME (real workspace state) with a hard
 * zero-duplicate requirement. A "solver" is agent code run through code-mode; here we
 * use scripted solvers to prove the graders (a real model just generates the code).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, ne } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerAppDataTools } from '../../src/services/agentisToolHandlers/appData.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { CodeModeService } from '../../src/services/codeMode.js';
import { EvalHarness, scoreTrials, type EvalGrader, type EvalTask, type EvalTrial } from '../../src/services/evalHarness.js';
import type { AgentisToolContext } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function harness() {
  const registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerAppDataTools(registry, { db: ctx.db, bus: ctx.bus } as ToolHandlerDeps);
  return new EvalHarness(new CodeModeService(registry), ctx.db);
}

function toolCtx(): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' };
}

const exactlyOneSales: EvalGrader = {
  name: 'exactly_one_active_sales_app',
  check: ({ db, workspaceId }) => {
    const sales = db.select({ name: schema.apps.name }).from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), ne(schema.apps.status, 'archived'))).all()
      .filter((a) => a.name.trim().toLowerCase() === 'sales');
    return { name: 'exactly_one_active_sales_app', pass: sales.length === 1, detail: `${sales.length} active "Sales" apps` };
  },
};

const buildSales: EvalTask = { id: 'build-sales', description: 'Ensure exactly one App named "Sales" exists.', graders: [exactlyOneSales] };
const consolidate: EvalTask = { id: 'consolidate', description: 'Consolidate duplicate "Sales" apps down to one.', graders: [exactlyOneSales] };

describe('EvalHarness', () => {
  it('cold-start build: find-or-create yields one app, zero duplicates, and is idempotent', async () => {
    const h = harness();
    const solver = `
      const list = await agentis.app.list();
      if (!list.apps.some(a => a.name === 'Sales')) await agentis.app.create({ name: 'Sales' });
      return (await agentis.app.list()).apps.filter(a => a.name === 'Sales').length;
    `;
    const t1 = await h.runTrial(buildSales, solver, toolCtx());
    expect(t1.ok).toBe(true);
    expect(t1.duplicates).toBe(0);
    expect(t1.grades.every((g) => g.pass)).toBe(true);

    // Re-running the same solver must NOT create a duplicate (find-or-create).
    const t2 = await h.runTrial(buildSales, solver, toolCtx());
    expect(t2.ok).toBe(true);
    expect(t2.duplicates).toBe(0);
  });

  it('catches the #1 failure: leftover duplicates fail the trial even if the solver "ran"', async () => {
    // Seed two REAL duplicate apps (AppStore bypasses the tool-layer find-or-create).
    const store = new AppStore(ctx.db);
    store.create(ctx.workspace.id, ctx.user.id, { name: 'Sales' });
    store.create(ctx.workspace.id, ctx.user.id, { name: 'Sales' });

    const h = harness();
    // A do-nothing solver leaves the duplicates → must fail (grader AND duplicate gate).
    const bad = await h.runTrial(consolidate, `return 'ignored the task';`, toolCtx());
    expect(bad.ok).toBe(false);
    expect(bad.duplicates).toBe(1);
    expect(bad.grades.find((g) => g.name === 'exactly_one_active_sales_app')?.pass).toBe(false);

    // A good solver archives the extras → one active, zero duplicates → passes.
    const good = await h.runTrial(consolidate, `
      const { apps } = await agentis.app.list();
      const sales = apps.filter(a => a.name === 'Sales');
      for (let i = 1; i < sales.length; i++) await agentis.app.archive({ appId: sales[i].appId });
      return sales.length;
    `, toolCtx());
    expect(good.ok).toBe(true);
    expect(good.duplicates).toBe(0);
  });

  it('scoreTrials computes pass@k (possible) vs pass^k (reliable)', () => {
    const ok = (): EvalTrial => ({ taskId: 't', ok: true, grades: [], duplicates: 0, toolCalls: 3 });
    const bad = (): EvalTrial => ({ taskId: 't', ok: false, grades: [], duplicates: 1, toolCalls: 1 });
    expect(scoreTrials([ok(), ok(), ok()])).toMatchObject({ passAtK: 1, passHatK: 1 });
    expect(scoreTrials([ok(), bad(), ok()])).toMatchObject({ passAtK: 1, passHatK: 0 }); // possible but not reliable
    expect(scoreTrials([bad(), bad()])).toMatchObject({ passAtK: 0, passHatK: 0, avgDuplicates: 1 });
  });
});
