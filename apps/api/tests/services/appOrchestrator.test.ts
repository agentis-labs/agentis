/**
 * AppOrchestrator — dependsOn chains, binding schedules, concurrency, run-all
 * (APP-INTERFACE-10X §2.3). Uses the same in-memory context as scheduler tests;
 * the engine is a drain stub — the run + queue ROWS are the assertions.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AppWorkflowBinding, WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AppOrchestratorService } from '../../src/services/appOrchestrator.js';
import { nextCronFire, describeCron } from '../../src/services/cronNextFire.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: { drainWorkflowQueue: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  ctx = await createTestContext();
  engine = { drainWorkflowQueue: vi.fn().mockResolvedValue(undefined) };
});

afterEach(() => ctx.close());

function trivialGraph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'start', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function seedApp(): string {
  const id = randomUUID();
  ctx.db.insert(schema.apps).values({
    id,
    workspaceId: ctx.workspace.id,
    slug: `app-${id.slice(0, 8)}`,
    name: 'Factory',
    description: '',
    version: '0.1.0',
    status: 'draft',
    manifest: { manifestVersion: 1, slug: `app-${id.slice(0, 8)}`, name: 'Factory', version: '0.1.0', capabilities: [], requiredPlugins: [] },
    policy: { audience: [], shareable: false, customCode: 'disabled', grants: [] },
    createdBy: ctx.user.id,
  }).run();
  return id;
}

function seedWorkflow(appId: string | null, title: string, binding?: Partial<AppWorkflowBinding>) {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    appId,
    title,
    graph: trivialGraph(),
    settings: binding ? { appBinding: { dependsOn: [], ...binding } } : {},
  }).run();
  return id;
}

function seedRun(workflowId: string, status: string, parentRunId?: string | null) {
  const id = randomUUID();
  ctx.db.insert(schema.workflowRuns).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status,
    runState: { runId: id, workflowId, status, nodeStates: {}, completedNodeIds: [] },
    replanCount: 0,
    ...(parentRunId ? { parentRunId } : {}),
  }).run();
  return id;
}

function orchestrator() {
  return new AppOrchestratorService({ db: ctx.db, bus: ctx.bus, engine: engine as unknown as WorkflowEngine, logger: ctx.logger });
}

function queuedFor(workflowId: string) {
  return ctx.db.select().from(schema.workflowRunQueue).where(eq(schema.workflowRunQueue.workflowId, workflowId)).all();
}

describe('AppOrchestratorService — dependsOn chains', () => {
  it('queues an enabled dependent after a clean upstream completion', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a] });
    const runId = seedRun(a, 'COMPLETED');

    const { fired } = await orchestrator().handleRunSettled(runId);
    expect(fired).toBe(1);
    const queue = queuedFor(b);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.reason).toBe('app_chain');
    expect(queue[0]?.parentRunId).toBe(runId);
    expect(engine.drainWorkflowQueue).toHaveBeenCalledWith(b);
  });

  it('does not fire on failure by default, fires with chainOn always, skips disabled', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const onSuccess = seedWorkflow(appId, 'B success-only', { dependsOn: [a] });
    const always = seedWorkflow(appId, 'C always', { dependsOn: [a], chainOn: 'always' });
    const disabled = seedWorkflow(appId, 'D disabled', { dependsOn: [a], enabled: false });
    const runId = seedRun(a, 'FAILED');

    const { fired } = await orchestrator().handleRunSettled(runId);
    expect(fired).toBe(1);
    expect(queuedFor(onSuccess)).toHaveLength(0);
    expect(queuedFor(always)).toHaveLength(1);
    expect(queuedFor(disabled)).toHaveLength(0);
  });

  it('skips an exclusive dependent that already has an active run', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A');
    const b = seedWorkflow(appId, 'B', { dependsOn: [a], concurrency: 'exclusive' });
    seedRun(b, 'RUNNING'); // already busy
    const runId = seedRun(a, 'COMPLETED');

    const { fired } = await orchestrator().handleRunSettled(runId);
    expect(fired).toBe(0);
    expect(queuedFor(b)).toHaveLength(0);
  });

  it('caps chain depth so dependsOn cycles terminate', async () => {
    const appId = seedApp();
    const a = seedWorkflow(appId, 'A', { dependsOn: [] });
    const b = seedWorkflow(appId, 'B', { dependsOn: [a] });
    // Build a deep parent lineage: 16 completed ancestors.
    let parent: string | null = null;
    for (let i = 0; i < 17; i += 1) parent = seedRun(a, 'COMPLETED', parent);

    const { fired } = await orchestrator().handleRunSettled(parent!);
    expect(fired).toBe(0);
    expect(queuedFor(b)).toHaveLength(0);
  });

  it('ignores runs of workflows outside any app', async () => {
    const bare = seedWorkflow(null, 'bare');
    const runId = seedRun(bare, 'COMPLETED');
    const { fired } = await orchestrator().handleRunSettled(runId);
    expect(fired).toBe(0);
  });
});

describe('AppOrchestratorService — run-all', () => {
  it('starts enabled roots in order and skips exclusive-busy ones', async () => {
    const appId = seedApp();
    const first = seedWorkflow(appId, 'first', { order: 1 });
    const second = seedWorkflow(appId, 'second', { order: 2 });
    const dependent = seedWorkflow(appId, 'chained', { order: 0, dependsOn: [first] });
    const paused = seedWorkflow(appId, 'paused', { order: 3, enabled: false });
    const busy = seedWorkflow(appId, 'busy', { order: 4, concurrency: 'exclusive' });
    seedRun(busy, 'RUNNING');

    const results = await orchestrator().runAll(ctx.workspace.id, appId, ctx.user.id);
    const started = results.filter((r) => r.runId);
    expect(started.map((r) => r.workflowId)).toEqual([first, second]);
    expect(results.find((r) => r.workflowId === busy)?.skipped).toBe('active_run_exclusive');
    expect(results.some((r) => r.workflowId === dependent)).toBe(false);
    expect(results.some((r) => r.workflowId === paused)).toBe(false);
  });
});

describe('AppOrchestratorService — binding schedules', () => {
  it('arms, reports nextScheduledFire, and fires a due cron through the queue', async () => {
    const appId = seedApp();
    const wf = seedWorkflow(appId, 'nightly', { schedule: { cron: '*/5 * * * *', enabled: true } });
    const orch = orchestrator();
    orch.rearmAll(new Date());
    expect(orch.nextScheduledFire(wf)).toBeTruthy();

    // Pretend the due moment arrived: sweep "now" far in the future.
    const fired = await orch.sweepSchedules(new Date(Date.now() + 6 * 60_000));
    expect(fired).toBe(1);
    const queue = queuedFor(wf);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.reason).toBe('app_schedule');
    // Re-armed for the next window, not dropped.
    expect(orch.nextScheduledFire(wf)).toBeTruthy();
  });

  it('does not fire disabled schedules or invalid cron expressions', async () => {
    const appId = seedApp();
    const off = seedWorkflow(appId, 'off', { schedule: { cron: '*/5 * * * *', enabled: false } });
    const bad = seedWorkflow(appId, 'bad', { schedule: { cron: 'not a cron', enabled: true } });
    const orch = orchestrator();
    orch.rearmAll(new Date());
    expect(orch.nextScheduledFire(off)).toBeNull();
    expect(orch.nextScheduledFire(bad)).toBeNull();
    const fired = await orch.sweepSchedules(new Date(Date.now() + 60 * 60_000));
    expect(fired).toBe(0);
  });
});

describe('nextCronFire', () => {
  it('computes daily, step, and weekday schedules', () => {
    const from = new Date('2026-07-02T10:30:00Z'); // a Thursday
    expect(nextCronFire('0 9 * * *', from)?.toISOString()).toBe('2026-07-03T09:00:00.000Z');
    expect(nextCronFire('*/15 * * * *', from)?.toISOString()).toBe('2026-07-02T10:45:00.000Z');
    expect(nextCronFire('0 8 * * mon', from)?.toISOString()).toBe('2026-07-06T08:00:00.000Z');
    expect(nextCronFire('30 6 1 * *', from)?.toISOString()).toBe('2026-08-01T06:30:00.000Z');
    expect(nextCronFire('garbage', from)).toBeNull();
    expect(nextCronFire('0 9 31 2 *', from)).toBeNull(); // Feb 31 never exists
  });

  it('describes common expressions', () => {
    expect(describeCron('0 9 * * *')).toBe('daily 09:00');
    expect(describeCron('*/15 * * * *')).toBe('every 15 min');
    expect(describeCron('0 8 * * 1')).toBe('mon 08:00');
  });
});
