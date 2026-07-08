import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OnboardingStrip } from '../../src/components/OnboardingStrip';

const mocks = vi.hoisted(() => ({
  useWorkspaceData: vi.fn(),
  refreshWorkspaceSnapshot: vi.fn(),
}));

vi.mock('../../src/lib/workspaceData', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/workspaceData')>('../../src/lib/workspaceData');
  return {
    ...actual,
    useWorkspaceData: mocks.useWorkspaceData,
    refreshWorkspaceSnapshot: mocks.refreshWorkspaceSnapshot,
  };
});

vi.mock('../../src/components/agents/AgentCreateWizard', () => ({
  AgentCreateWizard: ({ open, initialRole, heading }: { open: boolean; initialRole?: string; heading?: string }) => (
    open ? <div data-testid="agent-create-wizard">{heading ?? initialRole}:{initialRole}</div> : null
  ),
}));

function snapshot(overrides: Partial<ReturnType<typeof baseSnapshot>> = {}) {
  return {
    ...baseSnapshot(),
    ...overrides,
  };
}

function baseSnapshot() {
    return {
      workspaceId: 'ws-1',
      loading: false,
      me: { name: 'Operator' },
      agents: [],
      approvals: [],
      activeRuns: [],
      failedRuns: [],
      artifacts: [],
      fleet: { runs: { active: 0 }, gateways: { total: 1, connected: 1 }, approvals: { pending: 0 } },
      latestActivity: null,
      notifications: [],
      counts: { liveAgents: 0, activeRuns: 0 },
    updatedAt: Date.now(),
  };
}

describe('<OnboardingStrip />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('stays closed until a commission event is dispatched', () => {
    mocks.useWorkspaceData.mockReturnValue(snapshot());

    render(
      <MemoryRouter>
        <OnboardingStrip />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('agent-create-wizard')).toBeNull();
  });

  it('opens the orchestrator wizard on agentis:commission-orchestrator', async () => {
    mocks.useWorkspaceData.mockReturnValue(snapshot());

    render(
      <MemoryRouter>
        <OnboardingStrip />
      </MemoryRouter>,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('agentis:commission-orchestrator'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('agent-create-wizard')).toHaveTextContent('Commission your orchestrator:orchestrator');
    });
  });

  it('opens the manager wizard on agentis:commission-manager', async () => {
    mocks.useWorkspaceData.mockReturnValue(snapshot({
      agents: [{ id: 'orch-1', name: 'Brain', role: 'orchestrator', status: 'online' }],
    }));

    render(
      <MemoryRouter>
        <OnboardingStrip />
      </MemoryRouter>,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('agentis:commission-manager'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('agent-create-wizard')).toHaveTextContent('Commission a manager:manager');
    });
  });
});
