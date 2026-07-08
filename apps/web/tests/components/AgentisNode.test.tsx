/**
 * AgentisNode — RTL component test.
 *
 * The compact icon-first canvas card: assert the title + kind subtitle render,
 * provider identity wins the subtitle for integration/MCP nodes, the trigger
 * branch drops its target handle, and live/pending state surfaces as the
 * corner badge.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { AgentisNode } from '../../src/components/canvas/AgentisNode';

function renderNode(ui: React.ReactElement) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

describe('<AgentisNode />', () => {
  it('renders the title and the kind label subtitle', () => {
    renderNode(
      <AgentisNode data={{ label: 'Fetch signals', kind: 'http_request', type: 'http_request' }} />,
    );
    expect(screen.getByText('Fetch signals')).toBeInTheDocument();
    expect(screen.getByText('HTTP request')).toBeInTheDocument();
  });

  it('prefers provider identity for integration nodes', () => {
    renderNode(
      <AgentisNode
        data={{
          label: 'Post update',
          kind: 'integration',
          type: 'integration',
          integrationId: 'slack',
          operationId: 'send_message',
        }}
      />,
    );
    expect(screen.getByText('slack · send_message')).toBeInTheDocument();
  });

  it('names the server and tool for MCP nodes', () => {
    renderNode(
      <AgentisNode
        data={{ label: 'Insert row', kind: 'mcp', type: 'mcp', toolId: 'mcp__supabase__insert_row' }}
      />,
    );
    expect(screen.getByText('supabase · insert_row')).toBeInTheDocument();
  });

  it('drops the target handle on trigger nodes', () => {
    const { container } = renderNode(
      <AgentisNode data={{ label: 'Start', kind: 'trigger', type: 'trigger' }} />,
    );
    expect(container.querySelectorAll('.react-flow__handle-left')).toHaveLength(0);
    expect(container.querySelectorAll('.react-flow__handle-right')).toHaveLength(1);
  });

  it('shows the needs-setup badge when config is pending', () => {
    renderNode(
      <AgentisNode
        data={{
          label: 'Send email',
          kind: 'integration',
          type: 'integration',
          pendingConfig: true,
          readinessMessage: 'Pick an operation',
        }}
      />,
    );
    const badge = screen.getByLabelText('needs setup');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'Pick an operation');
  });

  it('shows the running badge while live', () => {
    renderNode(
      <AgentisNode
        data={{ label: 'Analyze', kind: 'agent_task', type: 'agent_task', liveStatus: 'running' }}
      />,
    );
    expect(screen.getByLabelText('running')).toBeInTheDocument();
  });

  it('applies the animated halo and indeterminate sweep when running', () => {
    const { container } = renderNode(
      <AgentisNode
        data={{ label: 'Analyze', kind: 'agent_task', type: 'agent_task', liveStatus: 'running' }}
      />,
    );
    const card = container.querySelector('.agentis-workflow-node') as HTMLElement;
    expect(card.className).toContain('agentis-node-running');
    // Running without a known step count shows the gliding sweep segment.
    expect(container.querySelector('.agentis-node-sweep')).not.toBeNull();
  });

  it('shows a determinate loop bar instead of the sweep when progress is known', () => {
    const { container } = renderNode(
      <AgentisNode
        data={{
          label: 'Fan out',
          kind: 'loop',
          type: 'loop',
          liveStatus: 'running',
          liveExtra: { progress: { completed: 2, total: 8 } },
        }}
      />,
    );
    expect(container.querySelector('.agentis-node-sweep')).toBeNull();
  });
});
