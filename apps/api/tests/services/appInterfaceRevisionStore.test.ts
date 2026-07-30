import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppInterfaceRevisionStore, AppStore, AppSurfaceStore } from '@agentis/app';
import type { ViewNode } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let apps: AppStore;
let surfaces: AppSurfaceStore;
let revisions: AppInterfaceRevisionStore;

beforeEach(async () => {
  ctx = await createTestContext();
  apps = new AppStore(ctx.db);
  surfaces = new AppSurfaceStore({ db: ctx.db });
  revisions = new AppInterfaceRevisionStore({ db: ctx.db, emit: vi.fn() });
});

afterEach(() => ctx.close());

describe('AppInterfaceRevisionStore', () => {
  function setup() {
    const app = apps.create(ctx.workspace.id, ctx.user.id, { name: 'Revisioned Desk' });
    surfaces.render(ctx.workspace.id, app.id, 'home', {
      type: 'Stack',
      style: { theme: 'operations' },
      children: [{ type: 'Heading', value: 'Original' }],
    });
    return app;
  }

  it('keeps an invalid candidate isolated from the live projection', () => {
    const app = setup();
    const active = revisions.ensureActive(ctx.workspace.id, app.id);
    const candidate = revisions.createCandidate(ctx.workspace.id, app.id, [{
      ...active.pages[0]!,
      actions: [{ name: 'missing-page', kind: 'navigate', target: 'does-not-exist' }],
    }], { baseRevisionId: active.id, reason: 'Broken navigation' });

    const result = revisions.verify(ctx.workspace.id, app.id, candidate.id);

    expect(result.passed).toBe(false);
    expect(result.proofs.find((proof) => proof.gate === 'navigation')?.status).toBe('failed');
    expect((surfaces.get(ctx.workspace.id, app.id, 'home').view as { children: Array<{ value?: string }> }).children[0]?.value).toBe('Original');
  });

  it('publishes all candidate pages atomically and can restore a prior revision', () => {
    const app = setup();
    const active = revisions.ensureActive(ctx.workspace.id, app.id);
    const nextView = structuredClone(active.pages[0]!.view) as ViewNode & { children: Array<{ value?: string }> };
    nextView.children[0]!.value = 'Improved';
    const candidate = revisions.createCandidate(ctx.workspace.id, app.id, [
      { ...active.pages[0]!, view: nextView },
      {
        id: '',
        name: 'details',
        kind: 'page',
        view: { type: 'Stack', style: { theme: 'operations' }, children: [{ type: 'Heading', value: 'Details' }] },
        actions: [],
        shareable: false,
      },
    ], { baseRevisionId: active.id, reason: 'Add details page' });

    expect(revisions.verify(ctx.workspace.id, app.id, candidate.id).passed).toBe(true);
    const published = revisions.publish(ctx.workspace.id, app.id, candidate.id);

    expect(published.status).toBe('active');
    expect(surfaces.list(ctx.workspace.id, app.id).map((surface) => surface.name)).toEqual(['details', 'home']);
    expect((surfaces.get(ctx.workspace.id, app.id, 'home').view as { children: Array<{ value?: string }> }).children[0]?.value).toBe('Improved');

    revisions.restore(ctx.workspace.id, app.id, active.id, ctx.user.id);
    expect(surfaces.list(ctx.workspace.id, app.id).map((surface) => surface.name)).toEqual(['home']);
    expect((surfaces.get(ctx.workspace.id, app.id, 'home').view as { children: Array<{ value?: string }> }).children[0]?.value).toBe('Original');
  });

  it('deduplicates identical snapshots', () => {
    const app = setup();
    const first = revisions.ensureActive(ctx.workspace.id, app.id);
    const second = revisions.capturePublished(ctx.workspace.id, app.id);
    expect(second.id).toBe(first.id);
    expect(revisions.list(ctx.workspace.id, app.id)).toHaveLength(1);
  });
});
