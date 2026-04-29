/**
 * AgentFleetTable — RTL component test (Batch 5 / D36).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  AgentFleetTable,
  type AgentFleetRow,
} from '../../src/components/agents/AgentFleetTable';

function row(over: Partial<AgentFleetRow> = {}): AgentFleetRow {
  return {
    id: 'a1',
    name: 'Hermes',
    adapterType: 'http',
    capabilityTags: ['research'],
    status: 'online',
    colorHex: '#7ad1ff',
    gatewayId: null,
    lastHeartbeatAt: null,
    currentTaskId: null,
    ...over,
  };
}

describe('<AgentFleetTable />', () => {
  it('renders the empty-state row when given an empty list', () => {
    render(
      <MemoryRouter>
        <AgentFleetTable agents={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No agents yet/i)).toBeInTheDocument();
  });

  it('renders one row per agent with name + status + capabilities', () => {
    render(
      <MemoryRouter>
        <AgentFleetTable
          agents={[row(), row({ id: 'a2', name: 'Apollo', status: 'error' })]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Hermes')).toBeInTheDocument();
    expect(screen.getByText('Apollo')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getAllByText(/research/i).length).toBeGreaterThanOrEqual(1);
  });

  it('links each agent name to /agents/:id and the conversation column to /conversations/:id', () => {
    render(
      <MemoryRouter>
        <AgentFleetTable agents={[row()]} />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole('link');
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('/agents/a1');
    expect(hrefs).toContain('/conversations/a1');
  });

  it('renders an em-dash placeholder when capabilityTags is null/empty', () => {
    render(
      <MemoryRouter>
        <AgentFleetTable agents={[row({ capabilityTags: null })]} />
      </MemoryRouter>,
    );
    // First row's "—" should appear in the capabilities + heartbeat cells.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });
});
