import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPlanCanvas, extractAgentPlan } from '../../src/components/chat/ChatPlanCanvas';

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: React.ReactNode }) => <div data-testid="react-flow">{children}</div>,
  Controls: ({ children }: { children?: React.ReactNode }) => <div role="toolbar">{children}</div>,
  ControlButton: ({ children }: { children?: React.ReactNode }) => <button type="button">{children}</button>,
  MiniMap: () => <div data-testid="minimap" />,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));

const agentPlan = `# Perfect Ads Researcher Workflow

## Intake and scope
- Capture product, market, goal, budget, geos, and constraints.
- Convert the brief into research questions.

## Evidence gathering
- Pull competitor ads, landing pages, offers, hooks, and creative patterns.
- Score claims against source quality.

## Synthesis and QA
- Produce angles, gaps, risks, and testable recommendations.
- Verify every insight has a cited artifact.`;

describe('extractAgentPlan', () => {
  it('extracts only the proposed plan body from an agent answer', () => {
    const parsed = extractAgentPlan(`Here is the direction.\n\n<proposed_plan>\n${agentPlan}\n</proposed_plan>\n\nReady to refine.`);

    expect(parsed).toEqual({
      before: 'Here is the direction.',
      planText: agentPlan,
      after: 'Ready to refine.',
    });
  });

  it('ignores normal messages without a proposed plan block', () => {
    expect(extractAgentPlan('Just a normal agent answer.')).toBeNull();
  });
});

describe('<ChatPlanCanvas />', () => {
  it('renders a lightweight read-only plan canvas without approval controls', () => {
    render(<ChatPlanCanvas planText={agentPlan} />);

    expect(screen.getByText('Agent plan')).toBeInTheDocument();
    expect(screen.getByText('3 mapped sections')).toBeInTheDocument();
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('lets the operator switch to the raw agent-authored plan text', async () => {
    const user = userEvent.setup();
    render(<ChatPlanCanvas planText={agentPlan} />);

    await user.click(screen.getByRole('button', { name: 'Show plan text' }));

    expect(screen.getByText('Evidence gathering')).toBeInTheDocument();
    expect(screen.getByText(/Pull competitor ads/)).toBeInTheDocument();
  });
});
