import { describe, expect, it } from 'vitest';
import { REALTIME_EVENTS } from '@agentis/core';
import {
  REALTIME_ACTIVITY_EVENTS,
  describeRealtimeActivity,
} from '../../src/lib/realtimeActivity';

describe('realtimeActivity task spine events', () => {
  it('maps task spine verification into Mission Control activity', () => {
    expect(REALTIME_ACTIVITY_EVENTS).toContain(REALTIME_EVENTS.TASK_SPINE_VERIFYING);

    const activity = describeRealtimeActivity({
      event: REALTIME_EVENTS.TASK_SPINE_VERIFYING,
      emittedAt: '2026-06-17T12:00:00.000Z',
      payload: {
        taskId: 'task-1',
        planId: 'task-1',
        title: 'Ship verified answer',
        status: 'verifying',
      },
    });

    expect(activity).toMatchObject({
      kind: 'task',
      tone: 'warn',
      taskId: 'task-1',
      title: 'Ship verified answer',
    });
  });

  it('surfaces blocked task spine details from verification evidence', () => {
    const activity = describeRealtimeActivity({
      event: REALTIME_EVENTS.TASK_SPINE_BLOCKED,
      emittedAt: '2026-06-17T12:00:00.000Z',
      payload: {
        taskId: 'task-2',
        title: 'Collect evidence',
        verification: {
          status: 'failed',
          criteria: [{ criterion: 'Evidence is complete', passed: false, reason: 'Missing source link.' }],
        },
      },
    });

    expect(activity).toMatchObject({
      kind: 'task',
      tone: 'warn',
      detail: 'Missing source link.',
    });
  });

  it('keeps a repair work-step detail instead of collapsing it into the node title', () => {
    const activity = describeRealtimeActivity({
      event: REALTIME_EVENTS.AGENT_WORK_STEP,
      emittedAt: '2026-06-21T14:00:00.000Z',
      payload: {
        runId: 'run-1',
        nodeId: 'evaluate-digest-quality',
        description: 'Repairing Evaluator',
        detail: 'Orchestrator is inspecting the completed digest bundle.',
        phase: 'thinking',
      },
    });

    expect(activity).toMatchObject({
      kind: 'agent',
      detail: 'Orchestrator is inspecting the completed digest bundle.',
    });
  });

  it('does not present mechanical completion as success when the business verdict failed', () => {
    const activity = describeRealtimeActivity({
      event: REALTIME_EVENTS.RUN_COMPLETED,
      emittedAt: '2026-07-15T12:00:00.000Z',
      payload: {
        runId: 'run-deficient',
        status: 'COMPLETED',
        accomplished: false,
        verdict: 'failed_checks',
      },
    });

    expect(activity).toMatchObject({
      kind: 'run',
      tone: 'danger',
      title: 'Run finished — outcome not accomplished',
    });
    expect(activity?.detail).toContain('failed_checks');
  });
});
