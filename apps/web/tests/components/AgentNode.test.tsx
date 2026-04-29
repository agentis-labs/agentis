/**
 * AgentNode — RTL component test (Batch 5 / D36).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentNode } from '../../src/components/canvas/AgentNode';

describe('<AgentNode />', () => {
  it('renders the label and the agent · name subtitle', () => {
    render(
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
    render(<AgentNode data={{ label: 'X', type: 'agent_task' }} />);
    expect(screen.getByText('agent_task')).toBeInTheDocument();
  });

  it('paints the glyph with the agent color when one is provided', () => {
    const { container } = render(
      <AgentNode
        data={{ label: 'X', type: 'agent_task', agentColorHex: '#ff00aa' }}
      />,
    );
    const glyph = container.querySelector('span[style]') as HTMLElement;
    expect(glyph.style.color).toBeTruthy();
    // jsdom normalises #ff00aa33 to rgba(255, 0, 170, 0.2).
    expect(glyph.style.background).toMatch(/rgba\(255,\s*0,\s*170/);
  });
});
