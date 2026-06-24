import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowHealthIndicator } from '../../src/components/canvas/WorkflowHealthIndicator';

const apiMock = vi.fn();
vi.mock('../../src/lib/api', () => ({ api: (...args: unknown[]) => apiMock(...args) }));

describe('WorkflowHealthIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.mockReset();
  });

  it('shows the measured deterministic health summary', async () => {
    apiMock.mockResolvedValue({
      status: 'healthy',
      durationMs: 3.2,
      cacheHit: false,
      nodes: { trigger: { status: 'passed' }, normalize: { status: 'passed' } },
      issues: [],
    });
    render(<WorkflowHealthIndicator workflowId="wf" revision="1" onFocusNode={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await Promise.resolve();
    });
    expect(screen.getByText('Healthy · 2 nodes checked')).toBeInTheDocument();
    expect(screen.getByText('3.2ms')).toBeInTheDocument();
  });

  it('never reads "Ready" when steps are only mocked — surfaces them as unverified', async () => {
    apiMock.mockResolvedValue({
      status: 'unverified',
      durationMs: 4.1,
      cacheHit: false,
      nodes: { trigger: { status: 'passed' }, scrape: { status: 'mocked' }, deliver: { status: 'mocked' } },
      issues: [],
    });
    render(<WorkflowHealthIndicator workflowId="wf" revision="1" onFocusNode={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await Promise.resolve();
    });
    expect(screen.getByText('Unverified · 2 steps need a real run')).toBeInTheDocument();
    expect(screen.queryByText(/Ready/)).not.toBeInTheDocument();
  });

  it('renders a blocked verdict with the issue remediation', async () => {
    apiMock.mockResolvedValue({
      status: 'blocked',
      durationMs: 2.0,
      cacheHit: false,
      nodes: { ext: { status: 'failed' } },
      issues: [{
        code: 'EXTENSION_SOURCE_INVALID',
        severity: 'error',
        nodeId: 'ext',
        nodeTitle: 'Scrape',
        message: 'Extension source uses `require(...)`, which the extension sandbox does not provide.',
        remediation: 'The extension sandbox has no `require`. Use ctx.http.fetch.',
      }],
    });
    render(<WorkflowHealthIndicator workflowId="wf" revision="1" onFocusNode={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
      await Promise.resolve();
    });
    expect(screen.getByText('Blocked · 1 issue to fix')).toBeInTheDocument();
  });
});
