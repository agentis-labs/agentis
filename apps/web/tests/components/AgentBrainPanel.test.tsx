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

vi.mock('../../src/components/knowledge/KnowledgeTab', () => ({
  KnowledgeTab: ({ scopeId }: { scopeId: string }) => <div data-testid="agent-knowledge-tab">{scopeId}</div>,
}));

vi.mock('../../src/components/brain/SkillsTab', () => ({
  SkillsTab: ({ scopeId }: { scopeId: string }) => <div data-testid="agent-skills-tab">{scopeId}</div>,
}));

vi.mock('../../src/components/brain/ExamplesTab', () => ({
  ExamplesTab: ({ scopeId }: { scopeId: string }) => <div data-testid="agent-examples-tab">{scopeId}</div>,
}));

vi.mock('../../src/components/knowledge/WorkspaceMemoryTab', () => ({
  WorkspaceMemoryTab: ({ scopeId }: { scopeId: string }) => <div data-testid="agent-memory-tab">{scopeId}</div>,
}));

vi.mock('../../src/components/knowledge/EpisodesTab', () => ({
  EpisodesTab: ({ agentId }: { agentId: string }) => <div data-testid="agent-episodes-tab">{agentId}</div>,
}));

describe('<AgentBrainPanel />', () => {
  beforeEach(() => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/v1/agents') {
        return { agents: [{ id: 'agent-1', name: 'Codex Orch', role: 'orchestrator' }] };
      }
      if (path === '/v1/memory/episodes?agentId=agent-1&limit=200') {
        return { episodes: [] };
      }
      if (path === '/v1/skills?scopeId=agent-1&includeWorkspace=false') {
        return { skills: [] };
      }
      if (path === '/v1/brain/scopes/agent-1/visibility') {
        return { surfacedInWorkspace: true };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  it('shows agent-owned Brain views and switches into scoped tabs', async () => {
    render(
      <MemoryRouter>
        <AgentBrainPanel />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /Map/i })).toBeInTheDocument());
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/v1/memory/episodes?agentId=agent-1&limit=200'));

    expect(screen.getByRole('button', { name: /Memory/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Knowledge/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Skills/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Examples/i })).toBeInTheDocument();
    expect(screen.getByTestId('agent-brain-map')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Knowledge/i }));
    await waitFor(() => expect(screen.getByTestId('agent-knowledge-tab')).toHaveTextContent('agent-1'));

    fireEvent.click(screen.getByRole('button', { name: /Skills/i }));
    await waitFor(() => expect(screen.getByTestId('agent-skills-tab')).toHaveTextContent('agent-1'));

    fireEvent.click(screen.getByRole('button', { name: /Examples/i }));
    await waitFor(() => expect(screen.getByTestId('agent-examples-tab')).toHaveTextContent('agent-1'));

    fireEvent.click(screen.getByRole('button', { name: /Memory/i }));
    await waitFor(() => expect(screen.getByTestId('agent-memory-tab')).toHaveTextContent('agent-1'));
    expect(screen.getByTestId('agent-episodes-tab')).toHaveTextContent('agent-1');
  });

  it('shows imported skills in the provider strip separately from pulled memories', async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/v1/memory/episodes?agentId=agent-1&limit=200') return { episodes: [] };
      if (path === '/v1/skills?scopeId=agent-1&includeWorkspace=false') return { skills: Array.from({ length: 16 }, (_, index) => ({ id: `skill-${index}` })) };
      if (path === '/v1/brain/scopes/agent-1/visibility') return { surfacedInWorkspace: true };
      throw new Error(`Unexpected request: ${path}`);
    });

    render(
      <MemoryRouter>
        <AgentBrainPanel
          agents={[{ id: 'agent-1', name: 'Hermes', role: 'worker', importOrigin: { adapterType: 'hermes_agent', externalId: 'hermes:local' } }]}
          selectedAgentId="agent-1"
          importUpdates={[]}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('0 memories pulled')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('16 skills pushed')).toBeInTheDocument());
    expect(mocks.api).not.toHaveBeenCalledWith('/v1/harness/import/updates');
  });
});
