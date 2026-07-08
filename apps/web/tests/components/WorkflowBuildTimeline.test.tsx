/**
 * WorkflowBuildTimeline — inspectable, live build narration (10X-CREATION §6).
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { REALTIME_EVENTS } from '@agentis/core';

// Capture the useRealtime handlers so the test can drive realtime events.
const h = vi.hoisted(() => ({ handlers: {} as Record<string, (env: { event: string; payload: unknown }) => void> }));
vi.mock('../../src/lib/realtime', () => ({
  useRealtime: (events: string[], handler: (env: { event: string; payload: unknown }) => void) => {
    for (const e of events) h.handlers[e] = handler;
  },
}));

import { WorkflowBuildTimeline } from '../../src/components/chat/WorkflowBuildTimeline';

function emit(event: string, payload: unknown) {
  act(() => h.handlers[event]?.({ event, payload }));
}

describe('<WorkflowBuildTimeline />', () => {
  it('streams phases, repairs and critiques for its runId; ignores others', () => {
    render(<WorkflowBuildTimeline runId="r1" />);
    // Nothing until the first phase event.
    expect(screen.queryByText(/Build trace/i)).toBeNull();

    emit(REALTIME_EVENTS.WORKFLOW_BUILD_PHASE, { runId: 'r1', phase: 'drafting', detail: 'Synthesized with the orchestrator model' });
    expect(screen.getByText(/Build trace/i)).toBeInTheDocument();
    expect(screen.getByText(/Drafting the graph/i)).toBeInTheDocument();
    expect(screen.getByText(/Synthesized with the orchestrator model/i)).toBeInTheDocument();

    emit(REALTIME_EVENTS.WORKFLOW_BUILD_REPAIR, { runId: 'r1', repair: { rule: 3, kind: 'delivery_node_added', message: 'Added a gmail delivery node' } });
    expect(screen.getByText(/Rule 3/)).toBeInTheDocument();
    expect(screen.getByText(/Added a gmail delivery node/)).toBeInTheDocument();

    emit(REALTIME_EVENTS.WORKFLOW_BUILD_CRITIQUE, { runId: 'r1', critique: { rule: 4, severity: 'warn', message: 'Fetching should use http_request' } });
    expect(screen.getByText(/Rule 4/)).toBeInTheDocument();

    // An event for a different build is ignored.
    emit(REALTIME_EVENTS.WORKFLOW_BUILD_REPAIR, { runId: 'r2', repair: { rule: 13, kind: 'recurring_state_added', message: 'IGNORED OTHER BUILD' } });
    expect(screen.queryByText(/IGNORED OTHER BUILD/)).toBeNull();

    emit(REALTIME_EVENTS.WORKFLOW_BUILD_PHASE, { runId: 'r1', phase: 'complete', detail: '5 node(s), 1 repair(s), 1 critique(s)' });
    expect(screen.getByText(/Complete/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Build complete/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows a clear refusal when the build is blocked (AI-only, no model)', () => {
    render(<WorkflowBuildTimeline runId="rb" />);
    emit(REALTIME_EVENTS.WORKFLOW_BUILD_PHASE, { runId: 'rb', phase: 'blocked', detail: 'No orchestrator model is configured' });
    expect(screen.getByText(/Couldn't build this workflow/i)).toBeInTheDocument();
    expect(screen.getByText(/No orchestrator model is configured/i)).toBeInTheDocument();
  });
});
