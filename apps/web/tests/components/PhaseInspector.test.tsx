import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhaseInspector } from '../../src/components/canvas/PhaseInspector';

describe('PhaseInspector', () => {
  it('edits phase governance fields and removes the phase', async () => {
    const onChange = vi.fn();
    const onDelete = vi.fn();
    render(
      <PhaseInspector
        phase={{ id: 'p1', name: 'Research', color: '#2563eb', nodeIds: ['a', 'b'] }}
        nodeTitles={new Map([['a', 'Fetch'], ['b', 'Analyze']])}
        onChange={onChange}
        onDelete={onDelete}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Fetch')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Discovery');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Discovery' }));

    await userEvent.selectOptions(screen.getByLabelText('Approval gate'), 'approve');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      humanGate: expect.objectContaining({ type: 'approve' }),
    }));

    await userEvent.click(screen.getByRole('button', { name: 'Remove phase' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
