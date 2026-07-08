import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatDelta } from '@agentis/core';
import { AgentTurnTrace } from '../../src/components/chat/AgentTurnTrace';
import type { ToolCallData } from '../../src/components/chat/toolCalls';

type Activity = Extract<ChatDelta, { type: 'activity' }>;

function activity(index: number, overrides: Partial<Activity> = {}): Activity {
  return {
    type: 'activity',
    id: `activity-${index}`,
    phase: 'runtime',
    status: 'running',
    label: `Step ${index}`,
    ...overrides,
  };
}

describe('AgentTurnTrace', () => {
  it('writes out the recent thoughts while streaming, latest alive', () => {
    render(
      <AgentTurnTrace
        streaming
        activities={[
          activity(1, { status: 'success', label: 'Reading the run' }),
          activity(2, { status: 'running', label: 'Testing the extension' }),
        ]}
      />,
    );

    // Unlike the old single-line trace, prior thoughts stay visible as they settle.
    expect(screen.getByText('Reading the run')).toBeInTheDocument();
    expect(screen.getByText('Testing the extension')).toBeInTheDocument();
  });

  it('collapses a finished turn into one pill and expands the timeline on click', () => {
    const toolCalls: ToolCallData[] = [
      { id: 't1', name: 'agentis.list_agents', status: 'success', result: { agents: [] } },
      { id: 't2', name: 'agentis.build_workflow', status: 'success', result: { workflowId: 'wf_1' } },
    ];
    render(
      <AgentTurnTrace
        streaming={false}
        turn={{ startedAt: new Date().toISOString(), status: 'completed', durationMs: 4200 }}
        activities={[
          activity(1, { status: 'success', label: 'Reading context' }),
          activity(2, { status: 'success', label: 'Drafting the workflow graph' }),
        ]}
        toolCalls={toolCalls}
      />,
    );

    // Compact summary: "Used 2 tools · 4.2s".
    expect(screen.getByText('Used 2 tools')).toBeInTheDocument();
    expect(screen.getByText('4.2s')).toBeInTheDocument();
    // Timeline detail is hidden until the operator opens it.
    expect(screen.queryByText('Drafting the workflow graph')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    expect(screen.getByText('Drafting the workflow graph')).toBeInTheDocument();
    expect(screen.getByText('agentis.build_workflow')).toBeInTheDocument();
  });

  it('renders nothing for a trivial reply with no real work', () => {
    render(
      <AgentTurnTrace
        streaming={false}
        turn={{ startedAt: new Date().toISOString(), status: 'completed', durationMs: 800 }}
        activities={[activity(1, { status: 'success', label: 'Reading context' })]}
      />,
    );

    expect(screen.queryByTestId('agent-turn-trace')).not.toBeInTheDocument();
  });

  it('surfaces a failed turn even with no tools', () => {
    render(
      <AgentTurnTrace
        streaming={false}
        failed
        turn={{ startedAt: new Date().toISOString(), status: 'failed' }}
        activities={[activity(1, { status: 'error', label: 'Runtime error' })]}
      />,
    );

    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
