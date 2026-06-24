import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children: React.ReactNode }) => <div data-testid="react-flow">{children}</div>,
  Controls: ({ children }: { children?: React.ReactNode }) => <div role="toolbar">{children}</div>,
  ControlButton: ({
    children,
    onClick,
    title,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    title?: string;
    'aria-label'?: string;
  }) => (
    <button type="button" onClick={onClick} title={title} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  MiniMap: () => <div data-testid="minimap" />,
  Background: () => null,
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));

import { CanvasEngine } from '../../src/components/canvas/CanvasEngine';

describe('CanvasEngine', () => {
  it('keeps minimap hidden by default and places tidy in canvas controls', async () => {
    const onTidy = vi.fn();
    render(<CanvasEngine nodes={[]} edges={[]} onTidy={onTidy} />);

    expect(screen.queryByTestId('minimap')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Tidy graph' }));
    expect(onTidy).toHaveBeenCalledTimes(1);
  });
});
