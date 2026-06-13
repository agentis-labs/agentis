import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  PlanList,
  SuggestionList,
  derivePlanItems,
  extractPlan,
  extractSuggestions,
} from '../../src/components/chat/PlanList';

describe('chat numbered-list rendering', () => {
  it('renders future actions as suggestions without completed-task UI', () => {
    const parsed = extractSuggestions([
      'If you want, I can next:',
      '1. Wire it to a different email provider.',
      '2. Adjust the morning send time.',
    ].join('\n'));

    expect(parsed?.items).toEqual([
      'Wire it to a different email provider.',
      'Adjust the morning send time.',
    ]);
    expect(extractPlan('1. Wire it.\n2. Adjust it.')).toBeNull();

    const onSelect = vi.fn();
    render(<SuggestionList items={parsed!.items} onSelect={onSelect} />);

    expect(screen.getByText('Try next')).toBeInTheDocument();
    expect(screen.queryByText(/completed/i)).toBeNull();
    expect(document.querySelector('.line-through')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust the morning send time.' }));
    expect(onSelect).toHaveBeenCalledWith('Adjust the morning send time.');
  });

  it('only extracts an execution plan when the list is explicitly labeled', () => {
    const plan = extractPlan([
      'I am preparing the workflow.',
      'Execution plan:',
      '1. Read the request.',
      '2. Build the workflow.',
    ].join('\n'));

    expect(plan).toEqual({
      before: 'I am preparing the workflow.',
      after: '',
      items: ['Read the request.', 'Build the workflow.'],
    });
    expect(extractPlan('Reasons:\n1. First reason.\n2. Second reason.')).toBeNull();
  });

  it('keeps progress UI for explicit live plans', () => {
    const items = derivePlanItems(
      ['Read the request.', 'Build the workflow.'],
      [{ id: 'tool-1', name: 'agentis.build_workflow', status: 'running' }],
    );

    render(<PlanList items={items} />);

    expect(screen.getByText('Execution Plan')).toBeInTheDocument();
    expect(screen.getByText('0/2 Completed')).toBeInTheDocument();
    expect(screen.getByText('Read the request.')).toBeInTheDocument();
  });
});
