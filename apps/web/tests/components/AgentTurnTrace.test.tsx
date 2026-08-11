import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatCommentary, ChatDelta } from '@agentis/core';
import { AgentTurnTrace } from '../../src/components/chat/AgentTurnTrace';
import type { ToolCallData } from '../../src/components/chat/toolCalls';

type Activity = Extract<ChatDelta, { type: 'activity' }>;

function activity(index: number, overrides: Partial<Activity> = {}): Activity {
  return {
    type: 'activity',
    id: `activity-${index}`,
    phase: 'tool',
    status: 'running',
    label: `Step ${index}`,
    ...overrides,
  };
}

describe('AgentTurnTrace', () => {
  it('writes out recent operator-facing activity while streaming, latest alive', () => {
    const commentary: ChatCommentary[] = [{
      id: 'commentary-1',
      text: 'I found the relevant surface and I am tracing its runtime state.',
      source: 'reasoning_summary',
      createdAt: new Date().toISOString(),
    }];
    render(
      <AgentTurnTrace
        streaming
        commentary={commentary}
        activities={[
          activity(1, { status: 'success', label: 'Reading the run' }),
          activity(2, { status: 'running', label: 'Testing the extension' }),
        ]}
      />,
    );

    // Unlike the old single-line trace, prior thoughts stay visible as they settle.
    expect(screen.getByText('Reading the run')).toBeInTheDocument();
    expect(screen.getByText('Testing the extension')).toBeInTheDocument();
    expect(screen.getByText(commentary[0]!.text)).toBeInTheDocument();
  });

  it('hides internal discovery noise and collapses a recovered retry to its latest state', () => {
    render(
      <AgentTurnTrace
        streaming
        commentary={[{
          id: 'commentary-1',
          text: 'The first blueprint was incomplete, so I corrected its acceptance criteria.',
          source: 'assistant_preamble',
          createdAt: new Date().toISOString(),
        }]}
        activities={[
          activity(1, { status: 'success', label: 'Used agentis tools search' }),
          activity(2, { status: 'error', label: 'Failed agentis app plan' }),
          activity(3, { status: 'success', label: 'Used agentis app plan' }),
        ]}
      />,
    );

    expect(screen.queryByText('Used agentis tools search')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed agentis app plan')).not.toBeInTheDocument();
    expect(screen.getByText('Used agentis app plan')).toBeInTheDocument();
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
    expect(screen.getByText('Worked for 4s')).toBeInTheDocument();
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
        activities={[activity(1, { phase: 'runtime', status: 'success', label: 'Reading context' })]}
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

    expect(screen.getByText(/^Work failed/)).toBeInTheDocument();
  });

  it('downgrades a mid-turn error to a softer tone once the agent moves past it, but keeps the last error alarming', () => {
    render(
      <AgentTurnTrace
        streaming={false}
        turn={{ startedAt: new Date().toISOString(), status: 'completed', durationMs: 2000 }}
        activities={[
          activity(1, { status: 'error', label: 'Failed agentis.build_workflow' }),
          activity(2, { status: 'success', label: 'Used agentis.workflow.patch' }),
        ]}
      />,
    );

    // The turn as a whole succeeded — the summary pill must not read "Failed".
    expect(screen.getByText('Worked for 2s')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    const recovered = screen.getByText('Failed agentis.build_workflow');
    expect(recovered.className).toContain('text-warn');
    expect(recovered.className).not.toContain('text-danger');
  });

  it('keeps the alarming treatment when the LAST step is the one that errored', () => {
    render(
      <AgentTurnTrace
        streaming={false}
        failed
        turn={{ startedAt: new Date().toISOString(), status: 'failed' }}
        activities={[
          activity(1, { status: 'success', label: 'Used agentis.capability.load' }),
          activity(2, { status: 'error', label: 'Failed agentis.build_workflow' }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    const stillFailed = screen.getByText('Failed agentis.build_workflow');
    expect(stillFailed.className).toContain('text-danger');
    expect(stillFailed.className).not.toContain('text-warn');
  });
});
