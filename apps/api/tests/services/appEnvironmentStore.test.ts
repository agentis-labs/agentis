import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppEnvironmentStore, AppPackager, AppStore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let appId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Release Desk' }).id;
});

afterEach(() => ctx.close());

describe('AppEnvironmentStore', () => {
  it('promotes a manifest snapshot through staging and into the lifecycle-managed runtime', () => {
    const environments = new AppEnvironmentStore(ctx.db);
    const dev = environments.snapshotRuntime(ctx.workspace.id, ctx.user.id, appId, 'dev', 'dev');
    expect(dev.manifest.identity.version).toBe('0.1.0');

    const candidate = new AppPackager(ctx.db).toManifest(ctx.workspace.id, appId);
    candidate.identity.version = '1.0.0';
    candidate.source = { kind: 'local', id: 'repo:release-desk', author: { name: 'Operator' } };
    environments.upsert(ctx.workspace.id, ctx.user.id, appId, 'dev', { kind: 'dev', manifest: candidate });

    const staged = environments.promote(ctx.workspace.id, ctx.user.id, appId, 'dev', {
      targetName: 'staging',
      targetKind: 'staging',
      applyToRuntime: false,
    });
    expect(staged.environment.manifest.identity.version).toBe('1.0.0');
    expect(staged.runtimeUpgrade).toBeUndefined();

    const released = environments.promote(ctx.workspace.id, ctx.user.id, appId, 'staging', {
      targetName: 'production',
      targetKind: 'production',
      applyToRuntime: true,
    });
    expect(released.runtimeUpgrade?.plan.safe).toBe(true);
    const installed = new AppStore(ctx.db).get(ctx.workspace.id, appId);
    expect(installed.version).toBe('1.0.0');
    expect(installed.source).toEqual(candidate.source);
    expect(environments.list(ctx.workspace.id, appId).map((environment) => environment.name)).toEqual(['dev', 'production', 'staging']);
  });

  it('does not permit non-production snapshots to replace the live runtime', () => {
    const environments = new AppEnvironmentStore(ctx.db);
    environments.snapshotRuntime(ctx.workspace.id, ctx.user.id, appId, 'dev', 'dev');
    expect(() =>
      environments.promote(ctx.workspace.id, ctx.user.id, appId, 'dev', {
        targetName: 'staging',
        targetKind: 'staging',
        applyToRuntime: true,
      }),
    ).toThrowError(/production environment/);
  });
});
