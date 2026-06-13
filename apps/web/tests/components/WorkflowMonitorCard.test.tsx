import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_EVENTS } from '@agentis/core';

const realtime = vi.hoisted(() => ({
  handler: null as null | ((env: { event: string; payload: unknown; emittedAt: string }) => void),
}));

vi.mock('../../src/lib/realtime', () => ({
  rtSubscribe: () => () => undefined,
  useRealtime: (_events: string[], handler: typeof realtime.handler) => {
    realtime.handler = handler;
  },
}));

vi.mock('../../src/lib/api', () => ({
  api: vi.fn(async () => ({ activity: [] })),
}));

vi.mock('../../src/lib/workspaceData', () => ({
  useWorkspaceData: () => ({ workspaceId: 'workspace-1', approvals: [] }),
  refreshWorkspaceSnapshot: vi.fn(async () => undefined),
}));

import { WorkflowMonitorCard } from '../../src/components/canvas/WorkflowMonitorCard';

function emit(event: string, payload: Record<string, unknown>) {
  act(() => realtime.handler?.({ event, payload, emittedAt: '2026-06-09T12:00:00.000Z' }));
}

describe('WorkflowMonitorCard', () => {
  beforeEach(() => {
    realtime.handler = null;
  });

  it('deduplicates node activity and latches a non-animated completed state', async () => {
    render(
      <WorkflowMonitorCard
        workflowId="workflow-1"
        workflowTitle="Daily digest"
        activeRunId="run-1"
        nodeTitles={new Map([['node-1', 'Send email']])}
        onFocusNode={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    await act(async () => undefined);

    emit(REALTIME_EVENTS.NODE_STARTED, {
      workflowId: 'workflow-1',
      runId: 'run-1',
      nodeId: 'node-1',
    });
    emit(REALTIME_EVENTS.NODE_COMPLETED, {
      workflowId: 'workflow-1',
      runId: 'run-1',
      nodeId: 'node-1',
      outputPreview: 'Email sent',
    });

    expect(screen.getAllByText('Send email')).toHaveLength(1);

    emit(REALTIME_EVENTS.RUN_COMPLETED, {
      workflowId: 'workflow-1',
      runId: 'run-1',
      summary: 'Done',
    });

    expect(screen.getByText('Run completed')).toBeInTheDocument();
    expect(screen.queryByText(/Realtime monitor|Events|Review|1m|seconds/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-realtime-monitor').querySelector('.animate-pulse')).toBeNull();
  });

  it('treats canvas build completion as terminal and removes the stop control', async () => {
    render(
      <WorkflowMonitorCard
        workflowId="workflow-1"
        workflowTitle="Daily digest"
        activeRunId="build-1"
        nodeTitles={new Map()}
        onFocusNode={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    await act(async () => undefined);

    emit(REALTIME_EVENTS.AGENT_WORK_STEP, {
      workflowId: 'workflow-1',
      runId: 'build-1',
      agentId: 'agent-1',
      description: 'Drafting the workflow',
    });
    emit(REALTIME_EVENTS.AGENT_WORK_STEP, {
      workflowId: 'workflow-1',
      runId: 'build-1',
      agentId: 'agent-1',
      description: 'Workflow ready',
    });
    emit(REALTIME_EVENTS.CANVAS_BUILD_COMPLETE, {
      workflowId: 'workflow-1',
      runId: 'build-1',
      nodeCount: 12,
      edgeCount: 11,
    });

    expect(screen.getAllByText('Workflow ready').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open run drawer' })).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-realtime-monitor').querySelector('.animate-pulse')).toBeNull();
    expect(screen.queryByText('Agent update')).not.toBeInTheDocument();
  });
});
