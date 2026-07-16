import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ViewportContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { appCompletionGuard } from '../../src/routes/conversations.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function blockedApp(): { appId: string; viewport: ViewportContext } {
  const appId = randomUUID();
  ctx.db.insert(schema.apps).values({
    id: appId,
    workspaceId: ctx.workspace.id,
    slug: `guard-${appId.slice(0, 8)}`,
    name: 'Guard fixture',
    description: '',
    version: '0.1.0',
    status: 'draft',
    manifest: { manifestVersion: 1, slug: `guard-${appId.slice(0, 8)}`, name: 'Guard fixture', version: '0.1.0', capabilities: [], requiredPlugins: [] },
    policy: { audience: [], shareable: false, customCode: 'disabled', grants: [] },
    createdBy: ctx.user.id,
  }).run();
  ctx.db.insert(schema.workflows).values({
    id: randomUUID(),
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    appId,
    title: 'Broken workflow',
    graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    settings: {},
  }).run();
  return { appId, viewport: { surface: 'app', resourceKind: 'app', resourceId: appId } };
}

describe('App completion truth guard', () => {
  it('corrects a completion claim when the live App still has blockers', () => {
    const { viewport } = blockedApp();
    const correction = appCompletionGuard(ctx.db, ctx.workspace.id, viewport, 'Done. The app is ready for a live run.');
    expect(correction).toContain('cannot truthfully mark this App ready');
    expect(correction).toContain('ACTIVATION_NO_TRIGGER_NODE');
  });

  it('does not rewrite an honest blocked hand-off', () => {
    const { viewport } = blockedApp();
    expect(appCompletionGuard(ctx.db, ctx.workspace.id, viewport, 'The app is not ready; blockers remain.')).toBeNull();
  });
});
