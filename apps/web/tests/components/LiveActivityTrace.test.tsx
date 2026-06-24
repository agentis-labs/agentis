import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChatDelta } from '@agentis/core';
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

describe('LiveActivityTrace', () => {
  it('shows live runtime activity instead of an empty streaming card', () => {
    render(
      <LiveActivityTrace
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

    expect(screen.getByText('Waiting for Hermes')).toBeInTheDocument();
    expect(screen.queryByText('The provider is still working.')).not.toBeInTheDocument();
  });

  it('hides completed successful activity from the final transcript', () => {
    render(
      <LiveActivityTrace
        activities={[
          activity(1, { phase: 'context', status: 'success', label: 'Inspected context' }),
          activity(2, { phase: 'tool', status: 'success', label: 'Read files' }),
          activity(3, { phase: 'complete', status: 'success', label: 'Response ready' }),
        ]}
        turn={{ startedAt: new Date().toISOString(), status: 'completed', durationMs: 12_000 }}
        streaming={false}
      />,
    );

    expect(screen.queryByTestId('live-activity-trace')).not.toBeInTheDocument();
  });

  it('keeps stop control out of the activity trace', () => {
    render(
      <LiveActivityTrace
        activities={[activity(1, { phase: 'waiting', label: 'Waiting for runtime' })]}
        streaming
      />,
    );

    expect(screen.getByText('Waiting for runtime')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop agent response' })).not.toBeInTheDocument();
  });

  it('shows only the latest meaningful step while streaming', () => {
    render(
      <LiveActivityTrace
        activities={[
          activity(1, { phase: 'runtime', status: 'success', label: 'Inspecting the failed run', detail: 'Old detail' }),
          activity(2, { phase: 'tool', status: 'running', label: 'Testing the extension', detail: 'Current detail' }),
        ]}
        streaming
      />,
    );

    expect(screen.getByText('Testing the extension')).toBeInTheDocument();
    expect(screen.queryByText('Inspecting the failed run')).not.toBeInTheDocument();
    expect(screen.queryByText(/Old detail|Current detail/)).not.toBeInTheDocument();
  });
});
