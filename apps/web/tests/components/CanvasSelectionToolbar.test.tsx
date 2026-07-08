import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';
import { CanvasSelectionToolbar } from '../../src/components/canvas/CanvasSelectionToolbar';

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

describe('CanvasSelectionToolbar', () => {
  it('exposes phase actions for a multi-selection', async () => {
    const onCreate = vi.fn();
    const onMove = vi.fn();
    render(
      <ReactFlowProvider>
        <CanvasSelectionToolbar
          nodes={[
            { id: 'a', position: { x: 0, y: 20 }, data: {} },
            { id: 'b', position: { x: 280, y: 20 }, data: {} },
          ]}
          phases={[{ id: 'p1', name: 'Build', color: '#2563eb', nodeIds: [] }]}
          canCreatePhase
          onCreatePhase={onCreate}
          onMoveToPhase={onMove}
          onTidy={vi.fn()}
          onDelete={vi.fn()}
        />
      </ReactFlowProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create phase' }));
    expect(onCreate).toHaveBeenCalledWith(['a', 'b']);
    await userEvent.selectOptions(screen.getByRole('combobox'), 'p1');
    expect(onMove).toHaveBeenCalledWith('p1', ['a', 'b']);
  });

  it('keeps toolbar pointer events from reaching the canvas', () => {
    const onCanvasPointerDown = vi.fn();
    const onCanvasClick = vi.fn();
    render(
      <ReactFlowProvider>
        <div onPointerDown={onCanvasPointerDown} onClick={onCanvasClick}>
          <CanvasSelectionToolbar
            nodes={[
              { id: 'a', position: { x: 0, y: 20 }, data: {} },
              { id: 'b', position: { x: 280, y: 20 }, data: {} },
            ]}
            phases={[]}
            canCreatePhase
            onCreatePhase={vi.fn()}
            onMoveToPhase={vi.fn()}
            onTidy={vi.fn()}
            onDelete={vi.fn()}
          />
        </div>
      </ReactFlowProvider>,
    );

    const toolbar = screen.getByTestId('canvas-selection-toolbar');
    fireEvent.pointerDown(toolbar);
    fireEvent.click(toolbar);

    expect(onCanvasPointerDown).not.toHaveBeenCalled();
    expect(onCanvasClick).not.toHaveBeenCalled();
  });
});
