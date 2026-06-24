import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore, AppSurfaceStore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let apps: AppStore;
let surfaces: AppSurfaceStore;

beforeEach(async () => {
  ctx = await createTestContext();
  apps = new AppStore(ctx.db);
  surfaces = new AppSurfaceStore({ db: ctx.db });
});

afterEach(() => {
  ctx.close();
});

describe('AppSurfaceStore', () => {
  it('blocks CustomView persistence unless the app policy allows custom code', () => {
    const app = apps.create(ctx.workspace.id, ctx.user.id, { name: 'Custom View App' });
    const customView = { type: 'CustomView', html: '<div>hello</div>' };

    expect(() => surfaces.render(ctx.workspace.id, app.id, 'home', customView)).toThrowError(/customCode/);

    apps.update(ctx.workspace.id, app.id, { policy: { customCode: 'allowed' } });
    const surface = surfaces.render(ctx.workspace.id, app.id, 'home', customView);

    expect(surface.view).toEqual(customView);
  });
});
