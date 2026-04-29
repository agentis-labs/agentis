/**
 * WorkflowCanvas barrel + NodePalette — RTL test (Batch 5 / D36).
 *
 * The full WorkflowCanvas experience is implemented inline in
 * `WorkflowCanvasPage` (it owns react-flow state + the run drawer); this
 * spec exercises the spec-named `WorkflowCanvas` barrel re-exports plus
 * the draggable NodePalette which is the canvas' primary input surface.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  WorkflowNode,
  AgentNode,
  NodePalette,
  RunDrawer,
  NODE_GLYPH,
} from '../../src/components/canvas/WorkflowCanvas';
import { PALETTE_NODES } from '../../src/components/canvas/NodePalette';

describe('canvas barrel re-exports', () => {
  it('re-exports the spec-named building blocks', () => {
    expect(typeof WorkflowNode).toBe('function');
    expect(typeof AgentNode).toBe('function');
    expect(typeof NodePalette).toBe('function');
    expect(typeof RunDrawer).toBe('function');
    expect(NODE_GLYPH.trigger).toBeTruthy();
  });
});

describe('<NodePalette />', () => {
  it('renders one button per spec-required node type', () => {
    render(<NodePalette />);
    for (const n of PALETTE_NODES) {
      expect(screen.getByText(n.label)).toBeInTheDocument();
    }
  });

  it('fires onPick(type) when a palette item is clicked', async () => {
    const onPick = vi.fn();
    render(<NodePalette onPick={onPick} />);
    await userEvent.click(screen.getByText('Trigger'));
    expect(onPick).toHaveBeenCalledWith('trigger');
  });

  it('sets the agentis dataTransfer payload on dragstart', () => {
    render(<NodePalette />);
    const triggerBtn = screen.getByText('Trigger').closest('button')!;
    const setData = vi.fn();
    fireEvent.dragStart(triggerBtn, {
      dataTransfer: { setData, effectAllowed: 'none', types: [] },
    });
    expect(setData).toHaveBeenCalledWith('application/x-agentis-node', 'trigger');
  });
});
