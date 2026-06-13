import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunDetailPage } from '../../src/pages/RunDetailPage';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  navigate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    useParams: () => ({ id: 'run-1' }),
  };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api');
  return {
    ...actual,
    api: mocks.api,
    apiErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
    workspace: { get: () => 'ws-1' },
  };
});

vi.mock('../../src/lib/realtime', () => ({
  rtSubscribe: vi.fn(() => vi.fn()),
  useRealtime: vi.fn(),
}));

vi.mock('../../src/components/shared/Toast', () => ({
  useToast: () => ({
    success: mocks.toastSuccess,
    error: mocks.toastError,
  }),
}));

function runDetailFixture() {
  return {
    run: {
      id: 'run-1',
      workflowId: 'wf-1',
      workflowName: 'Daily AI News Insights Digest',
      status: 'failed',
      startedAt: '2026-06-05T12:00:00.000Z',
      finishedAt: '2026-06-05T12:02:00.000Z',
      durationMs: 120000,
      keyMetrics: [
        { label: 'Completed nodes', value: 16 },
        { label: 'Failed nodes', value: 1 },
      ],
      nodes: [
        {
          id: 'fetch-headlines',
          nodeId: 'fetch-headlines',
          title: 'Fetch headlines',
          type: 'http_request',
          kind: 'http_request',
          status: 'completed',
          durationMs: 1400,
          output: { ok: true },
          outputSummary: 'ok',
          inputs: { url: 'https://example.com' },
        },
        {
          id: 'compose-digest',
          nodeId: 'compose-digest',
          title: 'Compose digest',
          type: 'transform',
          kind: 'transform',
          status: 'failed',
          durationMs: 320,
          output: null,
          inputs: { headlines: 12 },
          error: 'expression evaluation failed: nodes is not defined',
        },
      ],
    },
  };
}

function pausedRunDetailFixture() {
  return {
    run: {
      id: 'run-1',
      workflowId: 'wf-1',
      workflowName: 'Daily AI News Insights Digest',
      status: 'paused',
      blockedReason: 'The model account is out of credits. Add credits or switch the agent model, then resume the run.',
      startedAt: '2026-06-05T12:00:00.000Z',
      durationMs: undefined,
      keyMetrics: [
        { label: 'Completed nodes', value: 16 },
        { label: 'Failed nodes', value: 0 },
      ],
      nodes: [
        {
          id: 'compose-digest',
          nodeId: 'compose-digest',
          title: 'Compose digest',
          type: 'agent_task',
          kind: 'agent_task',
          status: 'waiting',
          inputs: { headlines: 12 },
          blockedReason: 'The model account is out of credits. Add credits or switch the agent model, then resume the run.',
        },
      ],
    },
  };
}

describe('<RunDetailPage />', () => {
  let fixture = runDetailFixture;

  beforeEach(() => {
    fixture = runDetailFixture;
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/v1/runs/run-1') return fixture();
      if (path === '/v1/runs/run-1/replay') return { runId: 'run-2', mode: 'replay-from-node' };
      if (path === '/v1/runs/run-1/retry') return { ok: true };
      if (path === '/v1/runs/run-1/resume') return { ok: true, resumed: 1 };
      throw new Error(`Unexpected request: ${path} ${init?.method ?? 'GET'}`);
    });
    mocks.navigate.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  it('surfaces a clear retry-from-failed-node action and navigates to the replayed run', async () => {
    render(<RunDetailPage />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /retry from failed node/i }).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByRole('button', { name: /retry from failed node/i })[0]!);

    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledWith(
        '/v1/runs/run-1/replay',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ mode: 'replay-from-node', targetNodeId: 'compose-digest' }),
        }),
      );
    });
    expect(mocks.navigate).toHaveBeenCalledWith('/runs/run-2');
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Replay started', 'Restarting from Compose digest.');
  });

  it('offers retry-from-this-node inside the failed node inspector', async () => {
    render(<RunDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/what happened/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Compose digest'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry from this node/i })).toBeInTheDocument();
    });
  });

  it('lets an operator resume a paused run', async () => {
    fixture = pausedRunDetailFixture;
    render(<RunDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/action needed/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /resume/i })[0]!);

    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledWith(
        '/v1/runs/run-1/resume',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/^Resuming run/));
  });
});
