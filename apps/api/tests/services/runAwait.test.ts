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
import { waitForRunSettle } from '../../src/services/agentisToolHandlers/run.js';

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
