/**
 * AppContactService + ProactiveFollowupService — the relationship entity and the
 * proactive follow-up sweep (LIVING-APPS-10X Phase 3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { eq } from 'drizzle-orm';
import { AppContactService } from '../../src/services/app/appContacts.js';
import { ProactiveFollowupService } from '../../src/services/proactiveFollowups.js';
import { OutboundPolicyService } from '../../src/services/outboundPolicy.js';
import type { ChannelTurnInput } from '../../src/services/conversation/channelTurnDispatcher.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function seedAgent(): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({ id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Resident', adapterType: 'http' }).run();
  return id;
}

describe('AppContactService', () => {
  it('upserts a contact by app+channel+handle and refreshes lastTouch', () => {
    const svc = new AppContactService(ctx.db);
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' }).id;

    const first = svc.touch({ workspaceId: ctx.workspace.id, appId, channelKind: 'telegram', handle: '42', displayName: 'Maria' });
    const again = svc.touch({ workspaceId: ctx.workspace.id, appId, channelKind: 'telegram', handle: '42' });
    expect(again).toBe(first); // same contact, not a duplicate

    const contacts = svc.list(ctx.workspace.id, appId);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ displayName: 'Maria', stage: 'new', handle: '42' });
    expect(contacts[0]?.lastTouchAt).toBeTruthy();
  });

  it('tracks pipeline state + the proactivity clock', () => {
    const svc = new AppContactService(ctx.db);
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme' }).id;
    const id = svc.touch({ workspaceId: ctx.workspace.id, appId, channelKind: 'telegram', handle: '7' });

    const due = '2020-01-01T00:00:00.000Z'; // in the past → due
    svc.update(ctx.workspace.id, id, { stage: 'qualifying', goal: 'close Q3', nextTouchAt: due, data: { budget: 40000 } });

    const updated = svc.get(ctx.workspace.id, id);
    expect(updated).toMatchObject({ stage: 'qualifying', goal: 'close Q3', nextTouchAt: due });
    expect((updated?.dataJson as { budget?: number }).budget).toBe(40000);

    expect(svc.dueForFollowUp(new Date().toISOString()).map((c) => c.id)).toContain(id);
    svc.clearNextTouch(id);
    expect(svc.dueForFollowUp(new Date().toISOString())).toHaveLength(0);
  });
});

describe('ProactiveFollowupService.sweep', () => {
  function seedDueContactWithThread(opts: { handoff?: 'human' | null } = {}) {
    const svc = new AppContactService(ctx.db);
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' }).id;
    const agentId = seedAgent();
    const now = new Date().toISOString();
    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, appId, kind: 'telegram', name: 'line', tokenEncrypted: 'x',
    }).run();
    ctx.db.insert(schema.conversations).values({
      id: randomUUID(), workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, appId,
      channelConnectionId: connId, channelChatId: '42', handoffState: opts.handoff ?? null, createdAt: now, updatedAt: now,
    }).run();
    const contactId = svc.touch({ workspaceId: ctx.workspace.id, appId, channelKind: 'telegram', handle: '42', displayName: 'Maria' });
    svc.update(ctx.workspace.id, contactId, { goal: 'reserve the unit', nextTouchAt: '2020-01-01T00:00:00.000Z' });
    return { svc, appId, contactId };
  }

  it('dispatches a follow-up turn for a due contact and clears the clock', async () => {
    const { svc, contactId } = seedDueContactWithThread();
    const dispatched: ChannelTurnInput[] = [];
    const proactive = new ProactiveFollowupService({
      db: ctx.db, contacts: svc, logger: ctx.logger,
      dispatcher: { dispatch: async (input) => { dispatched.push(input); return { replied: true }; } },
    });

    const result = await proactive.sweep();
    expect(result.fired).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.appId).toBeTruthy();
    expect(dispatched[0]?.text).toMatch(/follow up with Maria/i);
    expect(dispatched[0]?.text).toMatch(/reserve the unit/);
    // Clock cleared so it does not fire again.
    expect(svc.dueForFollowUp(new Date().toISOString())).toHaveLength(0);
    expect(svc.get(ctx.workspace.id, contactId)?.nextTouchAt).toBeNull();
  });

  it('feeds the subject stage + learned facts into the follow-up (informed, not canned)', async () => {
    const { svc, contactId } = seedDueContactWithThread();
    svc.update(ctx.workspace.id, contactId, { stage: 'qualified', data: { budget: '40k', timeline: 'Q3' } });
    svc.update(ctx.workspace.id, contactId, { nextTouchAt: '2020-01-01T00:00:00.000Z' }); // re-arm the cleared clock
    const dispatched: ChannelTurnInput[] = [];
    const proactive = new ProactiveFollowupService({
      db: ctx.db, contacts: svc, logger: ctx.logger,
      dispatcher: { dispatch: async (input) => { dispatched.push(input); return { replied: true }; } },
    });

    await proactive.sweep();
    expect(dispatched).toHaveLength(1);
    const text = dispatched[0]?.text ?? '';
    expect(text).toMatch(/stage: qualified/i);
    expect(text).toMatch(/budget: 40k/);
    expect(text).toMatch(/timeline: Q3/);
  });

  it('does not barge into a thread a human has taken over', async () => {
    const { svc } = seedDueContactWithThread({ handoff: 'human' });
    const dispatched: ChannelTurnInput[] = [];
    const proactive = new ProactiveFollowupService({
      db: ctx.db, contacts: svc, logger: ctx.logger,
      dispatcher: { dispatch: async (input) => { dispatched.push(input); return { replied: true }; } },
    });

    const result = await proactive.sweep();
    expect(result.fired).toBe(0);
    expect(dispatched).toHaveLength(0);
    // Clock still cleared (we don't retry a parked thread on the next sweep).
    expect(svc.dueForFollowUp(new Date().toISOString())).toHaveLength(0);
  });

  function setOutboundPolicy(appId: string, outbound: Record<string, unknown>): void {
    ctx.db
      .update(schema.apps)
      .set({ policyJson: { audience: [], shareable: false, customCode: 'disabled', grants: [], outbound } })
      .where(eq(schema.apps.id, appId))
      .run();
  }

  it('blocks the follow-up when the App is over its rate limit (G7)', async () => {
    const { svc, appId } = seedDueContactWithThread();
    setOutboundPolicy(appId, { maxPerHour: 1 });
    const policy = new OutboundPolicyService({ db: ctx.db, logger: ctx.logger });
    policy.record(appId, 'agent'); // already at the cap this hour
    const dispatched: ChannelTurnInput[] = [];
    const proactive = new ProactiveFollowupService({
      db: ctx.db, contacts: svc, logger: ctx.logger, policy,
      dispatcher: { dispatch: async (input) => { dispatched.push(input); return { replied: true }; } },
    });

    const result = await proactive.sweep();
    expect(result.fired).toBe(0);
    expect(dispatched).toHaveLength(0); // gated, not dispatched
    expect(svc.dueForFollowUp(new Date().toISOString())).toHaveLength(0); // clock still cleared
  });

  it('holds the follow-up for approval when the goal crosses an approval line (G7)', async () => {
    const { svc, appId } = seedDueContactWithThread(); // goal = 'reserve the unit'
    setOutboundPolicy(appId, { requireApprovalFor: ['reserve'] });
    const policy = new OutboundPolicyService({ db: ctx.db, logger: ctx.logger });
    const dispatched: ChannelTurnInput[] = [];
    const approvals: Array<{ appId: string; reason: string }> = [];
    const proactive = new ProactiveFollowupService({
      db: ctx.db, contacts: svc, logger: ctx.logger, policy,
      dispatcher: { dispatch: async (input) => { dispatched.push(input); return { replied: true }; } },
      requestApproval: async (a) => { approvals.push({ appId: a.appId, reason: a.reason }); return true; },
    });

    const result = await proactive.sweep();
    expect(result.fired).toBe(0); // held, not sent
    expect(dispatched).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.reason).toMatch(/approval/i);
  });

  it('fires normally when the policy permits (records against the counter)', async () => {
    const { svc, appId } = seedDueContactWithThread();
    setOutboundPolicy(appId, { maxPerHour: 10 });
    const policy = new OutboundPolicyService({ db: ctx.db, logger: ctx.logger });
    const dispatched: ChannelTurnInput[] = [];
    const proactive = new ProactiveFollowupService({
      db: ctx.db, contacts: svc, logger: ctx.logger, policy,
      dispatcher: { dispatch: async (input) => { dispatched.push(input); return { replied: true }; } },
    });

    const result = await proactive.sweep();
    expect(result.fired).toBe(1);
    expect(dispatched).toHaveLength(1);
    // The send was recorded — a second App over the cap would now be gated.
    const rows = ctx.db.select().from(schema.appOutboundLog).where(eq(schema.appOutboundLog.appId, appId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('agent');
  });
});
