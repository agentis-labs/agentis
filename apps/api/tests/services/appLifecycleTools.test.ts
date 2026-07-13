/**
 * agentis.app.archive / agentis.app.delete — lifecycle symmetry (Agent-Native §F7 / RC2).
 * The original field failure: an agent made 4 duplicate apps, identified them, and was
 * physically unable to clean up (no delete/archive TOOL). These tools close that gap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore } from '@agentis/app';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerAppDataTools } from '../../src/services/agentisToolHandlers/appData.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import type { AgentisToolContext } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function toolCtx(): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' };
}

function registry() {
  const r = new AgentisToolRegistry({ logger: ctx.logger });
  registerAppDataTools(r, { db: ctx.db, bus: ctx.bus } as ToolHandlerDeps);
  return r;
}

describe('app lifecycle tools', () => {
  it('archives (reversibly, hidden from default list) and restores', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Dup' }).id;
    const r = registry();

    const archived = await r.execute({ id: '', toolId: 'agentis.app.archive', arguments: { appId } }, toolCtx());
    expect((archived.output as { archived: boolean }).archived).toBe(true);

    // Default list hides it; includeArchived reveals it.
    const listed = await r.execute({ id: '', toolId: 'agentis.app.list', arguments: {} }, toolCtx());
    expect((listed.output as { apps: Array<{ appId: string }> }).apps.some((a) => a.appId === appId)).toBe(false);
    const listedAll = await r.execute({ id: '', toolId: 'agentis.app.list', arguments: { includeArchived: true } }, toolCtx());
    expect((listedAll.output as { apps: Array<{ appId: string }> }).apps.some((a) => a.appId === appId)).toBe(true);

    const restored = await r.execute({ id: '', toolId: 'agentis.app.archive', arguments: { appId, restore: true } }, toolCtx());
    // Current lifecycle is active|archived (legacy draft/published coerce to active
    // via normalizeAppStatus) — restore returns the app to `active`.
    expect((restored.output as { status: string }).status).toBe('active');
  });

  it('updates identity: rename + icon (agentis.app.update)', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Old Name' }).id;
    const r = registry();
    const res = await r.execute({ id: '', toolId: 'agentis.app.update', arguments: { appId, name: 'New Name', icon: '🚀' } }, toolCtx());
    expect(res.ok).toBe(true);
    const app = new AppStore(ctx.db).get(ctx.workspace.id, appId);
    expect(app.name).toBe('New Name');
    expect(app.icon).toBe('🚀');
  });

  it('app.update requires at least one field', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Nn' }).id;
    const res = await registry().execute({ id: '', toolId: 'agentis.app.update', arguments: { appId } }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/at least one field/i);
  });

  it('previews before deleting, then deletes on confirm', async () => {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Erase Me' }).id;
    const r = registry();

    // No confirm → preview, nothing removed.
    const preview = await r.execute({ id: '', toolId: 'agentis.app.delete', arguments: { appId } }, toolCtx());
    expect(preview.output).toMatchObject({ deleted: false, preview: true });
    expect((preview.output as { next: string }).next).toMatch(/confirm: true/);
    expect(new AppStore(ctx.db).get(ctx.workspace.id, appId).id).toBe(appId); // still there

    // Confirm → gone.
    const del = await r.execute({ id: '', toolId: 'agentis.app.delete', arguments: { appId, confirm: true } }, toolCtx());
    expect((del.output as { deleted: boolean }).deleted).toBe(true);
    const stillListed = await r.execute({ id: '', toolId: 'agentis.app.list', arguments: { includeArchived: true } }, toolCtx());
    expect((stillListed.output as { apps: Array<{ appId: string }> }).apps.some((a) => a.appId === appId)).toBe(false);
  });
});
