import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ExecutionFeed } from '../../src/components/chat/ExecutionFeed';

describe('ExecutionFeed', () => {
  it('shows only the current tool while execution is active', () => {
    render(
      <MemoryRouter>
        <ExecutionFeed
          streaming
          toolCalls={[
            { id: 'one', name: 'inspect_run', status: 'success', result: { ok: true } },
            { id: 'two', name: 'test_extension', status: 'running', args: { target: 'factory' } },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('test_extension')).toBeInTheDocument();
    expect(screen.getByText('1 done')).toBeInTheDocument();
    expect(screen.queryByText('inspect_run')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('execution-feed'));
    expect(screen.getByText('Live execution details')).toBeInTheDocument();
    expect(screen.getByText('inspect_run')).toBeInTheDocument();
  });

  it('hides successful tool execution after the assistant finishes', () => {
    render(
      <MemoryRouter>
        <ExecutionFeed
          streaming={false}
          toolCalls={[
            { id: 'one', name: 'inspect_run', status: 'success', result: { ok: true } },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('execution-feed')).not.toBeInTheDocument();
  });
});
