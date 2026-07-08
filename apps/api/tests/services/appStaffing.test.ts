/**
 * AppStaffingService — birth-staff-at-creation (LIVING-APPS-10X Phase R).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { AppStaffingService, classifyAppArchetype, deriveCast } from '../../src/services/app/appStaffing.js';
import { SpecialistAgentService } from '../../src/services/specialist/specialistAgents.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function staffing() {
  const store = new AppStore(ctx.db);
  const specialists = new SpecialistAgentService(ctx.db);
  return { store, service: new AppStaffingService({ store, specialists }) };
}

describe('classifyAppArchetype', () => {
  it('reads intent from name + description', () => {
    expect(classifyAppArchetype('Acme Sales Desk', 'qualify and close leads')).toBe('sales');
    expect(classifyAppArchetype('Help Center', 'resolve customer tickets')).toBe('support');
    expect(classifyAppArchetype('Revenue Dashboard', 'kpis and reports')).toBe('analytics');
    expect(classifyAppArchetype('Competitor Watch', 'monitor the news feed')).toBe('research');
    expect(classifyAppArchetype('Nightly Sync', 'export rows to a sheet')).toBe('automation');
  });
});

describe('deriveCast', () => {
  it('gives a relationship App a real team with exactly one operator', () => {
    const cast = deriveCast('sales');
    expect(cast.length).toBeGreaterThan(1);
    expect(cast.filter((r) => r.operator)).toHaveLength(1);
    expect(cast.every((r) => r.instructions.length > 0)).toBe(true);
  });
  it('gives a bare automation a single operator', () => {
    const cast = deriveCast('automation');
    expect(cast).toHaveLength(1);
    expect(cast[0]?.operator).toBe(true);
  });
});

describe('AppStaffingService.staffApp', () => {
  it('births a cast: owner set, members seated, specialists materialized with competence', async () => {
    const { store, service } = staffing();
    const app = store.create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales', description: 'close leads' });

    const result = await service.staffApp({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      appId: app.id,
      name: app.name,
      description: app.description ?? '',
    });

    expect(result.archetype).toBe('sales');
    expect(result.ownerAgentId).toBeTruthy();
    expect(result.members.length).toBeGreaterThan(1);
    expect(result.members.filter((m) => m.memberRole === 'operator')).toHaveLength(1);

    // Owner persisted on the App.
    expect(store.get(ctx.workspace.id, app.id).ownerAgentId).toBe(result.ownerAgentId);

    // Members seated.
    const members = store.listMembers(ctx.workspace.id, app.id);
    expect(members).toHaveLength(result.members.length);

    // Specialists materialized as real agents, born with operating instructions.
    const owner = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, result.ownerAgentId!)).get();
    expect(owner?.role).toBe('sales_concierge');
    expect((owner?.instructions ?? '').length).toBeGreaterThan(0);
  });

  it('is idempotent — re-staffing an App with members is a no-op', async () => {
    const { store, service } = staffing();
    const app = store.create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales', description: 'close leads' });

    await service.staffApp({ workspaceId: ctx.workspace.id, userId: ctx.user.id, appId: app.id, name: app.name, description: 'close leads' });
    const first = store.listMembers(ctx.workspace.id, app.id);

    const again = await service.staffApp({ workspaceId: ctx.workspace.id, userId: ctx.user.id, appId: app.id, name: app.name, description: 'close leads' });
    expect(again.skipped).toBe('already_staffed');
    expect(store.listMembers(ctx.workspace.id, app.id)).toHaveLength(first.length);
  });

  it('reuses an existing workspace specialist instead of cloning it', async () => {
    const { store, service } = staffing();
    const specialists = new SpecialistAgentService(ctx.db);
    // Pre-seed the concierge role; staffing should reuse this exact agent.
    const existing = await specialists.authorSpecialist(ctx.workspace.id, ctx.user.id, { role: 'sales_concierge', name: 'Concierge' });

    const app = store.create(ctx.workspace.id, ctx.user.id, { name: 'Second Sales App', description: 'sell more' });
    const result = await service.staffApp({ workspaceId: ctx.workspace.id, userId: ctx.user.id, appId: app.id, name: app.name, description: 'sell more' });

    const concierge = result.members.find((m) => m.functionalRole === 'sales_concierge');
    expect(concierge?.agentId).toBe(existing.agentId);
    expect(concierge?.created).toBe(false);
  });

  it('always assigns an owner for a bare automation App', async () => {
    const { store, service } = staffing();
    const app = store.create(ctx.workspace.id, ctx.user.id, { name: 'Nightly Export', description: 'sync rows to a sheet' });
    const result = await service.staffApp({ workspaceId: ctx.workspace.id, userId: ctx.user.id, appId: app.id, name: app.name, description: 'sync rows to a sheet' });

    expect(result.archetype).toBe('automation');
    expect(result.members).toHaveLength(1);
    expect(result.ownerAgentId).toBe(result.members[0]?.agentId);
  });
});
