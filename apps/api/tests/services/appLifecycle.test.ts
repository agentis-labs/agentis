import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatastore, AppLifecycle, AppPackager, AppStore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let appId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  const apps = new AppStore(ctx.db);
  appId = apps.create(ctx.workspace.id, ctx.user.id, { name: 'Lifecycle Desk' }).id;
  apps.update(ctx.workspace.id, appId, { version: '1.0.0' });
  const data = new AppDatastore(ctx.db);
  data.defineCollection(ctx.workspace.id, appId, {
    name: 'tickets',
    schema: { fields: [{ key: 'subject', type: 'string', required: true }] },
  });
  data.insert(ctx.workspace.id, appId, 'tickets', { subject: 'Printer down' }, ctx.user.id);
});

afterEach(() => ctx.close());

describe('AppLifecycle', () => {
  it('upgrades with a collection migration and rolls back manifest plus data', () => {
    const packager = new AppPackager(ctx.db);
    const lifecycle = new AppLifecycle(ctx.db);
    const next = packager.toManifest(ctx.workspace.id, appId);
    next.identity.version = '2.0.0';
    next.collections = [
      {
        name: 'tickets',
        schema: {
          fields: [
            { key: 'subject', type: 'string', required: true, indexed: false },
            { key: 'status', type: 'string', required: true, indexed: false },
          ],
        },
        seed: [],
      },
    ];
    next.migrations = [
      { id: 'tickets-status-v2', collection: 'tickets', op: 'add_field', spec: { field: 'status', default: 'open' } },
    ];

    const plan = lifecycle.planUpgrade(ctx.workspace.id, appId, next);
    expect(plan.safe).toBe(true);
    expect(plan.requiresMigration).toBe(true);

    const upgraded = lifecycle.upgrade(ctx.workspace.id, ctx.user.id, appId, next);
    expect(upgraded.snapshotId).toBeTruthy();
    expect(new AppStore(ctx.db).get(ctx.workspace.id, appId).version).toBe('2.0.0');
    let rows = new AppDatastore(ctx.db).query(ctx.workspace.id, appId, 'tickets', { limit: 10 }).rows;
    expect(rows[0]?.data).toMatchObject({ subject: 'Printer down', status: 'open' });

    const rolledBack = lifecycle.rollback(ctx.workspace.id, ctx.user.id, appId, upgraded.snapshotId);
    expect(rolledBack.restoredVersion).toBe('1.0.0');
    expect(new AppStore(ctx.db).get(ctx.workspace.id, appId).version).toBe('1.0.0');
    rows = new AppDatastore(ctx.db).query(ctx.workspace.id, appId, 'tickets', { limit: 10 }).rows;
    expect(rows[0]?.data).toEqual({ subject: 'Printer down' });
  });

  it('blocks a data-losing schema upgrade without a migration', () => {
    const packager = new AppPackager(ctx.db);
    const lifecycle = new AppLifecycle(ctx.db);
    const next = packager.toManifest(ctx.workspace.id, appId);
    next.identity.version = '2.0.0';
    next.collections = [{ name: 'tickets', schema: { fields: [{ key: 'summary', type: 'string', required: true, indexed: false }] }, seed: [] }];

    const plan = lifecycle.planUpgrade(ctx.workspace.id, appId, next);
    expect(plan.safe).toBe(false);
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('field_removed');
    expect(() => lifecycle.upgrade(ctx.workspace.id, ctx.user.id, appId, next)).toThrowError(/upgrade blocked/);
  });

  it('restores provenance and original artifact checksum on rollback', () => {
    const apps = new AppStore(ctx.db);
    const originalSource = { kind: 'hub' as const, id: 'agentishub:lifecycle-desk', remoteId: 'listing_v1', author: { handle: 'maker' } };
    apps.update(ctx.workspace.id, appId, { source: originalSource, installedChecksum: 'checksum-v1' });

    const packager = new AppPackager(ctx.db);
    const lifecycle = new AppLifecycle(ctx.db);
    const next = packager.toManifest(ctx.workspace.id, appId);
    next.identity.version = '1.1.0';
    next.source = { kind: 'hub', id: 'agentishub:lifecycle-desk', remoteId: 'listing_v2', author: { handle: 'maker' } };

    const upgraded = lifecycle.upgrade(ctx.workspace.id, ctx.user.id, appId, next, { installedChecksum: 'checksum-v2' });
    expect(apps.get(ctx.workspace.id, appId)).toMatchObject({ source: next.source, installedChecksum: 'checksum-v2' });

    lifecycle.rollback(ctx.workspace.id, ctx.user.id, appId, upgraded.snapshotId);
    expect(apps.get(ctx.workspace.id, appId)).toMatchObject({ source: originalSource, installedChecksum: 'checksum-v1' });
  });
});
