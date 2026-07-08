import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore, AppSurfaceStore } from '@agentis/app';
import type { SurfaceRegionPush, ViewNode } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let apps: AppStore;
let surfaces: AppSurfaceStore;
const emit = vi.fn();

beforeEach(async () => {
  ctx = await createTestContext();
  apps = new AppStore(ctx.db);
  emit.mockReset();
  surfaces = new AppSurfaceStore({ db: ctx.db, emit });
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

    // render() runs the layout floor (repairSurface), which always sets a root theme.
    expect(surface.view).toMatchObject(customView);
  });
});

describe('AppSurfaceStore.performRegion (Phase M3 — performed surfaces)', () => {
  const frame: ViewNode = {
    type: 'Stack',
    children: [
      { type: 'Heading', value: 'Desk' },
      { type: 'AgentRegion', region: 'attention', title: 'Agent attention' },
    ],
  };
  const panel: ViewNode = { type: 'Callout', title: 'Churn risk', value: '12 deals stalled at pricing' };

  function setup() {
    const app = apps.create(ctx.workspace.id, ctx.user.id, { name: 'Resident Desk' });
    surfaces.render(ctx.workspace.id, app.id, 'home', frame);
    emit.mockReset();
    return app;
  }

  it('performs a transient region: broadcasts an explainable push, does NOT persist the child', () => {
    const app = setup();
    surfaces.performRegion(ctx.workspace.id, app.id, 'home', { region: 'attention', view: panel, reason: '12 deals stalled at pricing' });

    const push = emit.mock.calls.at(-1)![0].payload as SurfaceRegionPush;
    expect(emit.mock.calls.at(-1)![0].event).toBe('render');
    expect(push.region).toBe('attention');
    expect(push.reason).toBe('12 deals stalled at pricing');
    expect(push.pinned).toBe(false);
    expect(push.view).toMatchObject({ type: 'Callout', value: '12 deals stalled at pricing' });

    // Un-pinned ⇒ the stored slot stays empty (the frame never drifts).
    const stored = surfaces.get(ctx.workspace.id, app.id, 'home').view as { children: ViewNode[] };
    const slot = stored.children.find((c) => c.type === 'AgentRegion') as Extract<ViewNode, { type: 'AgentRegion' }>;
    expect(slot.child).toBeUndefined();
  });

  it('pinning freezes the performed child into the stored surface', () => {
    const app = setup();
    surfaces.performRegion(ctx.workspace.id, app.id, 'home', { region: 'attention', view: panel, reason: 'pricing stall', pin: true });

    const stored = surfaces.get(ctx.workspace.id, app.id, 'home').view as { children: ViewNode[] };
    const slot = stored.children.find((c) => c.type === 'AgentRegion') as Extract<ViewNode, { type: 'AgentRegion' }>;
    expect(slot.pinned).toBe(true);
    expect(slot.child).toMatchObject({ type: 'Callout', value: '12 deals stalled at pricing' });
  });

  it('clearing dismisses the region and empties the stored slot', () => {
    const app = setup();
    surfaces.performRegion(ctx.workspace.id, app.id, 'home', { region: 'attention', view: panel, pin: true });
    surfaces.performRegion(ctx.workspace.id, app.id, 'home', { region: 'attention', clear: true });

    const push = emit.mock.calls.at(-1)![0].payload as SurfaceRegionPush;
    expect(push.view).toBeNull();
    const stored = surfaces.get(ctx.workspace.id, app.id, 'home').view as { children: ViewNode[] };
    const slot = stored.children.find((c) => c.type === 'AgentRegion') as Extract<ViewNode, { type: 'AgentRegion' }>;
    expect(slot.child).toBeUndefined();
    expect(slot.pinned).toBe(false);
  });

  it('rejects performing into a region the frame does not declare', () => {
    const app = setup();
    expect(() => surfaces.performRegion(ctx.workspace.id, app.id, 'home', { region: 'ghost', view: panel })).toThrowError(/AgentRegion/);
  });
});
