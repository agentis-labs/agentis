/**
 * TriggerRuntime — data_event + workflow_completed cross-workflow triggers
 * (AGENTIS-PLATFORM-10X §A2, §A3).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REALTIME_EVENTS, REALTIME_ROOMS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';
import { ActiveWorkflowRegistry, type ActiveTrigger } from '../../src/engine/ActiveWorkflowRegistry.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import type { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: ActiveWorkflowRegistry;
let engine: { startRun: ReturnType<typeof vi.fn> };
let runtime: TriggerRuntime;

const graph: WorkflowGraph = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'T', type: 'trigger', title: 'T', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'data_event' } },
  ],
  edges: [],
};

beforeEach(async () => {
  ctx = await createTestContext();
  registry = new ActiveWorkflowRegistry(ctx.db, ctx.logger);
  engine = { startRun: vi.fn().mockResolvedValue({ runId: randomUUID(), workflowId: 'wf' }) };
  runtime = new TriggerRuntime({
    db: ctx.db,
    logger: ctx.logger,
    registry,
    engine: engine as unknown as WorkflowEngine,
    adapters: { get: vi.fn() } as unknown as AdapterManager,
    bus: ctx.bus,
  });
});
afterEach(() => ctx.close());

function seedTrigger(triggerType: 'data_event' | 'workflow_completed', config: Record<string, unknown>) {
  const wfId = randomUUID();
  const triggerId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'reactor-wf',
      graph,
      settings: {},
    })
    .run();
  ctx.db
    .insert(schema.triggers)
    .values({
      id: triggerId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      triggerType,
      config,
      status: 'paused',
    })
    .run();
  return { wfId, triggerId };
}

function activeTrigger(triggerId: string, wfId: string, triggerType: ActiveTrigger['triggerType'], config: Record<string, unknown>): ActiveTrigger {
  return {
    triggerId,
    workflowId: wfId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    triggerType,
    config,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('TriggerRuntime data_event', () => {
  it('fires the bound workflow when a matching record is inserted', async () => {
    const { wfId, triggerId } = seedTrigger('data_event', { table: 'leads', event: 'insert' });
    await runtime.activate(activeTrigger(triggerId, wfId, 'data_event', { table: 'leads', event: 'insert' }));

    ctx.bus.publish(REALTIME_ROOMS.workspace(ctx.workspace.id), REALTIME_EVENTS.DATA_RECORD_CHANGED, {
      appId: null,
      workspaceId: ctx.workspace.id,
      table: 'leads',
      event: 'insert',
      record: { company: 'Acme', conversion_stage: 'new' },
    });
    await tick();
    expect(engine.startRun).toHaveBeenCalledTimes(1);
  });

  it('respects the table + event filter', async () => {
    const { wfId, triggerId } = seedTrigger('data_event', { table: 'leads', event: 'insert' });
    await runtime.activate(activeTrigger(triggerId, wfId, 'data_event', { table: 'leads', event: 'insert' }));

    // Wrong table — ignored.
    ctx.bus.publish(REALTIME_ROOMS.workspace(ctx.workspace.id), REALTIME_EVENTS.DATA_RECORD_CHANGED, {
      workspaceId: ctx.workspace.id, table: 'outreach_log', event: 'insert', record: {},
    });
    // Wrong event — ignored.
    ctx.bus.publish(REALTIME_ROOMS.workspace(ctx.workspace.id), REALTIME_EVENTS.DATA_RECORD_CHANGED, {
      workspaceId: ctx.workspace.id, table: 'leads', event: 'delete', record: {},
    });
    await tick();
    expect(engine.startRun).not.toHaveBeenCalled();
  });

  it('applies the record filter expression', async () => {
    const { wfId, triggerId } = seedTrigger('data_event', {
      table: 'leads', event: 'insert', filter: "conversion_stage == 'new'",
    });
    await runtime.activate(
      activeTrigger(triggerId, wfId, 'data_event', {
        table: 'leads', event: 'insert', filter: "conversion_stage == 'new'",
      }),
    );

    ctx.bus.publish(REALTIME_ROOMS.workspace(ctx.workspace.id), REALTIME_EVENTS.DATA_RECORD_CHANGED, {
      workspaceId: ctx.workspace.id, table: 'leads', event: 'insert',
      record: { conversion_stage: 'closed' },
    });
    await tick();
    expect(engine.startRun).not.toHaveBeenCalled();

    ctx.bus.publish(REALTIME_ROOMS.workspace(ctx.workspace.id), REALTIME_EVENTS.DATA_RECORD_CHANGED, {
      workspaceId: ctx.workspace.id, table: 'leads', event: 'insert',
      record: { conversion_stage: 'new' },
    });
    await tick();
    expect(engine.startRun).toHaveBeenCalledTimes(1);
  });

  it('chains workflows on workflow_completed', async () => {
    const { wfId, triggerId } = seedTrigger('workflow_completed', { sourceWorkflowId: 'upstream-wf' });
    await runtime.activate(
      activeTrigger(triggerId, wfId, 'workflow_completed', { sourceWorkflowId: 'upstream-wf' }),
    );

    ctx.bus.publish(REALTIME_ROOMS.workspace(ctx.workspace.id), REALTIME_EVENTS.APP_WORKFLOW_COMPLETED, {
      workflowId: 'upstream-wf',
      runId: randomUUID(),
      workspaceId: ctx.workspace.id,
      status: 'COMPLETED',
    });
    await tick();
    expect(engine.startRun).toHaveBeenCalledTimes(1);
  });

  it('does not fire workflow_completed for a non-matching source', async () => {
    const { wfId, triggerId } = seedTrigger('workflow_completed', { sourceWorkflowId: 'upstream-wf' });
    await runtime.activate(
      activeTrigger(triggerId, wfId, 'workflow_completed', { sourceWorkflowId: 'upstream-wf' }),
    );
    ctx.bus.publish(REALTIME_ROOMS.workspace(ctx.workspace.id), REALTIME_EVENTS.APP_WORKFLOW_COMPLETED, {
      workflowId: 'some-other-wf',
      runId: randomUUID(),
      workspaceId: ctx.workspace.id,
      status: 'COMPLETED',
    });
    await tick();
    expect(engine.startRun).not.toHaveBeenCalled();
  });
});
