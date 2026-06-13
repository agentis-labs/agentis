import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentHierarchyNode, type AgentHierarchyAgent } from '../../src/components/agents/AgentHierarchyNode';

function renderNode(agent: AgentHierarchyAgent) {
  return render(
    <MemoryRouter>
      <ReactFlowProvider>
        <AgentHierarchyNode data={{ agent }} />
      </ReactFlowProvider>
    </MemoryRouter>,
  );
}

const baseAgent: AgentHierarchyAgent = {
  id: 'agent-1',
  name: 'Hermes',
  status: 'online',
  adapterType: 'http',
  runtimeModel: 'gpt-4.1',
  role: 'worker',
  reportsTo: 'manager-1',
  connectionSummary: {
    workflows: [],
    totalWorkflows: 0,
  },
};

describe('<AgentHierarchyNode />', () => {
  it('matches the orchestrator card variant', () => {
    const { asFragment } = renderNode({
      ...baseAgent,
      id: 'orch-1',
      name: 'Workspace Planner',
      role: 'orchestrator',
      reportsTo: null,
    });

    expect(screen.getByText('ORCHESTRATOR')).toBeInTheDocument();
    expect(asFragment()).toMatchSnapshot();
  });

  it('matches the manager card variant with resource chips', () => {
    const { asFragment } = renderNode({
      ...baseAgent,
      id: 'manager-1',
      name: 'Lead Manager',
      role: 'manager',
      reportsTo: null,
      connectionSummary: {
        workflows: [{ id: 'wf-1', name: 'Lead Enrichment', lastRunStatus: 'COMPLETED', lastRunAt: '2026-05-14T12:00:00.000Z' }],
        totalWorkflows: 1,
      },
    });

    expect(screen.getByText('MANAGER')).toBeInTheDocument();
    expect(screen.getByText('Lead Enrichment')).toBeInTheDocument();
    expect(asFragment()).toMatchSnapshot();
  });

  it('matches the unconnected worker card variant', () => {
    const { asFragment } = renderNode({
      ...baseAgent,
      id: 'worker-1',
      name: 'Research Worker',
      reportsTo: null,
    });

    expect(screen.getByText('WORKER')).toBeInTheDocument();
    expect(asFragment()).toMatchSnapshot();
  });
});
