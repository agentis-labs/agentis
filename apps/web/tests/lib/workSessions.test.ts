import { describe, expect, it } from 'vitest';
import {
  buildWorkSessions,
  captionMapFromSessions,
  liveNodeIdsFromSessions,
} from '../../src/lib/workSessions';
import type { RealtimeActivity } from '../../src/lib/realtimeActivity';
import type { ObservabilityEvent } from '../../src/lib/observability';
import type { WorkspaceActiveRun } from '../../src/lib/workspaceData';

const baseAt = '2026-06-17T12:00:00.000Z';

function activity(overrides: Partial<RealtimeActivity>): RealtimeActivity {
  return {
    id: overrides.id ?? `a-${Math.random()}`,
    event: overrides.event ?? 'agent.work.step',
    kind: overrides.kind ?? 'agent',
    tone: overrides.tone ?? 'accent',
    title: overrides.title ?? 'Orchy',
    detail: overrides.detail ?? 'Working',
    at: overrides.at ?? baseAt,
    raw: {},
    ...overrides,
  };
}

function observation(overrides: Partial<ObservabilityEvent>): ObservabilityEvent {
  return {
    id: overrides.id ?? `obs-${Math.random()}`,
    workspaceId: 'workspace-1',
    sequenceNumber: 1,
    scopeType: 'workspace',
    scopeId: null,
    kind: overrides.kind ?? 'system',
    status: overrides.status ?? 'progress',
    title: overrides.title ?? 'System update',
    summary: overrides.summary ?? 'Workspace changed.',
    detail: overrides.detail ?? null,
    actorType: null,
    actorId: null,
    targetType: null,
    targetId: null,
    runId: null,
    workflowId: null,
    agentId: null,
    nodeId: null,
    approvalId: null,
    correlationId: null,
    parentEventId: null,
    progress: null,
    evidence: [],
    rawPayloadRedacted: {},
    sourceEvent: 'observability.event',
    createdAt: baseAt,
    ...overrides,
  };
}

