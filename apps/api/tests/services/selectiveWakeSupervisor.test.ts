/**
 * SelectiveWakeSupervisor (ORCHESTRATOR-SUSPEND-10X Phase 3) — the owner-wake half
 * of "start an app, sleep, wake when it concludes." Proves: it resolves the owning
 * agent via the run's App, wakes it ONLY on judgment/completion events, honors the
 * autonomy gate, coalesces a fan-in into one wake, and ignores routine progress.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { SelectiveWakeSupervisor, resolveRunOwnerAgent } from '../../src/services/orchestrator/selectiveWakeSupervisor.js';
import { AgentSessionService } from '../../src/services/agent/agentSession.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function seedAgent(name = 'Owner'): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({ id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name, adapterType: 'http' }).run();
  return id;
}

function seedApp(ownerAgentId: string | null): string {
  const id = randomUUID();
  const slug = `app-${id.slice(0, 8)}`;
  ctx.db.insert(schema.apps).values({
    id, workspaceId: ctx.workspace.id, slug, name: 'App', description: '', version: '0.1.0', status: 'active',
    manifest: { manifestVersion: 1, slug, name: 'App', version: '0.1.0', capabilities: [], requiredPlugins: [] },
    policy: { audience: [], shareable: false, customCode: 'disabled', grants: [] },
    createdBy: ctx.user.id,
    ...(ownerAgentId ? { ownerAgentId } : {}),
  }).run();
  return id;
}

function seedWorkflow(appId: string | null): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id, appId, title: 'WF',
    graph: { nodes: [], edges: [] },
  }).run();
  return id;
}

function seedConversation(agentId: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.conversations).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId,
  }).run();
  return id;
}

function seedRun(workflowId: string | null, conversationId?: string | null): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflowRuns).values({
    id, workspaceId: ctx.workspace.id, workflowId, userId: ctx.user.id, status: 'RUNNING',
    runState: { nodeStates: {} },
    ...(conversationId ? { conversationId } : {}),
  }).run();
  return id;
}

interface WakeCall { workspaceId: string; agentId: string; message: string }

function makeSupervisor(opts: { autonomy?: boolean } = {}) {
  const wakes: WakeCall[] = [];
  const sup = new SelectiveWakeSupervisor({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    autonomyEnabled: () => opts.autonomy ?? true,
    wakeOwner: (args) => { wakes.push(args); },
    debounceMs: 5,
  });
  return { sup, wakes };
}

describe('resolveRunOwnerAgent', () => {
  it('resolves the App owner from a run\'s workflow', () => {
    const owner = seedAgent();
    const run = seedRun(seedWorkflow(seedApp(owner)));
    expect(resolveRunOwnerAgent(ctx.db, run)).toEqual({ workspaceId: ctx.workspace.id, agentId: owner });
  });

  it('returns null for a run whose workflow is not App-owned', () => {
    const run = seedRun(seedWorkflow(null));
    expect(resolveRunOwnerAgent(ctx.db, run)).toBeNull();
  });

  it('returns null when the App has no owner and there is no conversation', () => {
    const run = seedRun(seedWorkflow(seedApp(null)));
    expect(resolveRunOwnerAgent(ctx.db, run)).toBeNull();
  });

  it('resolves DIRECT ownership from the run\'s conversation when it is not App-owned', () => {
    const starter = seedAgent('Starter');
    const run = seedRun(seedWorkflow(null), seedConversation(starter));
    expect(resolveRunOwnerAgent(ctx.db, run)).toEqual({ workspaceId: ctx.workspace.id, agentId: starter });
  });

  it('prefers the App owner over the conversation agent', () => {
    const appOwner = seedAgent('AppOwner');
    const starter = seedAgent('Starter');
    const run = seedRun(seedWorkflow(seedApp(appOwner)), seedConversation(starter));
    expect(resolveRunOwnerAgent(ctx.db, run)).toEqual({ workspaceId: ctx.workspace.id, agentId: appOwner });
  });
});

describe('SelectiveWakeSupervisor', () => {
  it('wakes the owning agent when an app it owns is accomplished', async () => {
    const owner = seedAgent();
    const run = seedRun(seedWorkflow(seedApp(owner)));
    const { sup, wakes } = makeSupervisor();
    sup.start();
    ctx.bus.publish(REALTIME_ROOMS.run(run), REALTIME_EVENTS.RUN_ACCOMPLISHED, { runId: run });
    await sup.flushAll();
    sup.stop();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ workspaceId: ctx.workspace.id, agentId: owner });
    expect(wakes[0]!.message).toContain('accomplished');
    expect(wakes[0]!.message).toContain(run.slice(0, 8));
  });

  it('publishes the reserved agent.wake.requested event with the coalesced run set', async () => {
    const owner = seedAgent();
    const app = seedApp(owner);
    const runA = seedRun(seedWorkflow(app));
    const runB = seedRun(seedWorkflow(app));
    const requested: Array<Record<string, unknown>> = [];
    const unsubscribe = ctx.bus.subscribe((message) => {
      if (message.envelope.event === REALTIME_EVENTS.AGENT_WAKE_REQUESTED) {
        requested.push((message.envelope.payload ?? {}) as Record<string, unknown>);
      }
    });
    const { sup } = makeSupervisor();
    sup.start();
    ctx.bus.publish(REALTIME_ROOMS.run(runA), REALTIME_EVENTS.RUN_COMPLETED, { runId: runA });
    ctx.bus.publish(REALTIME_ROOMS.run(runB), REALTIME_EVENTS.RUN_FAILED, { runId: runB });
    await sup.flushAll();
    sup.stop();
    unsubscribe();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      workspaceId: ctx.workspace.id,
      agentId: owner,
      runIds: expect.arrayContaining([runA, runB]),
    });
  });

  it.each([
    [REALTIME_EVENTS.WATCHDOG_TIMEOUT, 'watchdog timeout'],
    [REALTIME_EVENTS.BUDGET_PHASE_EXCEEDED, 'phase budget'],
    [REALTIME_EVENTS.BUDGET_RUN_EXCEEDED, 'run budget'],
    [REALTIME_EVENTS.BUDGET_WORKSPACE_EXCEEDED, 'workspace budget'],
  ])('wakes on hard-stall event %s', async (event, reason) => {
    const owner = seedAgent();
    const run = seedRun(seedWorkflow(seedApp(owner)));
    const { sup, wakes } = makeSupervisor();
    sup.start();
    ctx.bus.publish(REALTIME_ROOMS.run(run), event, { runId: run });
    await sup.flushAll();
    sup.stop();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.message).toContain(reason);
  });

  it('does NOT wake when the autonomy gate is off', async () => {
    const owner = seedAgent();
    const run = seedRun(seedWorkflow(seedApp(owner)));
    const { sup, wakes } = makeSupervisor({ autonomy: false });
    sup.start();
    ctx.bus.publish(REALTIME_ROOMS.run(run), REALTIME_EVENTS.RUN_FAILED, { runId: run });
    await sup.flushAll();
    sup.stop();
    expect(wakes).toHaveLength(0);
  });

  it('coalesces a fan-in of several runs for one owner into a single wake', async () => {
    const owner = seedAgent();
    const app = seedApp(owner);
    const runA = seedRun(seedWorkflow(app));
    const runB = seedRun(seedWorkflow(app));
    const { sup, wakes } = makeSupervisor();
    sup.start();
    ctx.bus.publish(REALTIME_ROOMS.run(runA), REALTIME_EVENTS.RUN_COMPLETED, { runId: runA });
    ctx.bus.publish(REALTIME_ROOMS.run(runB), REALTIME_EVENTS.RUN_FAILED, { runId: runB });
    await sup.flushAll();
    sup.stop();
    // One coalesced wake mentioning BOTH runs.
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.message).toContain(runA.slice(0, 8));
    expect(wakes[0]!.message).toContain(runB.slice(0, 8));
  });

  it('keeps a durable resident fan-in asleep until the last successful run settles', async () => {
    const owner = seedAgent();
    const app = seedApp(owner);
    const runA = seedRun(seedWorkflow(app));
    const runB = seedRun(seedWorkflow(app));
    const sessions = new AgentSessionService(ctx.db, ctx.logger);
    const resident = sessions.getOrCreateResident({ workspaceId: ctx.workspace.id, agentId: owner });
    sessions.suspend(resident.id, 'await_event', `runs:${runA},${runB}`, { runIds: [runA, runB] });
    const { sup, wakes } = makeSupervisor();
    sup.start();

    ctx.db.update(schema.workflowRuns).set({ status: 'COMPLETED' }).where(eq(schema.workflowRuns.id, runA)).run();
    ctx.bus.publish(REALTIME_ROOMS.run(runA), REALTIME_EVENTS.RUN_COMPLETED, { runId: runA });
    await sup.flushAll();
    expect(wakes).toHaveLength(0);

    ctx.db.update(schema.workflowRuns).set({ status: 'COMPLETED' }).where(eq(schema.workflowRuns.id, runB)).run();
    ctx.bus.publish(REALTIME_ROOMS.run(runB), REALTIME_EVENTS.RUN_COMPLETED, { runId: runB });
    await sup.flushAll();
    sup.stop();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.message).toContain(runA.slice(0, 8));
    expect(wakes[0]!.message).toContain(runB.slice(0, 8));
  });

  it('ignores routine progress events (no wake)', async () => {
    const owner = seedAgent();
    const run = seedRun(seedWorkflow(seedApp(owner)));
    const { sup, wakes } = makeSupervisor();
    sup.start();
    ctx.bus.publish(REALTIME_ROOMS.run(run), REALTIME_EVENTS.NODE_COMPLETED, { runId: run, nodeId: 'n1' });
    await sup.flushAll();
    sup.stop();
    expect(wakes).toHaveLength(0);
  });

  it('does not wake for a run with neither an App owner nor a conversation', async () => {
    const run = seedRun(seedWorkflow(null));
    const { sup, wakes } = makeSupervisor();
    sup.start();
    ctx.bus.publish(REALTIME_ROOMS.run(run), REALTIME_EVENTS.RUN_ACCOMPLISHED, { runId: run });
    await sup.flushAll();
    sup.stop();
    expect(wakes).toHaveLength(0);
  });

  it('wakes the DIRECT owner (conversation agent) of an ad-hoc run it started', async () => {
    const starter = seedAgent('Starter');
    const run = seedRun(seedWorkflow(null), seedConversation(starter));
    const { sup, wakes } = makeSupervisor();
    sup.start();
    ctx.bus.publish(REALTIME_ROOMS.run(run), REALTIME_EVENTS.RUN_COMPLETED, { runId: run });
    await sup.flushAll();
    sup.stop();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: starter });
  });
});
