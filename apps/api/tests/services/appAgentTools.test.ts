/**
 * AG-UI + Datastore agent tools (AGENTIC-APPS-10X §4/§5) — the agent-authored
 * full-stack loop. Proves an agent can, via tools alone: define a typed
 * collection, author a data-bound surface, declare actions, insert rows, and
 * that datastore writes + surface renders emit the realtime events the
 * AppRuntime binds to. This is the "no developer in the loop" claim, tested.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppDatastore, AppStore, AppSurfaceStore } from '@agentis/app';
import { AgentToolRuntime } from '../../src/services/agent/agentToolRuntime.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import type { WorkspaceVolumeService } from '../../src/services/workspace/workspaceVolume.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let runtime: AgentToolRuntime;
let appId: string;
const dataEvents: Array<{ op: string; collection: string }> = [];
const surfaceEvents: Array<{ event: string }> = [];

const volumeStub = {} as unknown as WorkspaceVolumeService;

beforeEach(async () => {
  ctx = await createTestContext();
  dataEvents.length = 0;
  surfaceEvents.length = 0;
  const appData = new AppDatastore(ctx.db, (e) => dataEvents.push({ op: e.op, collection: e.collection }));
  const appSurfaces = new AppSurfaceStore({ db: ctx.db, emit: (e) => surfaceEvents.push({ event: e.event }) });
  const memory = new MemoryStore(ctx.db, ctx.logger);
  runtime = new AgentToolRuntime({ volume: volumeStub, appData, appSurfaces, memory });
  appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Helpdesk' }).id;
});

afterEach(() => ctx.close());

const run = (tool: Parameters<AgentToolRuntime['execute']>[1], args: Record<string, unknown>) =>
  runtime.execute(ctx.workspace.id, tool, args, undefined, { appId });

describe('Agentic App agent tools', () => {
  it('lets an agent build a full data-bound surface end to end', async () => {
    const defined = await run('data_define_collection', {
      name: 'tickets',
      schema: { fields: [{ key: 'subject', type: 'string', required: true }, { key: 'priority', type: 'number' }] },
    });
    expect(defined.ok).toBe(true);

    const ins = await run('data_insert', { collection: 'tickets', record: { subject: 'Cannot log in', priority: 1 } });
    expect(ins.ok).toBe(true);
    expect(dataEvents).toContainEqual({ op: 'insert', collection: 'tickets' });

    const actions = await run('ui_action_schema', {
      surface: 'home',
      actions: [{ name: 'create_ticket', kind: 'data', target: 'tickets.insert', inputSchema: {} }],
    });
    expect(actions.ok).toBe(true);

    const rendered = await run('ui_render', {
      surface: 'home',
      view: {
        type: 'Stack',
        children: [
          { type: 'Heading', value: 'Open tickets' },
          { type: 'Table', bind: { collection: 'tickets', sort: [{ field: 'priority', dir: 'asc' }] }, columns: [{ key: 'subject' }, { key: 'priority' }] },
          { type: 'Button', label: 'New ticket', action: { action: 'create_ticket' } },
        ],
      },
    });
    expect(rendered.ok).toBe(true);
    expect(surfaceEvents).toContainEqual({ event: 'render' });

    // Surface persisted with the bound view + declared action.
    const surface = new AppSurfaceStore({ db: ctx.db }).get(ctx.workspace.id, appId, 'home');
    expect(surface.view?.type).toBe('Stack');
    expect(surface.actions).toHaveLength(1);
    expect(surface.actions[0]!.target).toBe('tickets.insert');

    // The bound query returns what the agent inserted.
    const q = await run('data_query', { collection: 'tickets' });
    expect((q.result as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('ui_patch mutates the persisted tree and bumps revision', async () => {
    await run('ui_render', { surface: 'home', view: { type: 'Stack', children: [{ type: 'Heading', value: 'A' }] } });
    const patched = await run('ui_patch', { surface: 'home', ops: [{ op: 'set', path: 'children/0/value', value: 'B' }] });
    expect(patched.ok).toBe(true);

    const surface = new AppSurfaceStore({ db: ctx.db }).get(ctx.workspace.id, appId, 'home');
    const view = surface.view as { children: Array<{ value: string }> };
    expect(view.children[0]!.value).toBe('B');
    expect(surface.revision).toBe(1); // fresh surface created at rev 0, patch bumps to 1
  });

  it('inspects compact semantic ids and removes one component without replacing the tree', async () => {
    await run('ui_render', {
      surface: 'home',
      view: { type: 'Stack', children: [{ type: 'Heading', value: 'Keep' }, { type: 'Callout', title: 'Remove me', value: 'Temporary' }] },
    });
    const inspected = await run('ui_inspect', { surface: 'home' });
    expect(inspected.ok).toBe(true);
    const outline = (inspected.result as { surfaces: Array<{ nodes: Array<{ nodeId: string; type: string }> }> }).surfaces[0]!.nodes;
    const target = outline.find((node) => node.type === 'Callout');
    expect(target?.nodeId).toBeTruthy();

    const removed = await run('ui_remove', { surface: 'home', nodeId: target!.nodeId });
    expect(removed.ok).toBe(true);
    const stored = new AppSurfaceStore({ db: ctx.db }).get(ctx.workspace.id, appId, 'home');
    expect(JSON.stringify(stored.view)).toContain('Keep');
    expect(JSON.stringify(stored.view)).not.toContain('Remove me');
  });

  it('promotes a datastore record into workspace memory (brain bridge)', async () => {
    await run('data_define_collection', { name: 'customers', schema: { fields: [{ key: 'name', type: 'string', required: true }, { key: 'pref', type: 'string' }] } });
    const ins = await run('data_insert', { collection: 'customers', record: { name: 'Acme', pref: 'email only' } });
    const recordId = (ins.result as { id: string }).id;

    const promoted = await run('data_promote_memory', { collection: 'customers', id: recordId, title: 'Acme contact pref' });
    expect(promoted.ok).toBe(true);
    expect((promoted.result as { promoted: boolean; memoryId: string }).promoted).toBe(true);
    const memoryId = (promoted.result as { memoryId: string }).memoryId;
    expect(memoryId).toBeTruthy();

    // Regression: a promoted memory MUST be scoped to the App (AGENTIC-APPS-10X
    // §5.4) so it appears as a node in the App's own Brain map, not only —
    // invisibly to the App — in the Workspace Brain. A stale duplicate tool
    // handler once wrote scopeId: null here, silently orphaning every App's
    // promoted learning from its own Brain.
    const row = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.id, memoryId)).get();
    expect(row?.scopeId).toBe(appId);
  });

  it('rejects data tools when no App context is resolvable', async () => {
    const res = await runtime.execute(ctx.workspace.id, 'data_query', { collection: 'tickets' }, undefined, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Agentic App context/);
  });
});
