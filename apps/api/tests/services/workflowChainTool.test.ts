/**
 * agentis.workflow.chain — persist App-level run ORDER + dependsOn chaining.
 *
 * The field failure this closes: an agent narrated "workflow order is now
 * recorded as 1…2…3…" but NO tool existed to persist a binding, so nothing was
 * written. This tool actually writes settings.appBinding, validates membership,
 * and rejects self-deps and cycles.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import type { WorkflowGraph, AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerAppDataTools } from '../../src/services/agentisToolHandlers/appData.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function toolCtx(): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' };
}

function registry() {
  const r = new AgentisToolRegistry({ logger: ctx.logger });
  registerAppDataTools(r, { db: ctx.db, bus: ctx.bus } as ToolHandlerDeps);
  return r;
}

const GRAPH: WorkflowGraph = {
  version: 1, viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } }],
  edges: [],
};

function seedWorkflow(title: string, appId: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    appId, title, description: title, graph: GRAPH, settings: {},
  }).run();
  return id;
}

function bindingOf(workflowId: string): Record<string, unknown> {
  const row = ctx.db.select({ settings: schema.workflows.settings }).from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
  return ((row?.settings as Record<string, unknown>)?.appBinding ?? {}) as Record<string, unknown>;
}

describe('agentis.workflow.chain', () => {
  it('persists order + dependsOn to each workflow binding (real write, not narration)', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Chain App' }).id;
    const a = seedWorkflow('First', appId);
    const b = seedWorkflow('Second', appId);
    const r = registry();

    const res = await r.execute({ id: '', toolId: 'agentis.workflow.chain', arguments: {
      appId,
      workflows: [
        { workflowId: a, order: 0 },
        { workflowId: b, order: 1, dependsOn: [a], chainOn: 'success' },
      ],
    } }, toolCtx());

    expect(res.ok).toBe(true);
    // Persisted, not narrated.
    expect(bindingOf(a)).toMatchObject({ order: 0 });
    expect(bindingOf(b)).toMatchObject({ order: 1, dependsOn: [a], chainOn: 'success' });
    const runOrder = (res.output as { runOrder: Array<{ workflowId: string }> }).runOrder;
    expect(runOrder.map((w) => w.workflowId)).toEqual([a, b]);
  });

  it('`sequence` wires a REAL dependsOn chain (not just display order) — the "runs after" boxes', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Seq App' }).id;
    const a = seedWorkflow('A', appId);
    const b = seedWorkflow('B', appId);
    const c = seedWorkflow('C', appId);
    const res = await registry().execute({ id: '', toolId: 'agentis.workflow.chain', arguments: { appId, sequence: [a, b, c] } }, toolCtx());
    expect(res.ok).toBe(true);
    // Order AND dependsOn chain both set.
    expect(bindingOf(a)).toMatchObject({ order: 0, dependsOn: [] });
    expect(bindingOf(b)).toMatchObject({ order: 1, dependsOn: [a] });
    expect(bindingOf(c)).toMatchObject({ order: 2, dependsOn: [b] });
    expect((res.output as { chained: boolean }).chained).toBe(true);
  });

  it('warns when only ORDER is set with no dependencies (hollow chain)', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Hollow' }).id;
    const a = seedWorkflow('A', appId);
    const b = seedWorkflow('B', appId);
    const res = await registry().execute({ id: '', toolId: 'agentis.workflow.chain', arguments: { appId, workflows: [{ workflowId: a, order: 0 }, { workflowId: b, order: 1 }] } }, toolCtx());
    expect((res.output as { chained: boolean }).chained).toBe(false);
    expect((res.output as { note?: string }).note).toMatch(/not chained|runs after|sequence/i);
  });

  it('merges into an existing binding without clobbering untouched fields', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Merge App' }).id;
    const a = seedWorkflow('A', appId);
    const r = registry();
    await r.execute({ id: '', toolId: 'agentis.workflow.chain', arguments: { appId, workflows: [{ workflowId: a, order: 5, purpose: 'intake' }] } }, toolCtx());
    await r.execute({ id: '', toolId: 'agentis.workflow.chain', arguments: { appId, workflows: [{ workflowId: a, enabled: false }] } }, toolCtx());
    expect(bindingOf(a)).toMatchObject({ order: 5, purpose: 'intake', enabled: false });
  });

  it('rejects a self-dependency', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Self' }).id;
    const a = seedWorkflow('A', appId);
    const res = await registry().execute({ id: '', toolId: 'agentis.workflow.chain', arguments: { appId, workflows: [{ workflowId: a, dependsOn: [a] }] } }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/depend on itself/i);
  });

  it('rejects a dependency cycle across the full graph', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Cycle' }).id;
    const a = seedWorkflow('A', appId);
    const b = seedWorkflow('B', appId);
    const r = registry();
    await r.execute({ id: '', toolId: 'agentis.workflow.chain', arguments: { appId, workflows: [{ workflowId: b, dependsOn: [a] }] } }, toolCtx());
    // Now make a depend on b → cycle a→b→a.
    const res = await r.execute({ id: '', toolId: 'agentis.workflow.chain', arguments: { appId, workflows: [{ workflowId: a, dependsOn: [b] }] } }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/cycle/i);
    // The rejected write did NOT persist.
    expect(bindingOf(a).dependsOn ?? []).toEqual([]);
  });

  it('rejects a workflow that is not part of the app', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Members' }).id;
    const stray = seedWorkflow('Stray', null as unknown as string); // bare, un-adopted
    const res = await registry().execute({ id: '', toolId: 'agentis.workflow.chain', arguments: { appId, workflows: [{ workflowId: stray, order: 0 }] } }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/not part of app/i);
  });
});
