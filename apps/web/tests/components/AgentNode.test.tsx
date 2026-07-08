/**
 * AgentNode — RTL component test (Batch 5 / D36).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { AgentNode } from '../../src/components/canvas/AgentNode';

function renderNode(ui: React.ReactElement) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

describe('<AgentNode />', () => {
  it('renders the label and the agent · name subtitle', () => {
    renderNode(
      <AgentNode
        data={{
          label: 'Plan trip',
          type: 'agent_task',
          agentName: 'Hermes',
          agentColorHex: '#7ad1ff',
        }}
      />,
    );
    expect(screen.getByText('Plan trip')).toBeInTheDocument();
    expect(screen.getByText(/agent · Hermes/i)).toBeInTheDocument();
  });

  it('falls back to the type label when no agent name is bound', () => {
    renderNode(<AgentNode data={{ label: 'X', type: 'agent_task' }} />);
    expect(screen.getByText('agent_task')).toBeInTheDocument();
  });

  it('paints the glyph with the agent color when one is provided', () => {
    const { container } = renderNode(
      <AgentNode
        data={{ label: 'X', type: 'agent_task', agentColorHex: '#ff00aa' }}
      />,
    );
    const glyph = container.querySelector('.rounded-node span[style]') as HTMLElement;
    expect(glyph.style.color).toBeTruthy();
    // jsdom normalises #ff00aa33 to rgba(255, 0, 170, 0.2).
    expect(glyph.style.background).toMatch(/rgba\(255,\s*0,\s*170/);
  });
});