describe('workSessions', () => {
  it('groups workflow-backed agent work into the workflow session only', () => {
    const sessions = buildWorkSessions({
      now: Date.parse(baseAt) + 1000,
      activity: [
        activity({
          id: 'step-1',
          runId: 'run-1',
          workflowId: 'workflow-1',
          agentId: 'agent-orchy',
          agentName: 'Orchy',
          detail: 'Qualifying candidate',
        }),
      ],
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'run:run-1',
      workflowId: 'workflow-1',
      agentId: undefined,
      primaryNodeId: 'workflow-workflow-1',
      active: true,
    });
    expect(sessions[0].participantAgentIds).toEqual(['agent-orchy']);

    const live = liveNodeIdsFromSessions(sessions);
    expect([...live.workflowIds]).toEqual(['workflow-1']);
    expect([...live.agentIds]).toEqual([]);
  });

  it('keeps direct agent work first-class when no workflow is involved', () => {
    const sessions = buildWorkSessions({
      now: Date.parse(baseAt) + 1000,
      activity: [
        activity({
          id: 'direct-1',
          agentId: 'agent-hermes',
          agentName: 'hermes',
          conversationId: 'conversation-1',
          clientTurnId: 'turn-1',
          detail: 'Reading the operator request',
        }),
      ],
    });

    expect(sessions[0]).toMatchObject({
      id: 'conversation:conversation-1:turn-1',
      kind: 'agent',
      agentId: 'agent-hermes',
      primaryNodeId: 'agent-agent-hermes',
      active: true,
    });

    const live = liveNodeIdsFromSessions(sessions);
    expect([...live.agentIds]).toEqual(['agent-hermes']);
    expect([...live.workflowIds]).toEqual([]);
  });

  it('terminal events close stale progress for the same session', () => {
    const sessions = buildWorkSessions({
      now: Date.parse(baseAt) + 1000,
      activity: [
        activity({
          id: 'failed',
          runId: 'run-1',
          workflowId: 'workflow-1',
          phase: 'fail',
          tone: 'danger',
          detail: 'Output contract missing location',
        }),
        activity({
          id: 'older',
          runId: 'run-1',
          workflowId: 'workflow-1',
          agentId: 'agent-orchy',
          detail: 'Still qualifying',
          at: '2026-06-17T11:59:59.000Z',
        }),
      ],
    });

    expect(sessions[0].status).toBe('failed');
    expect(sessions[0].active).toBe(false);
    expect(liveNodeIdsFromSessions(sessions).workflowIds.size).toBe(0);
  });

  it('seeds active runs without duplicating participant agents', () => {
    const run: WorkspaceActiveRun = {
      id: 'run-2',
      workflowId: 'workflow-2',
      workflowName: 'Daily Store Report',
      status: 'running',
      currentStep: 'Summarizing evidence',
      startedAt: baseAt,
      stepIndex: 2,
      totalSteps: 5,
      agents: [{ id: 'agent-hermes', name: 'hermes' }],
    };

    const sessions = buildWorkSessions({
      now: Date.parse(baseAt) + 1000,
      activity: [],
      activeRuns: [run],
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'run:run-2',
      title: 'Daily Store Report',
      workflowId: 'workflow-2',
      active: true,
      progress: { completed: 2, total: 5 },
    });
    expect(captionMapFromSessions(sessions).get('workflow-workflow-2')).toBe('Summarizing evidence');
  });

  it('does not seed a live session for an active run that already failed', () => {
    const run: WorkspaceActiveRun = {
      id: 'run-failed',
      workflowId: 'workflow-failed',
      workflowName: 'Catalog Launch Workflow',
      status: 'running',
      currentStep: 'Qualify candidate',
      startedAt: baseAt,
    };

    const sessions = buildWorkSessions({
      now: Date.parse(baseAt) + 1000,
      activity: [],
      activeRuns: [run],
      failedRuns: [{ id: 'run-failed', workflowId: 'workflow-failed', workflowName: 'Catalog Launch Workflow' }],
    });

    expect(sessions).toEqual([]);
  });

  it('keeps completed brain/system observations out of active sessions', () => {
    const sessions = buildWorkSessions({
      now: Date.parse(baseAt) + 1000,
      activity: [],
      observabilityEvents: [
        observation({
          id: 'brain-completed',
          kind: 'system',
          status: 'progress',
          title: 'Brain Dream Pass Completed',
          summary: 'Workspace intelligence changed.',
        }),
      ],
    });

    expect(sessions).toEqual([]);
  });

  it('uses workflow/run identity instead of agent identity for workflow-backed work', () => {
    const sessions = buildWorkSessions({
      now: Date.parse(baseAt) + 1000,
      activity: [
        activity({
          id: 'workflow-step',
          runId: 'run-3',
          workflowId: 'workflow-3',
          agentId: 'agent-orchy',
          agentName: 'Orchy',
          title: 'Orchy',
          detail: 'Fixed the workflow in place',
          raw: { workflowName: 'Catalog Launch Workflow' },
        }),
      ],
    });

    expect(sessions[0].title).toBe('Catalog Launch Workflow');
    expect(sessions[0].agentId).toBeUndefined();
    expect(sessions[0].participantNames).toEqual(['Orchy']);
  });

  it('groups non-workflow observability steps by conversation turn', () => {
    const sessions = buildWorkSessions({
      now: Date.parse(baseAt) + 1000,
      activity: [],
      observabilityEvents: [
        observation({
          id: 'obs-step-1',
          kind: 'agent',
          status: 'progress',
          title: 'Agent working',
          summary: 'Inspecting files',
          agentId: 'agent-codex',
          correlationId: 'turn-1',
          sourceEvent: 'agent.work.step',
          rawPayloadRedacted: {
            conversationId: 'conversation-1',
            clientTurnId: 'turn-1',
          },
        }),
        observation({
          id: 'obs-step-2',
          kind: 'agent',
          status: 'progress',
          title: 'Agent working',
          summary: 'Running tests',
          agentId: 'agent-codex',
          correlationId: 'turn-1',
          sourceEvent: 'agent.work.step',
          rawPayloadRedacted: {
            conversationId: 'conversation-1',
            clientTurnId: 'turn-1',
          },
        }),
      ],
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'conversation:conversation-1:turn-1',
      kind: 'agent',
      agentId: 'agent-codex',
      conversationId: 'conversation-1',
      clientTurnId: 'turn-1',
      active: true,
      detail: 'Running tests',
    });
    expect(sessions[0].events.map((event) => event.detail)).toEqual(['Inspecting files', 'Running tests']);
  });
});
