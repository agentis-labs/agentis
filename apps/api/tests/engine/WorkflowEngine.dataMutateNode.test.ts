/**
 * WorkflowEngine — `data_mutate` node (masterplan 4.x).
 *
 * A workflow can insert / delete Agentic App datastore records.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { AppStore, AppDatastore } from '@agentis/app';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let ds: AppDatastore;
let appId: string;
beforeEach(async () => {
  ctx = await createTestContext();
  ds = new AppDatastore(ctx.db);
  appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'CRM' }).id;
  ds.defineCollection(ctx.workspace.id, appId, { name: 'leads', schema: { fields: [{ key: 'name', type: 'string', required: true }] } });
});
afterEach(() => ctx.close());

async function runMutate(config: Record<string, unknown>, opts: { omitAppId?: boolean } = {}): Promise<Record<string, unknown>> {
  const nodeConfig = { kind: 'data_mutate', collection: 'leads', ...(opts.omitAppId ? {} : { appId }), ...config };
  const graph = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 't', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'M', type: 'data_mutate', title: 'm', position: { x: 1, y: 0 }, config: nodeConfig },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'M' }],
  } as unknown as WorkflowGraph;
  const wfId = randomUUID();
  const runId = randomUUID();
  // When the node omits appId, the workflow must be owned by the App so the engine resolves it.
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'm-wf', graph, settings: {}, ...(opts.omitAppId ? { appId } : {}) }).run();
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {} }).run();

  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    appData: ds,
    ...(opts.omitAppId
      ? { resolveAppIdForWorkflow: (_ws: string, wf: string) => ctx.db.select({ appId: schema.workflows.appId }).from(schema.workflows).where(eq(schema.workflows.id, wf)).get()?.appId ?? undefined }
      : {}),
  });
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) { clearTimeout(timer); off(); resolve(); }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  });
  const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  expect(run.status).toBe('COMPLETED');
  const state = run.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
  return state.nodeStates.M?.outputData ?? {};
}

describe('WorkflowEngine — data_mutate node', () => {
  it('inserts a record into the collection', async () => {
    const out = await runMutate({ operation: 'insert', record: { name: 'Acme' } });
    expect((out.record as { id: string }).id).toBeTruthy();
    const rows = ds.query(ctx.workspace.id, appId, 'leads', {}).rows;
    expect(rows).toHaveLength(1);
    expect((rows[0]!.data as { name: string }).name).toBe('Acme');
  });

  it('deletes a record by id', async () => {
    const seeded = ds.insert(ctx.workspace.id, appId, 'leads', { name: 'Gone' });
    expect(ds.query(ctx.workspace.id, appId, 'leads', {}).rows).toHaveLength(1);
    const out = await runMutate({ operation: 'delete', recordId: seeded.id });
    expect(out).toEqual({ deleted: seeded.id });
    expect(ds.query(ctx.workspace.id, appId, 'leads', {}).rows).toHaveLength(0);
  });

  // The data loop: a workflow built BEFORE its App exists omits appId on the node;
  // the engine resolves it from the owning workflow at run time and the record lands
  // in the collection the interface binds to. (Without this, the UI never populates.)
  it('persists with NO appId on the node — resolves the owning App from the running workflow', async () => {
    const out = await runMutate({ operation: 'insert', record: { name: 'FromWorkflow' } }, { omitAppId: true });
    expect((out.record as { id: string }).id).toBeTruthy();
    const rows = ds.query(ctx.workspace.id, appId, 'leads', {}).rows;
    expect(rows).toHaveLength(1);
    expect((rows[0]!.data as { name: string }).name).toBe('FromWorkflow');
  });
});
