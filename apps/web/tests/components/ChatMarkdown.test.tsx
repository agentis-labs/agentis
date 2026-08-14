import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMarkdown } from '../../src/components/chat/ChatMarkdown';

describe('<ChatMarkdown />', () => {
  it('renders private runtime file links as plain readable labels', () => {
    render(<ChatMarkdown text="Read [the implementation plan](file:///private/runtime/plan.md)." />);

    expect(screen.getByText(/Read the implementation plan/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/file:\/\//)).toBeNull();
  });

  it('keeps safe web links clickable', () => {
    render(<ChatMarkdown text="Read [the docs](https://example.com/docs)." />);

    expect(screen.getByRole('link', { name: 'the docs' })).toHaveAttribute('href', 'https://example.com/docs');
  });
});
