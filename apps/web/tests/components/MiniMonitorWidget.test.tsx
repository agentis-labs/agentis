import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MiniMonitorWidget } from '../../src/components/MiniMonitorWidget';
import { useChatPanelStore } from '../../src/components/chat/ChatPanelStore';

const mocks = vi.hoisted(() => ({
  useWorkspaceData: vi.fn(),
  api: vi.fn(),
}));

vi.mock('../../src/lib/workspaceData', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/workspaceData')>('../../src/lib/workspaceData');
  return {
    ...actual,
    useWorkspaceData: mocks.useWorkspaceData,
    refreshWorkspaceSnapshot: vi.fn(),
  };
});

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api');
  return {
    ...actual,
    api: mocks.api,
  };
});

vi.mock('../../src/lib/realtime', () => ({
  rtSubscribe: vi.fn(() => vi.fn()),
  useRealtime: vi.fn(),
}));

vi.mock('../../src/components/chat/usePrimaryChatScopes', () => ({
  usePrimaryChatScopes: () => ({
    orchestrator: { id: 'orch-1', name: 'Workspace Orchestrator', role: 'orchestrator' },
  }),
}));

function snapshot() {
  return {
    workspaceId: 'ws-1',
    loading: false,
    me: { name: 'Operator' },
    agents: [{ id: 'orch-1', name: 'Workspace Orchestrator', role: 'orchestrator', status: 'online' }],
    approvals: [{ id: 'approval-1', agentName: 'Workspace Orchestrator', summary: 'Approve the latest send?', createdAt: new Date().toISOString() }],
    activeRuns: [{ id: 'run-1', workflowId: 'wf-1', workflowName: 'Daily brief', status: 'RUNNING', currentStep: 'Summarizing', startedAt: new Date().toISOString() }],
    failedRuns: [],
    artifacts: [],
    spaces: [],
    fleet: { runs: { active: 1 }, gateways: { total: 1, connected: 1 }, approvals: { pending: 1 } },
    latestActivity: null,
    notifications: [{ id: 'n1', type: 'approval', title: 'Approval needed', context: 'Approve the latest send?', timestamp: new Date().toISOString() }],
    counts: { liveAgents: 1, activeRuns: 1 },
    updatedAt: Date.now(),
  };
}

describe('<MiniMonitorWidget />', () => {
  beforeEach(() => {
    mocks.useWorkspaceData.mockReturnValue(snapshot());
    mocks.api.mockResolvedValue({ ok: true });
    useChatPanelStore.getState().setState('hidden');
    useChatPanelStore.getState().selectThread(null);
  });

  it('renders live counts and the top approval when opened', () => {
    render(<MiniMonitorWidget open onClose={() => undefined} />);

    expect(screen.getByText(/^mini monitor$/i)).toBeInTheDocument();
    expect(screen.getByText(/needs operator/i)).toBeInTheDocument();
    expect(screen.getAllByText(/daily brief/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('sends a quick prompt to the orchestrator and docks chat', async () => {
    render(<MiniMonitorWidget open onClose={() => undefined} />);

    fireEvent.change(screen.getByPlaceholderText(/ask the orchestrator/i), { target: { value: 'Give me a status check.' } });
    fireEvent.click(screen.getByRole('button', { name: /send monitor prompt/i }));

    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledWith('/v1/conversations/orchestrator/send', expect.objectContaining({ method: 'POST' }));
    });
    expect(useChatPanelStore.getState().state).toBe('docked');
    expect(useChatPanelStore.getState().selectedThread).toMatchObject({ id: 'orch-1', kind: 'agent' });
  });
});