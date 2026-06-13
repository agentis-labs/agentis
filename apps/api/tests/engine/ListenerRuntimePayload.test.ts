import { describe, expect, it, vi } from 'vitest';
import { REALTIME_EVENTS, REALTIME_ROOMS, type ListenerConfig } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { createInProcessEventBus } from '../../src/event-bus.js';
import { ListenerRuntime } from '../../src/engine/ListenerRuntime.js';
import type { ActiveTrigger } from '../../src/engine/ActiveWorkflowRegistry.js';
import { ListenerHealthStore } from '../../src/engine/listener/health.js';
import { createLogger } from '../../src/logger.js';
import type { WorkflowStoreService } from '../../src/services/workflowStore.js';

const logger = createLogger({ level: 'error' });

describe('ListenerRuntime payload shaping', () => {
  it('adds single-event listener aliases for item/events/count', async () => {
    const bus = createInProcessEventBus();
    const health = new ListenerHealthStore();
    const fire = vi.fn(async () => ({ runId: 'run-1' }));
    const runtime = new ListenerRuntime({
      db: {} as AgentisSqliteDb,
      logger,
      bus,
      workflowStore: {} as WorkflowStoreService,
      health,
      fire,
      allowPrivateNetwork: false,
    });
    const trigger: ActiveTrigger = {
      triggerId: 't-agent',
      workflowId: 'wf-1',
      workspaceId: 'ws-1',
      ambientId: null,
      userId: 'u-1',
      triggerType: 'persistent_listener',
      config: {} as Record<string, unknown>,
    };
    const config: ListenerConfig = {
      source: { kind: 'agent_event', agentId: 'agent-9', eventTypes: [REALTIME_EVENTS.AGENT_TASK_COMPLETED] },
      predicate: { kind: 'always' },
      firePolicy: { mode: 'immediate' },
    };

    await runtime.activate({ ...trigger, config: config as unknown as Record<string, unknown> });
    bus.publish(REALTIME_ROOMS.agent('agent-9'), REALTIME_EVENTS.AGENT_TASK_COMPLETED, {
      url: 'https://example.test/post',
      title: 'Example Post',
    });

    await vi.waitFor(() => expect(fire).toHaveBeenCalledTimes(1));
    expect(fire.mock.calls[0]?.[0]?.payload).toEqual({
      url: 'https://example.test/post',
      title: 'Example Post',
      event: {
        event: REALTIME_EVENTS.AGENT_TASK_COMPLETED,
        url: 'https://example.test/post',
        title: 'Example Post',
      },
      item: {
        event: REALTIME_EVENTS.AGENT_TASK_COMPLETED,
        url: 'https://example.test/post',
        title: 'Example Post',
      },
      events: [
        {
          event: REALTIME_EVENTS.AGENT_TASK_COMPLETED,
          url: 'https://example.test/post',
          title: 'Example Post',
        },
      ],
      count: 1,
      _listener: expect.objectContaining({
        triggerId: 't-agent',
        sourceKind: 'agent_event',
      }),
    });

    await runtime.deactivate('t-agent');
  });
});
