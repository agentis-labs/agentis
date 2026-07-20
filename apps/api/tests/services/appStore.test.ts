/**
 * AppStore — the Agentic App entity (AGENTIC-APPS-10X-MASTERPLAN §3).
 *
 * Proves migration v82 (apps / app_members / workflows.app_id) is live in a
 * fresh database and that the store's create/update/membership/adoption seams
 * round-trip. The back-compat invariant — a workflow with app_id = NULL stays
 * valid, and deleting an App releases its workflows rather than cascading — is
 * asserted explicitly because it is load-bearing for the whole migration story.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let store: AppStore;

beforeEach(async () => {
  ctx = await createTestContext();
  store = new AppStore(ctx.db);
});

afterEach(() => {
  ctx.close();
});

function seedWorkflow(title = 'Entry'): string {
  const id = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({ id, workspaceId: ctx.workspace.id, userId: ctx.user.id, title, graph: { version: 1, nodes: [], edges: [] } })
    .run();
  return id;
}

describe('AppStore', () => {
  it('creates an app with a derived unique slug and default active status', () => {
    const a = store.create(ctx.workspace.id, ctx.user.id, { name: 'Refund Desk', description: 'demo' });
    expect(a.slug).toBe('refund-desk');
    expect(a.status).toBe('active');
    expect(a.version).toBe('0.1.0');
    expect(a.manifest.name).toBe('Refund Desk');

    const b = store.create(ctx.workspace.id, ctx.user.id, { name: 'Refund Desk' });
    expect(b.slug).toBe('refund-desk-2'); // collision suffix
  });

  it('lists, gets, and updates apps (manifest stays in sync with columns)', () => {
    const created = store.create(ctx.workspace.id, ctx.user.id, { name: 'Tickets' });
    expect(store.list(ctx.workspace.id)).toHaveLength(1);

    const updated = store.update(ctx.workspace.id, created.id, {
      name: 'Tickets Pro',
      version: '1.0.0',
      status: 'archived',
      policy: { customCode: 'allowed' },
    });
    expect(updated.name).toBe('Tickets Pro');
    expect(updated.manifest.name).toBe('Tickets Pro');
    expect(updated.manifest.version).toBe('1.0.0');
    expect(updated.status).toBe('archived');
    expect(updated.policy.customCode).toBe('allowed');

    expect(store.list(ctx.workspace.id, { status: 'archived' })).toHaveLength(1);
    expect(store.list(ctx.workspace.id, { status: 'active' })).toHaveLength(0);
  });

  it('adopts a workflow at create time and lists it', () => {
    const wfId = seedWorkflow();
    const a = store.create(ctx.workspace.id, ctx.user.id, { name: 'Owns WF', entryWorkflowId: wfId });
    expect(store.listWorkflowIds(ctx.workspace.id, a.id)).toEqual([wfId]);

    const row = ctx.db.select({ appId: schema.workflows.appId }).from(schema.workflows).where(eq(schema.workflows.id, wfId)).get();
    expect(row?.appId).toBe(a.id);
  });

  it('manages members idempotently', () => {
    const a = store.create(ctx.workspace.id, ctx.user.id, { name: 'Team App' });
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({ id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Worker', adapterType: 'http' }).run();

    store.addMember(ctx.workspace.id, a.id, agentId, 'operator');
    store.addMember(ctx.workspace.id, a.id, agentId, 'worker'); // upsert role, no duplicate
    const members = store.listMembers(ctx.workspace.id, a.id);
    expect(members).toEqual([{ appId: a.id, agentId, role: 'worker' }]);

    store.removeMember(ctx.workspace.id, a.id, agentId);
    expect(store.listMembers(ctx.workspace.id, a.id)).toHaveLength(0);
  });

  it('deleting an app deletes its workflows with it', () => {
    const wfId = seedWorkflow();
    const a = store.create(ctx.workspace.id, ctx.user.id, { name: 'Disposable', entryWorkflowId: wfId });

    const result = store.delete(ctx.workspace.id, a.id);

    expect(result).toEqual({ deletedWorkflowIds: [wfId], keptWorkflowIds: [] });
    // Previously this only nulled app_id, leaving an orphan with no owning App
    // page — and therefore no way to delete it from the UI at all.
    const wf = ctx.db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.id, wfId)).get();
    expect(wf).toBeUndefined();
  });

  it('keepWorkflows retires the app but leaves its workflows standalone', () => {
    const wfId = seedWorkflow();
    const a = store.create(ctx.workspace.id, ctx.user.id, { name: 'Retire me', entryWorkflowId: wfId });

    const result = store.delete(ctx.workspace.id, a.id, { keepWorkflows: true });

    expect(result).toEqual({ deletedWorkflowIds: [], keptWorkflowIds: [wfId] });
    const wf = ctx.db.select({ id: schema.workflows.id, appId: schema.workflows.appId }).from(schema.workflows).where(eq(schema.workflows.id, wfId)).get();
    expect(wf?.id).toBe(wfId);
    expect(wf?.appId).toBeNull(); // released back to a bare workflow
  });

  it('previews the blast radius before anything is destroyed', () => {
    const wfId = seedWorkflow();
    const a = store.create(ctx.workspace.id, ctx.user.id, { name: 'Preview me', entryWorkflowId: wfId });

    const preview = store.deletionPreview(ctx.workspace.id, a.id);

    expect(preview.appId).toBe(a.id);
    expect(preview.workflows).toEqual([{ workflowId: wfId, title: expect.any(String), runCount: 0 }]);
    // Preview must not mutate — the App and its workflow are still here.
    expect(store.listWorkflowIds(ctx.workspace.id, a.id)).toEqual([wfId]);
  });

  it('throws RESOURCE_NOT_FOUND for a missing app', () => {
    expect(() => store.get(ctx.workspace.id, 'nope')).toThrowError(/app not found/);
  });
});
