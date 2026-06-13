import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatDelta } from '@agentis/core';
import { ChatActivityTranscript } from '../../src/components/chat/ChatActivityTranscript';
import { LiveActivityTrace } from '../../src/components/chat/LiveActivityTrace';

type Activity = Extract<ChatDelta, { type: 'activity' }>;

function activity(index: number, overrides: Partial<Activity> = {}): Activity {
  return {
    type: 'activity',
    id: `activity-${index}`,
    phase: 'runtime',
    status: 'running',
    label: `Step ${index}`,
    detail: `Detail ${index}`,
    ...overrides,
  };
}

describe('ChatActivityTranscript', () => {
  it('shows only three loading dots when there is no real model thinking', () => {
    render(
      <ChatActivityTranscript
        activities={[
          activity(1, { phase: 'received', label: 'Request received' }),
          activity(2, { phase: 'context', label: 'Canvas context' }),
          activity(3, { phase: 'workflow', label: 'Building the workflow' }),
        ]}
        toolCalls={[{ id: 'build', name: 'agentis.build_workflow', status: 'running' }]}
        streaming
      />,
    );

    expect(screen.getByTestId('chat-activity-loading')).toBeInTheDocument();
    expect(screen.getByTestId('chat-loading-dots').children).toHaveLength(3);
    expect(screen.queryByText(/Request received|Canvas context|Building the workflow/i)).not.toBeInTheDocument();
  });

  it('renders only real streamed thinking and never operational logs', () => {
    render(
      <ChatActivityTranscript
        thinking={'I need a persistent source for new posts.\n\nThe workflow should deduplicate matches before email delivery.'}
        activities={[
          activity(1, { phase: 'tool', label: 'Extension created' }),
          activity(2, { phase: 'workflow', label: 'Build blocked' }),
        ]}
        toolCalls={[{
          id: 'tool-workflow',
          name: 'agentis.build_workflow',
          status: 'error',
          error: 'The operation was aborted',
        }]}
        streaming
      />,
    );

    expect(screen.getByText('I need a persistent source for new posts.')).toBeInTheDocument();
    expect(screen.getByText('The workflow should deduplicate matches before email delivery.')).toBeInTheDocument();
    expect(screen.queryByText(/Extension created|Build blocked|operation was aborted/i)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('chat-loading-dots')).toHaveLength(1);
  });

  it('collapses completed real thinking without timing telemetry', () => {
    render(
      <ChatActivityTranscript
        thinking="I checked the requested output format."
        turn={{ status: 'completed', durationMs: 45_000 }}
        streaming={false}
      />,
    );

    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.queryByText(/Completed in|Still working after|45s/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand thinking' }));
    expect(screen.getByText('I checked the requested output format.')).toBeInTheDocument();
  });

  it('renders no transcript after completion when only tool telemetry exists', () => {
    render(
      <ChatActivityTranscript
        activities={[activity(1, { phase: 'workflow', status: 'success', label: 'Workflow ready' })]}
        toolCalls={[{ id: 'build', name: 'agentis.build_workflow', status: 'success' }]}
        streaming={false}
      />,
    );

    expect(screen.queryByTestId('chat-activity-transcript')).not.toBeInTheDocument();
    expect(screen.queryByText(/Workflow ready|Completed|Failed/i)).not.toBeInTheDocument();
  });
});

describe('LiveActivityTrace', () => {
  it('shows live runtime activity instead of an empty streaming card', () => {
    render(
      <LiveActivityTrace
        text=""
        activities={[
          activity(1, {
            phase: 'waiting',
            label: 'Waiting for Hermes',
            detail: 'The provider is still working.',
          }),
        ]}
        turn={{ startedAt: new Date().toISOString(), status: 'running' }}
        streaming
      />,
    );

    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByText('Waiting for Hermes')).toBeInTheDocument();
    expect(screen.getByText('The provider is still working.')).toBeInTheDocument();
  });

  it('lets the operator stop a silent runtime turn', () => {
    const onStop = vi.fn();
    render(
      <LiveActivityTrace
        text=""
        activities={[activity(1, { phase: 'waiting', label: 'Waiting for runtime' })]}
        streaming
        onStop={onStop}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop agent response' }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
