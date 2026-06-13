/**
 * WorkflowNode — RTL component test (Batch 5 / D36).
 *
 * Pure presentation; we assert glyph + label + type render and the
 * trigger-kind branch picks up the accent border styling.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { WorkflowNode, NODE_GLYPH } from '../../src/components/canvas/WorkflowNode';

function renderNode(ui: React.ReactElement) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

describe('<WorkflowNode />', () => {
  it('renders the label, type, and the kind glyph', () => {
    renderNode(
      <WorkflowNode
        data={{ label: 'Run echo', kind: 'extension_task', type: 'extension_task' }}
      />,
    );
    expect(screen.getByText('Run echo')).toBeInTheDocument();
    expect(screen.getByText('extension_task')).toBeInTheDocument();
    expect(screen.getByText(NODE_GLYPH.extension_task!)).toBeInTheDocument();
  });

  it('falls back to the bullet glyph for an unknown kind', () => {
    renderNode(<WorkflowNode data={{ label: 'X', kind: 'mystery', type: 'mystery' }} />);
    expect(screen.getByText('•')).toBeInTheDocument();
  });

  it('exposes the trigger accent shadow class for trigger-kind nodes', () => {
    const { container } = renderNode(
      <WorkflowNode data={{ label: 'Start', kind: 'trigger', type: 'trigger' }} />,
    );
    const root = container.querySelector('.rounded-node') as HTMLElement;
    expect(root.className).toMatch(/border-accent\/60/);
    expect(root.className).toMatch(/shadow-glow/);
  });

  it('uses neutral border on non-trigger nodes', () => {
    const { container } = renderNode(
      <WorkflowNode data={{ label: 'M', kind: 'merge', type: 'merge' }} />,
    );
    const root = container.querySelector('.rounded-node') as HTMLElement;
    expect(root.className).toMatch(/border-line/);
    expect(root.className).not.toMatch(/border-accent\/60/);
  });
});
