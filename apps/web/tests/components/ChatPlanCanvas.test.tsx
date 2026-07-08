import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPlanCanvas, extractAgentPlan, type ArchitectureCanvasPayload } from '../../src/components/chat/ChatPlanCanvas';

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: React.ReactNode }) => <div data-testid="react-flow">{children}</div>,
  Controls: ({ children }: { children?: React.ReactNode }) => <div role="toolbar">{children}</div>,
  ControlButton: ({ children }: { children?: React.ReactNode }) => <button type="button">{children}</button>,
  MiniMap: () => <div data-testid="minimap" />,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right' },
  SelectionMode: { Partial: 'partial' },
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));

const agentPlan = `# Perfect Ads Researcher Workflow

## Summary
- Build a research workflow for paid ads.

## Implementation
- Draft the workflow, validate it, and test it.`;

const architecture: ArchitectureCanvasPayload = {
  kind: 'workflow',
  nodes: [
    { id: 'intake', title: 'Campaign brief intake', role: 'trigger', kind: 'manual', summary: 'Collect product and market constraints.' },
    { id: 'research', title: 'Competitor research', role: 'agent', kind: 'specialist', summary: 'Gather ads, hooks, and landing pages.' },
    { id: 'qa', title: 'Evidence validator', role: 'validator', summary: 'Check that every recommendation cites evidence.' },
  ],
  edges: [
    { source: 'intake', target: 'research', label: 'brief' },
    { source: 'research', target: 'qa', label: 'findings' },
  ],
  groups: [{ id: 'phase-research', title: 'Research phase' }],
};

describe('extractAgentPlan', () => {
  it('extracts the proposed plan and architecture canvas separately', () => {
    const parsed = extractAgentPlan(`Here is the direction.

<architecture_canvas>
${JSON.stringify(architecture)}
</architecture_canvas>

<proposed_plan>
${agentPlan}
</proposed_plan>

Ready to refine.`);

    expect(parsed).toEqual({
      before: 'Here is the direction.',
      planText: agentPlan,
      after: 'Ready to refine.',
      architecture,
    });
  });

  it('ignores normal messages without a proposed plan block', () => {
    expect(extractAgentPlan('Just a normal agent answer.')).toBeNull();
  });

  it('ignores invalid architecture JSON while preserving the plan', () => {
    const parsed = extractAgentPlan(`<architecture_canvas>{ nope }</architecture_canvas>
<proposed_plan>
${agentPlan}
</proposed_plan>`);

    expect(parsed?.architecture).toBeNull();
    expect(parsed?.planText).toBe(agentPlan);
  });
});

describe('<ChatPlanCanvas />', () => {
  it('renders a read-only architecture canvas from explicit architecture payload', () => {
    render(<ChatPlanCanvas planText={agentPlan} architecture={architecture} />);

    expect(screen.getByText('Workflow architecture')).toBeInTheDocument();
    expect(screen.getByText('3 preview nodes')).toBeInTheDocument();
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('lets the operator switch to the raw agent-authored plan text', async () => {
    const user = userEvent.setup();
    render(<ChatPlanCanvas planText={agentPlan} architecture={architecture} />);

    await user.click(screen.getByRole('button', { name: 'Show plan text' }));

    expect(screen.getByText('Implementation')).toBeInTheDocument();
    expect(screen.getByText(/Draft the workflow/)).toBeInTheDocument();
  });

  it('does not invent a canvas from proposed plan markdown alone', () => {
    render(<ChatPlanCanvas planText={agentPlan} architecture={null} />);

    expect(screen.getByText('Agent plan')).toBeInTheDocument();
    expect(screen.getByText('Plan text')).toBeInTheDocument();
    expect(screen.queryByTestId('react-flow')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show architecture canvas' })).toBeNull();
  });
});
