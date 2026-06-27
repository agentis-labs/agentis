import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { WorkStepTrack } from '@agentis/core';
import { StepTrack } from '../../src/components/shared/StepTrack';

const track: WorkStepTrack = {
  steps: [
    { id: '1', label: 'Fetch profile', status: 'done' },
    { id: '2', label: 'Extract metadata', status: 'running' },
    { id: '3', label: 'Save artifact', status: 'pending' },
  ],
  current: 2,
  total: 3,
};

describe('StepTrack', () => {
  it('shows the current step and x/x collapsed, expands the checklist on click', () => {
    render(<StepTrack track={track} />);
    // Collapsed: current (running) step + count, no full list yet.
    expect(screen.getByText('Extract metadata')).toBeTruthy();
    expect(screen.getByText('2/3')).toBeTruthy();
    expect(screen.queryByText('Save artifact')).toBeNull();

    fireEvent.click(screen.getByRole('button'));
    // Expanded: every step label is rendered.
    expect(screen.getByText('Fetch profile')).toBeTruthy();
    expect(screen.getByText('Save artifact')).toBeTruthy();
  });

  it('falls back to a single label + progress when there are no structured steps', () => {
    render(<StepTrack track={null} fallbackLabel="Thinking…" fallbackProgress={{ completed: 1, total: 4 }} />);
    expect(screen.getByText('Thinking…')).toBeTruthy();
    expect(screen.getByText('1/4')).toBeTruthy();
    // No expandable checklist in fallback mode.
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBeNull();
  });
});
