/**
 * /v1/apps package routes: `.agentisapp` preview + install.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AppManifestEnvelope } from '@agentis/core';
import { buildAppRoutes } from '../../src/routes/apps.js';
import { AppDatastore, AppPackager, AppStore, AppSurfaceStore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/apps', app: buildAppRoutes({ db: ctx.db, auth: ctx.auth }) }]);
}

function seedApp(): string {
  const store = new AppStore(ctx.db);
  const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Ops Desk' }).id;
  store.update(ctx.workspace.id, appId, { version: '1.4.0' });
  new AppDatastore(ctx.db).defineCollection(ctx.workspace.id, appId, {
    name: 'tickets',
    schema: { fields: [{ key: 'subject', type: 'string', required: true }] },
  });
  new AppSurfaceStore({ db: ctx.db }).render(ctx.workspace.id, appId, 'home', {
    type: 'Stack',
    children: [{ type: 'Heading', value: 'Tickets' }],
  });
  ctx.db
    .insert(schema.workflows)
    .values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      appId,
      title: 'Route ticket',
      graph: { version: 1, nodes: [], edges: [] },
    })
    .run();
  return appId;
}

function appCount(): number {
  return ctx.db.select({ id: schema.apps.id }).from(schema.apps).all().length;
}

describe('/v1/apps package install', () => {
  it('creates an App and its entry workflow in one transaction', async () => {
    const response = await app().request('/v1/apps', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'Store outreach', createEntryWorkflow: true }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { id: string; name: string } };
    expect(body.data.name).toBe('Store outreach');
    const workflows = ctx.db
      .select({ title: schema.workflows.title, appId: schema.workflows.appId })
      .from(schema.workflows)
      .where(eq(schema.workflows.appId, body.data.id))
      .all();
    expect(workflows).toEqual([{ title: 'Store outreach workflow', appId: body.data.id }]);
  });

  it('promotes a bare workflow to one stable App-of-one', async () => {
    const workflowId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      title: 'Legacy outreach',
      graph: { version: 1, nodes: [], edges: [] },
    }).run();

    const promoted = await app().request(`/v1/apps/from-workflow/${workflowId}`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(promoted.status).toBe(201);
    const first = (await promoted.json()) as { data: { id: string; name: string } };
    expect(first.data.name).toBe('Legacy outreach');

    const repeated = await app().request(`/v1/apps/from-workflow/${workflowId}`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(repeated.status).toBe(200);
    const second = (await repeated.json()) as { data: { id: string } };
    expect(second.data.id).toBe(first.data.id);
    expect(ctx.db.select({ appId: schema.workflows.appId }).from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get()?.appId).toBe(first.data.id);
  });

  it('previews without mutating, then installs a fresh app', async () => {
    const sourceId = seedApp();
    const before = appCount();

    const exported = await app().request(`/v1/apps/${sourceId}/export`, { headers: ctx.authHeaders });
    expect(exported.status).toBe(200);
    const { data: envelope } = (await exported.json()) as { data: unknown };

    const preview = await app().request('/v1/apps/import/preview', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(envelope),
    });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      data: {
        identity: { name: string; version: string };
        counts: { workflows: number; surfaces: number; collections: number };
        permissions: string[];
      };
    };
    expect(previewBody.data.identity).toMatchObject({ name: 'Ops Desk', version: '1.4.0' });
    expect(previewBody.data.counts).toMatchObject({ workflows: 1, surfaces: 1, collections: 1 });
    expect(previewBody.data.permissions).toContain('data:tickets');
    expect(appCount()).toBe(before);

    const installed = await app().request('/v1/apps/import', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ envelope, permissionsAcknowledged: previewBody.data.permissions }),
    });
    expect(installed.status).toBe(201);
    const installedBody = (await installed.json()) as { data: { appId: string } };
    expect(installedBody.data.appId).not.toBe(sourceId);
    expect(appCount()).toBe(before + 1);
    expect(new AppSurfaceStore({ db: ctx.db }).list(ctx.workspace.id, installedBody.data.appId).map((s) => s.name)).toEqual(['home']);
    expect(ctx.db.select().from(schema.workflows).where(eq(schema.workflows.appId, installedBody.data.appId)).all()).toHaveLength(1);
  });

  it('requires permission acknowledgement before installing', async () => {
    const sourceId = seedApp();
    const before = appCount();
    const exported = await app().request(`/v1/apps/${sourceId}/export`, { headers: ctx.authHeaders });
    const { data: envelope } = (await exported.json()) as { data: unknown };

    const installed = await app().request('/v1/apps/import', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ envelope, permissionsAcknowledged: [] }),
    });
    expect(installed.status).toBe(403);
    const body = (await installed.json()) as { error: { code: string } };
    expect(body.error.code).toBe('APP_PERMISSIONS_NOT_ACKNOWLEDGED');
    expect(appCount()).toBe(before);
  });

  it('runs an App package test in an isolated transaction', async () => {
    const sourceId = seedApp();
    const before = appCount();
    const manifest = new AppPackager(ctx.db).toManifest(ctx.workspace.id, sourceId);
    manifest.surfaces[0]!.actions = [{ name: 'createTicket', kind: 'data', target: 'tickets.insert' }];
    const envelope = new AppPackager(ctx.db).serialize(manifest);

    const response = await app().request('/v1/apps/test', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        envelope,
        actions: [{ surface: 'home', name: 'createTicket', args: { record: { subject: 'Harness ticket' } } }],
        assertions: [{ collection: 'tickets', count: 1, includes: { subject: 'Harness ticket' } }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { assertions: Array<{ collection: string; count: number }> } };
    expect(body.data.assertions).toEqual([{ collection: 'tickets', count: 1 }]);
    expect(appCount()).toBe(before);
  });

  it('snapshots and promotes named App environments through the self-host API', async () => {
    const appId = seedApp();

    const snapshot = await app().request(`/v1/apps/${appId}/environments/development/snapshot`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ kind: 'dev' }),
    });
    expect(snapshot.status).toBe(200);

    const promotion = await app().request(`/v1/apps/${appId}/environments/development/promote`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ targetName: 'staging', targetKind: 'staging', applyToRuntime: false }),
    });
    expect(promotion.status).toBe(200);

    const listed = await app().request(`/v1/apps/${appId}/environments`, { headers: ctx.authHeaders });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: Array<{ name: string; kind: string; sourceEnvironmentId: string | null }> };
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'development', kind: 'dev' }),
      expect.objectContaining({ name: 'staging', kind: 'staging', sourceEnvironmentId: expect.any(String) }),
    ]));
  });

  it('blocks app packages with scanner-blocked secrets', async () => {
    const sourceId = seedApp();
    const before = appCount();
    const exported = await app().request(`/v1/apps/${sourceId}/export`, { headers: ctx.authHeaders });
    const { data: envelope } = (await exported.json()) as { data: AppManifestEnvelope };
    const nextEnvelope = new AppPackager(ctx.db).serialize({
      ...envelope.manifest,
      workflows: [
        {
          title: 'Route ticket',
          description: 'debug sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          graph: { version: 1, nodes: [], edges: [] },
        },
      ],
    });

    const preview = await app().request('/v1/apps/import/preview', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(nextEnvelope),
    });
    expect(preview.status).toBe(422);
    const body = (await preview.json()) as { error: { code: string } };
    expect(body.error.code).toBe('APP_PACKAGE_SCAN_BLOCKED');
    expect(appCount()).toBe(before);
  });

  it('does not let a surface action run a workflow owned by another app', async () => {
    const store = new AppStore(ctx.db);
    const appA = store.create(ctx.workspace.id, ctx.user.id, { name: 'Front Desk' }).id;
    const appB = store.create(ctx.workspace.id, ctx.user.id, { name: 'Private Ops' }).id;
    const workflowId = randomUUID();
    ctx.db
      .insert(schema.workflows)
      .values({
        id: workflowId,
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        appId: appB,
        title: 'Private workflow',
        graph: { version: 1, nodes: [], edges: [] },
      })
      .run();
    new AppSurfaceStore({ db: ctx.db }).upsert(ctx.workspace.id, appA, {
      name: 'home',
      view: { type: 'Stack', children: [{ type: 'Button', label: 'Run', action: { action: 'runPrivate' } }] },
      actions: [{ name: 'runPrivate', kind: 'workflow', target: workflowId }],
    });

    const response = await app().request(`/v1/apps/${appA}/surfaces/home/actions/runPrivate`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ args: {} }),
    });
    expect(response.status).toBe(404);
  });

  it('deletes an existing surface and rejects a missing surface', async () => {
    const appId = seedApp();
    const first = await app().request(`/v1/apps/${appId}/surfaces/home`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(first.status).toBe(200);
    expect(new AppSurfaceStore({ db: ctx.db }).list(ctx.workspace.id, appId)).toEqual([]);

    const missing = await app().request(`/v1/apps/${appId}/surfaces/home`, {
      method: 'DELETE',
      headers: ctx.authHeaders,
    });
    expect(missing.status).toBe(404);
  });

  it('public share query reads bound collections but rejects sibling ones', async () => {
    const store = new AppStore(ctx.db);
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Public Desk' }).id;
    const ds = new AppDatastore(ctx.db);
    ds.defineCollection(ctx.workspace.id, appId, { name: 'tickets', schema: { fields: [{ key: 'subject', type: 'string', required: true }] } });
    ds.defineCollection(ctx.workspace.id, appId, { name: 'secrets', schema: { fields: [{ key: 'value', type: 'string', required: true }] } });
    ds.insert(ctx.workspace.id, appId, 'secrets', { value: 'api-key-do-not-leak' });
    // The shared surface binds ONLY `tickets` — `secrets` is a sibling it never displays.
    new AppSurfaceStore({ db: ctx.db }).upsert(ctx.workspace.id, appId, {
      name: 'home',
      view: { type: 'Stack', children: [{ type: 'Table', bind: { collection: 'tickets' }, columns: [{ key: 'subject' }] }] },
      actions: [],
    });

    const a = app();
    // Operator shares the surface → gets a public token.
    const shared = await a.request(`/v1/apps/${appId}/surfaces/home/share`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(shared.status).toBe(200);
    const { data: { token } } = (await shared.json()) as { data: { token: string } };
    const path = `/v1/apps/public/surfaces/${encodeURIComponent(token)}/query`;

    // The bound collection is readable by the anonymous share link.
    const ok = await a.request(path, { method: 'POST', body: JSON.stringify({ collection: 'tickets' }) });
    expect(ok.status).toBe(200);

    // The sibling collection must be refused — no anonymous enumeration.
    const leak = await a.request(path, { method: 'POST', body: JSON.stringify({ collection: 'secrets' }) });
    expect(leak.status).toBe(404);
    const leakBody = (await leak.json()) as { error: { code: string } };
    expect(leakBody.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('gates an imported bundle that executes code behind explicit acknowledgement', async () => {
    const store = new AppStore(ctx.db);
    const appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'Coder' }).id;
    store.update(ctx.workspace.id, appId, { version: '1.0.0' });
    ctx.db.insert(schema.workflows).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      appId,
      title: 'Runs code',
      graph: {
        version: 1,
        nodes: [{ id: 'C', type: 'code', title: 'c', position: { x: 0, y: 0 }, config: { kind: 'code', language: 'python', code: 'print(1)', inputKeys: [] } }],
        edges: [],
      },
    }).run();

    const exported = await app().request(`/v1/apps/${appId}/export`, { headers: ctx.authHeaders });
    const { data: envelope } = (await exported.json()) as { data: unknown };
    const preview = await app().request('/v1/apps/import/preview', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify(envelope) });
    const previewBody = (await preview.json()) as { data: { permissions: string[] } };
    // The python code node is surfaced as a permission the installer must ack.
    expect(previewBody.data.permissions).toContain('executes-code:python');

    // Acknowledging everything EXCEPT the code permission is rejected.
    const partial = previewBody.data.permissions.filter((p) => p !== 'executes-code:python');
    const denied = await app().request('/v1/apps/import', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ envelope, permissionsAcknowledged: partial }) });
    expect(denied.status).toBe(403);

    // Full acknowledgement installs.
    const ok = await app().request('/v1/apps/import', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ envelope, permissionsAcknowledged: previewBody.data.permissions }) });
    expect(ok.status).toBe(201);
  });

  it('rejects tampered previews before creating an app', async () => {
    const sourceId = seedApp();
    const before = appCount();
    const exported = await app().request(`/v1/apps/${sourceId}/export`, { headers: ctx.authHeaders });
    const { data: envelope } = (await exported.json()) as { data: { manifest: { identity: { name: string } } } };
    envelope.manifest.identity.name = 'Tampered';

    const preview = await app().request('/v1/apps/import/preview', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(envelope),
    });
    expect(preview.status).toBe(422);
    expect(appCount()).toBe(before);
  });

  it('previews and blocks a data-losing upgrade without a migration', async () => {
    const sourceId = seedApp();
    const exported = await app().request(`/v1/apps/${sourceId}/export`, { headers: ctx.authHeaders });
    const { data: envelope } = (await exported.json()) as {
      data: {
        manifest: {
          identity: { version: string };
          collections: Array<{ name: string; schema: { fields: Array<{ key: string; type: string; required: boolean; indexed?: boolean }> }; seed: unknown[] }>;
        };
      };
    };
    envelope.manifest.identity.version = '2.0.0';
    envelope.manifest.collections = [{ name: 'tickets', schema: { fields: [{ key: 'summary', type: 'string', required: true, indexed: false }] }, seed: [] }];
    const nextEnvelope = new AppPackager(ctx.db).serialize(envelope.manifest as Parameters<AppPackager['serialize']>[0]);

    const preview = await app().request(`/v1/apps/${sourceId}/upgrade/preview`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(nextEnvelope),
    });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { data: { safe: boolean; blockers: Array<{ code: string }> } };
    expect(previewBody.data.safe).toBe(false);
    expect(previewBody.data.blockers.map((blocker) => blocker.code)).toContain('field_removed');

    const upgrade = await app().request(`/v1/apps/${sourceId}/upgrade`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify(nextEnvelope),
    });
    expect(upgrade.status).toBe(422);
  });
});
