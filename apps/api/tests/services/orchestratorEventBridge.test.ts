import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { OrchestratorEventBridge } from '../../src/services/orchestratorEventBridge.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('OrchestratorEventBridge', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => ctx.close());

  it('publishes a proactive card to the orchestrator conversation when a run fails', () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Agentis',
      adapterType: 'http',
      role: 'orchestrator',
    }).run();

    const capture = ctx.captureBus();
    const bridge = new OrchestratorEventBridge({ db: ctx.db, bus: ctx.bus, logger: ctx.logger });
    bridge.start();

    ctx.bus.publish(REALTIME_ROOMS.workspace(ctx.workspace.id), REALTIME_EVENTS.RUN_FAILED, {
      runId: 'run_12345678',
      workflowId: 'workflow_1',
      status: 'FAILED',
    });

    bridge.stop();
    capture.stop();

    const proactiveEvents = capture.events.filter((event) => event.envelope.event === REALTIME_EVENTS.AGENT_PROACTIVE_PUSH);
    expect(proactiveEvents.length).toBeGreaterThanOrEqual(2);
    expect(proactiveEvents.some((event) => event.room === REALTIME_ROOMS.conversation(agentId))).toBe(true);
    expect(proactiveEvents[0]!.envelope.payload).toMatchObject({
      agentId,
      kind: 'run_failed',
      card: { title: 'Run failed', tone: 'danger' },
    });
  });
});