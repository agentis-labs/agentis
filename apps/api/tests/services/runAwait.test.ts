/**
 * agentis.run.await — event-driven wait instead of sleep+poll. These fence the
 * settle helper: it resolves the instant the run/node settles (via the bus),
 * returns immediately when already settled, and never misses an event that fires
 * between the state read and the subscribe. No polling, no token burn.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { waitForRunSettle, waitForAllRunsSettle } from '../../src/services/agentisToolHandlers/run.js';
import { summarizeFanIn, type RunsFanInResult } from '../../src/services/run/runSettle.js';

describe('waitForRunSettle', () => {
  let ctx: TestContext;
  let deps: { db: TestContext['db']; bus: TestContext['bus'] };

  function seedRun(status: string): string {
    const id = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({
      id, workspaceId: ctx.workspace.id, userId: ctx.user.id, status,
      runState: { completedNodeIds: [], nodeStates: {} } as never,
    }).run();
    return id;
  }

  beforeEach(async () => {
    ctx = await createTestContext();
    deps = { db: ctx.db, bus: ctx.bus };
  });
  afterEach(() => ctx.close());

  it('resolves the instant a RUN_COMPLETED event fires (no polling)', async () => {
    const runId = seedRun('RUNNING');
    const pending = waitForRunSettle(deps, ctx.workspace.id, runId, { timeoutMs: 3000 });
    // Subscribed synchronously in the executor, so publishing now is caught.
    ctx.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.RUN_COMPLETED, { runId, status: 'COMPLETED' });
    await expect(pending).resolves.toMatchObject({ resolved: 'settled', status: 'COMPLETED' });
  });

  it('returns immediately when the run is ALREADY settled (terminal or waiting)', async () => {
    await expect(waitForRunSettle(deps, ctx.workspace.id, seedRun('COMPLETED'), { timeoutMs: 3000 }))
      .resolves.toMatchObject({ resolved: 'settled', status: 'COMPLETED' });
    // WAITING (e.g. parked on an approval) is a settle point too — don't hang.
    await expect(waitForRunSettle(deps, ctx.workspace.id, seedRun('WAITING'), { timeoutMs: 3000 }))
      .resolves.toMatchObject({ resolved: 'settled', status: 'WAITING' });
  });

  it('wakes on a specific node completing when nodeId is given', async () => {
    const runId = seedRun('RUNNING');
    const pending = waitForRunSettle(deps, ctx.workspace.id, runId, { nodeId: 'X', timeoutMs: 3000 });
    ctx.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.NODE_COMPLETED, { runId, nodeId: 'X' });
    await expect(pending).resolves.toMatchObject({ resolved: 'node', nodeEvent: 'completed' });
  });

  it('ignores events for OTHER runs, then times out cleanly', async () => {
    const runId = seedRun('RUNNING');
    const pending = waitForRunSettle(deps, ctx.workspace.id, runId, { timeoutMs: 150 });
    ctx.bus.publish(REALTIME_ROOMS.run('someone-else'), REALTIME_EVENTS.RUN_COMPLETED, { runId: 'someone-else', status: 'COMPLETED' });
    await expect(pending).resolves.toMatchObject({ resolved: 'timeout' });
  });

  it('resolves not_found for an unknown run', async () => {
    await expect(waitForRunSettle(deps, ctx.workspace.id, 'does-not-exist', { timeoutMs: 500 }))
      .resolves.toMatchObject({ resolved: 'not_found' });
  });
});

describe('waitForAllRunsSettle (fan-in)', () => {
  let ctx: TestContext;
  let deps: { db: TestContext['db']; bus: TestContext['bus'] };

  function seedRun(status: string): string {
    const id = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({
      id, workspaceId: ctx.workspace.id, userId: ctx.user.id, status,
      runState: { completedNodeIds: [], nodeStates: {} } as never,
    }).run();
    return id;
  }

  beforeEach(async () => {
    ctx = await createTestContext();
    deps = { db: ctx.db, bus: ctx.bus };
  });
  afterEach(() => ctx.close());

  it('wakes ONCE when the LAST of several runs settles', async () => {
    const a = seedRun('RUNNING');
    const b = seedRun('RUNNING');
    const c = seedRun('RUNNING');
    const pending = waitForAllRunsSettle(deps, ctx.workspace.id, [a, b, c], { timeoutMs: 3000 });
    ctx.bus.publish(REALTIME_ROOMS.run(a), REALTIME_EVENTS.RUN_COMPLETED, { runId: a, status: 'COMPLETED' });
    ctx.bus.publish(REALTIME_ROOMS.run(b), REALTIME_EVENTS.RUN_FAILED, { runId: b, status: 'FAILED' });
    // Still waiting on c — must not have resolved yet.
    const settledEarly = await Promise.race([pending.then(() => true), Promise.resolve(false)]);
    expect(settledEarly).toBe(false);
    ctx.bus.publish(REALTIME_ROOMS.run(c), REALTIME_EVENTS.RUN_COMPLETED, { runId: c, status: 'COMPLETED' });
    const result = await pending;
    expect(result.resolved).toBe('all_settled');
    expect(result.settled.get(a)).toMatchObject({ status: 'COMPLETED', found: true });
    expect(result.settled.get(b)).toMatchObject({ status: 'FAILED', found: true });
    expect(result.settled.get(c)).toMatchObject({ status: 'COMPLETED', found: true });
  });

  it('counts already-settled runs immediately and mixes with live events', async () => {
    const done = seedRun('COMPLETED');
    const live = seedRun('RUNNING');
    const pending = waitForAllRunsSettle(deps, ctx.workspace.id, [done, live], { timeoutMs: 3000 });
    ctx.bus.publish(REALTIME_ROOMS.run(live), REALTIME_EVENTS.RUN_COMPLETED, { runId: live, status: 'COMPLETED' });
    await expect(pending).resolves.toMatchObject({ resolved: 'all_settled' });
  });

  it('treats an unknown runId as settled (found:false) so a bad id never hangs the join', async () => {
    const live = seedRun('COMPLETED');
    const result = await waitForAllRunsSettle(deps, ctx.workspace.id, [live, 'ghost'], { timeoutMs: 500 });
    expect(result.resolved).toBe('all_settled');
    expect(result.settled.get('ghost')).toMatchObject({ found: false });
  });

  it('times out with the pending ids when a run never settles', async () => {
    const a = seedRun('COMPLETED');
    const b = seedRun('RUNNING');
    const result = await waitForAllRunsSettle(deps, ctx.workspace.id, [a, b], { timeoutMs: 150 });
    expect(result.resolved).toBe('timeout');
    expect(result.settled.has(a)).toBe(true);
    expect(result.settled.has(b)).toBe(false);
  });
});

describe('summarizeFanIn', () => {
  it('shapes an all-settled result into per-run statuses', () => {
    const res: RunsFanInResult = {
      resolved: 'all_settled',
      settled: new Map([
        ['a', { status: 'COMPLETED', found: true }],
        ['b', { status: 'FAILED', found: true }],
      ]),
    };
    const out = summarizeFanIn(['a', 'b'], res);
    expect(out).toMatchObject({ ok: true, awaited: 'all_settled' });
    expect(out.runs).toEqual([
      { runId: 'a', found: true, status: 'COMPLETED', settled: true },
      { runId: 'b', found: true, status: 'FAILED', settled: true },
    ]);
    expect(out.timedOut).toBeUndefined();
  });

  it('flags timedOut and lists the still-pending ids on a partial result', () => {
    const res: RunsFanInResult = {
      resolved: 'timeout',
      settled: new Map([['a', { status: 'COMPLETED', found: true }]]),
    };
    const out = summarizeFanIn(['a', 'b'], res);
    expect(out.timedOut).toBe(true);
    expect(out.pending).toEqual(['b']);
    expect(out.runs.find((r) => r.runId === 'b')).toMatchObject({ settled: false, status: null });
  });
});
