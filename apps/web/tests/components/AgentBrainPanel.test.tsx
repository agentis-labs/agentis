import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBrainPanel } from '../../src/components/brain/AgentBrainPanel';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
}));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api');
  return { ...actual, api: mocks.api };
});

vi.mock('../../src/components/brain/ScopedBrainMap', () => ({
  ScopedBrainMap: () => <div data-testid="agent-brain-map">map</div>,
}));

vi.mock('../../src/components/agents/AgentAbilitiesPanel', () => ({
  AgentAbilitiesPanel: ({ agentId }: { agentId: string }) => <div data-testid="agent-abilities-panel">{agentId}</div>,
}));

describe('<AgentBrainPanel />', () => {
  beforeEach(() => {
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/v1/agents') {
        return { agents: [{ id: 'agent-1', name: 'Codex Orch', role: 'orchestrator' }] };
      }
      if (path === '/v1/brain/agents/agent-1/memory' && (!init?.method || init.method === 'GET')) {
        return { entries: [] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it('shows Map, Memory, and Abilities views and switches into abilities mode', async () => {
    render(
      <MemoryRouter>
        <AgentBrainPanel />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /Map/i })).toBeInTheDocument());
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/v1/brain/agents/agent-1/memory'));

    expect(screen.getByRole('button', { name: /Memory/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Abilities/i })).toBeInTheDocument();
    expect(screen.getByTestId('agent-brain-map')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Abilities/i }));
    await waitFor(() => expect(screen.getByTestId('agent-abilities-panel')).toHaveTextContent('agent-1'));

    fireEvent.click(screen.getByRole('button', { name: /Memory/i }));
    await waitFor(() => expect(screen.getByPlaceholderText('Add a lesson or operating note for this agent...')).toBeInTheDocument());
  });
});
