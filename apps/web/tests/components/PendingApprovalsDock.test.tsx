/**
 * PendingApprovalsDock — RTL component test (Batch 5 / D36).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PendingApprovalsDock } from '../../src/components/dashboard/PendingApprovalsDock';

describe('<PendingApprovalsDock />', () => {
  it('renders the empty-state copy when pending=0 and hides the badge', () => {
    render(
      <MemoryRouter>
        <PendingApprovalsDock pending={0} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No pending approvals/i)).toBeInTheDocument();
    // No numeric badge when pending=0.
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders the count and a badge when pending>0', () => {
    render(
      <MemoryRouter>
        <PendingApprovalsDock pending={3} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/3 pending/i)).toBeInTheDocument();
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);
  });

  it('links to /approvals', () => {
    render(
      <MemoryRouter>
        <PendingApprovalsDock pending={1} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/approvals');
  });
});
