/**
 * Chat-driven App build (AGENTIC-APPS-10X §4/§5, wiring gap a/b/c) — proves the
 * registry tool family lets a chat agent build a full app end to end: create the
 * App, define a collection, insert a row, render a data-bound surface, and query
 * it back. Also proves appId resolves from the viewport when the operator is on
 * an App surface (gap b), and that the tools reject without App context.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerAppDataTools } from '../../src/services/agentisToolHandlers/appData.js';
import { MemoryStore } from '../../src/services/memoryStore.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createInProcessEventBus } from '../../src/event-bus.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;
let baseCtx: AgentisToolContext;

beforeEach(async () => {
  ctx = await createTestContext();
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  const deps = {
    db: ctx.db,
    logger: ctx.logger,
    bus: createInProcessEventBus(),
    memory: new MemoryStore(ctx.db, ctx.logger),
  } as unknown as ToolHandlerDeps;
  registerAppDataTools(registry, deps);
  baseCtx = { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'chat' };
});

afterEach(() => ctx.close());

const exec = (toolId: string, args: Record<string, unknown>, c: AgentisToolContext = baseCtx) =>
  registry.execute({ id: 'r', toolId, arguments: args }, c);

describe('chat-driven App build', () => {
  it('builds a full data-bound app via registry tools', async () => {
    const created = await exec('agentis.app.create', { name: 'Sales CRM' });
    expect(created.ok).toBe(true);
    const appId = (created.output as { appId: string }).appId;
    expect(appId).toBeTruthy();

    expect((await exec('agentis.data.define_collection', { appId, name: 'leads', schema: { fields: [{ key: 'company', type: 'string', required: true }, { key: 'value', type: 'number' }] } })).ok).toBe(true);
    expect((await exec('agentis.data.insert', { appId, collection: 'leads', record: { company: 'Acme', value: 5000 } })).ok).toBe(true);

    expect((await exec('agentis.ui.action_schema', { appId, surface: 'home', actions: [{ name: 'add_lead', kind: 'data', target: 'leads.insert' }] })).ok).toBe(true);
    const rendered = await exec('agentis.ui.render', {
      appId,
      surface: 'home',
      view: { type: 'Stack', children: [{ type: 'Heading', value: 'Pipeline' }, { type: 'Table', bind: { collection: 'leads' }, columns: [{ key: 'company' }, { key: 'value' }] }] },
    });
    expect(rendered.ok).toBe(true);

    const q = await exec('agentis.data.query', { appId, collection: 'leads' });
    expect((q.output as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('resolves appId from the viewport when the operator is on the App surface', async () => {
    const appId = ((await exec('agentis.app.create', { name: 'Viewport App' })).output as { appId: string }).appId;
    const viewportCtx: AgentisToolContext = { ...baseCtx, viewport: { surface: 'app', resourceKind: 'app', resourceId: appId } as AgentisToolContext['viewport'] };
    // No appId arg — must resolve from viewport.
    const res = await exec('agentis.data.define_collection', { name: 'notes', schema: { fields: [{ key: 'text', type: 'string', required: true }] } }, viewportCtx);
    expect(res.ok).toBe(true);
  });

  it('rejects data tools with no App context', async () => {
    const res = await exec('agentis.data.query', { collection: 'leads' });
    expect(res.ok).toBe(false);
  });

  it('refactors an existing workflow into an App and adopts more logic', async () => {
    const seedWorkflow = (title: string) => {
      const id = randomUUID();
      ctx.db.insert(schema.workflows).values({ id, workspaceId: ctx.workspace.id, userId: ctx.user.id, title, graph: { version: 1, nodes: [], edges: [] } }).run();
      return id;
    };
    const wfId = seedWorkflow('Nightly report');

    // "Turn this workflow into an app" — the workflow becomes the App's logic.
    const created = await exec('agentis.app.create', { name: 'Reporting', adoptWorkflowId: wfId });
    expect(created.ok).toBe(true);
    const out = created.output as { appId: string; adoptedWorkflowId: string };
    expect(out.adoptedWorkflowId).toBe(wfId);
    const owned = ctx.db.select({ appId: schema.workflows.appId }).from(schema.workflows).where(eq(schema.workflows.id, wfId)).get();
    expect(owned?.appId).toBe(out.appId);

    // app.list surfaces it for the agent to operate on.
    const list = await exec('agentis.app.list', {});
    expect((list.output as { apps: Array<{ appId: string }> }).apps.some((a) => a.appId === out.appId)).toBe(true);

    // adopt a second workflow into the same App.
    const wf2 = seedWorkflow('Weekly digest');
    const adopted = await exec('agentis.app.adopt_workflow', { appId: out.appId, workflowId: wf2 });
    expect(adopted.ok).toBe(true);
    expect((adopted.output as { workflowIds: string[] }).workflowIds).toEqual(expect.arrayContaining([wfId, wf2]));
  });

  it('binds promoted records to the App brain scope, not the workspace', async () => {
    const appId = ((await exec('agentis.app.create', { name: 'Memory App' })).output as { appId: string }).appId;
    await exec('agentis.data.define_collection', { appId, name: 'prefs', schema: { fields: [{ key: 'note', type: 'string', required: true }] } });
    const rec = await exec('agentis.data.insert', { appId, collection: 'prefs', record: { note: 'prefers email' } });
    const recordId = (rec.output as { id: string }).id;
    const promoted = await exec('agentis.data.promote_memory', { appId, collection: 'prefs', id: recordId });
    expect(promoted.ok).toBe(true);
    const memoryId = (promoted.output as { memoryId: string }).memoryId;
    const row = ctx.db.select({ scopeId: schema.memoryEpisodes.scopeId }).from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.id, memoryId)).get();
    expect(row?.scopeId).toBe(appId);
  });
});
