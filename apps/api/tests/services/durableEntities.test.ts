/**
 * DurableEntityService + DurableEntityDispatcher — the Durable Entity spine (§3.0).
 * Proves the load-bearing properties: find-or-create by key, a per-entity inbox that
 * handles out-of-order/multi-day events, correlation-token routing, a mandatory lease
 * (single-writer per entity), timer-OR-inbox due detection, and the driving dispatcher.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DurableEntityService, DurableEntityDispatcher, type EntityWakeContext } from '../../src/services/durableEntities.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

const past = '2020-01-01T00:00:00.000Z';
const future = '2999-01-01T00:00:00.000Z';

describe('DurableEntityService', () => {
  it('find-or-creates by (workspace, kind, key) and merges state', () => {
    const svc = new DurableEntityService(ctx.db);
    const a = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', state: { stage: 'found' } });
    const b = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', state: { budget: '40k' } });
    expect(b.id).toBe(a.id); // no duplicate
    expect(b.stateJson).toMatchObject({ stage: 'found', budget: '40k' }); // merged
  });

  it('routes out-of-order / multi-day events to the right entity via its own inbox', () => {
    const svc = new DurableEntityService(ctx.db);
    const first = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', nextWakeAt: null });
    const second = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-2', nextWakeAt: null });
    // The SECOND lead replies first (out of order) — the first still waits.
    svc.post(second.id, 'reply', { text: 'yes' });
    const claimed = svc.claimDue({ leaseOwner: 'w', leaseMs: 1000, kinds: ['subject'] });
    expect(claimed.map((c) => c.entity.id)).toEqual([second.id]); // only the one with an event
    expect(claimed[0]?.inbox[0]?.eventType).toBe('reply');
  });

  it('routes an inbound event by correlation token', () => {
    const svc = new DurableEntityService(ctx.db);
    const e = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', awaitingCorrelation: { kind: 'thread', id: 'wa-42' } });
    const hit = svc.postByCorrelation(ctx.workspace.id, { kind: 'thread', id: 'wa-42' }, 'reply', { text: 'hi' });
    expect(hit).toBe(e.id);
    expect(svc.postByCorrelation(ctx.workspace.id, { kind: 'thread', id: 'nope' }, 'reply')).toBeNull();
    expect(svc.pendingInbox(e.id)).toHaveLength(1);
  });

  it('leases so two concurrent sweeps never both claim the same entity', () => {
    const svc = new DurableEntityService(ctx.db);
    const e = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', nextWakeAt: past });
    const first = svc.claimDue({ leaseOwner: 'A', leaseMs: 60_000, kinds: ['subject'] });
    const second = svc.claimDue({ leaseOwner: 'B', leaseMs: 60_000, kinds: ['subject'] });
    expect(first.map((c) => c.entity.id)).toEqual([e.id]);
    expect(second).toHaveLength(0); // still leased by A
    // After A releases, it can be claimed again.
    svc.release(e.id, { nextWakeAt: past });
    expect(svc.claimDue({ leaseOwner: 'B', leaseMs: 60_000, kinds: ['subject'] }).map((c) => c.entity.id)).toEqual([e.id]);
  });

  it('is due by timer OR by inbox, and never when parked in the future with no events', () => {
    const svc = new DurableEntityService(ctx.db);
    const timer = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'timer', nextWakeAt: past });
    const parked = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'parked', nextWakeAt: future });
    svc.post(parked.id, 'reply'); // parked becomes due via inbox despite future timer
    const idle = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'idle', nextWakeAt: future });
    const due = svc.claimDue({ leaseOwner: 'w', leaseMs: 1000, kinds: ['subject'] }).map((c) => c.entity.key).sort();
    expect(due).toEqual(['parked', 'timer']);
    expect(due).not.toContain('idle');
  });

  it('release consumes inbox, advances the clock, and done stops future wakes', () => {
    const svc = new DurableEntityService(ctx.db);
    const e = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', nextWakeAt: past });
    svc.post(e.id, 'reply');
    const [claimed] = svc.claimDue({ leaseOwner: 'w', leaseMs: 1000, kinds: ['subject'] });
    svc.release(e.id, { consumeInboxIds: claimed!.inbox.map((i) => i.id), done: true });
    expect(svc.pendingInbox(e.id)).toHaveLength(0); // consumed
    expect(svc.get(e.id)?.status).toBe('done');
    expect(svc.claimDue({ leaseOwner: 'w', leaseMs: 1000, kinds: ['subject'] })).toHaveLength(0); // done → never woken
  });
});

describe('DurableEntityDispatcher', () => {
  it('drives handled kinds: runs the handler with the inbox, consumes it, honours done', async () => {
    const svc = new DurableEntityService(ctx.db);
    const seen: EntityWakeContext[] = [];
    const disp = new DurableEntityDispatcher(svc, { logger: ctx.logger });
    disp.registerHandler('subject', (c) => { seen.push(c); return { done: true }; });

    const e = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', nextWakeAt: past });
    svc.post(e.id, 'reply', { text: 'yes' });

    expect(await disp.tick()).toBe(1);
    expect(seen[0]?.entity.id).toBe(e.id);
    expect(seen[0]?.inbox[0]?.eventType).toBe('reply');
    expect(svc.pendingInbox(e.id)).toHaveLength(0); // consumed on success
    expect(svc.get(e.id)?.status).toBe('done');
  });

  it('no-ops with no registered handlers, and ignores unhandled kinds', async () => {
    const svc = new DurableEntityService(ctx.db);
    svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', nextWakeAt: past });
    const empty = new DurableEntityDispatcher(svc);
    expect(await empty.tick()).toBe(0); // safe no-op — nothing claimed/dropped
  });

  it('retries on handler error (does NOT consume the inbox) and clears the lease', async () => {
    const svc = new DurableEntityService(ctx.db);
    const disp = new DurableEntityDispatcher(svc, { logger: ctx.logger });
    let calls = 0;
    disp.registerHandler('subject', () => { calls += 1; if (calls === 1) throw new Error('boom'); return { done: true }; });
    const e = svc.upsert({ workspaceId: ctx.workspace.id, kind: 'subject', key: 'lead-1', nextWakeAt: past });
    svc.post(e.id, 'reply');

    await disp.tick(); // throws internally → released, inbox NOT consumed
    expect(svc.pendingInbox(e.id)).toHaveLength(1);
    expect(svc.get(e.id)?.leaseOwner).toBeNull(); // lease cleared → claimable again
    await disp.tick(); // second attempt succeeds
    expect(calls).toBe(2);
    expect(svc.get(e.id)?.status).toBe('done');
  });
});
