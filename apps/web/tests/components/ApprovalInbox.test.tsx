/**
 * ApprovalInbox — RTL component test (Batch 5 / D36).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalInbox } from '../../src/components/approvals/ApprovalInbox';
import type { ApprovalRequest } from '../../src/components/approvals/ApprovalRequestRow';

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap-1',
    source: 'agent',
    title: 'Approve refund',
    summary: 'Customer #4231 — $42 refund',
    status: 'pending',
    confidence: 0.82,
    createdAt: new Date('2026-04-28T12:00:00Z').toISOString(),
    ...over,
  };
}

describe('<ApprovalInbox />', () => {
  it('renders the inbox-zero state when there are no approvals', () => {
    render(<ApprovalInbox approvals={[]} />);
    expect(screen.getByText(/Inbox zero/i)).toBeInTheDocument();
  });

  it('renders one row per approval with title + source + confidence', () => {
    render(<ApprovalInbox approvals={[approval(), approval({ id: 'ap-2', title: 'Other' })]} />);
    expect(screen.getByText('Approve refund')).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getAllByText(/82% confidence/).length).toBeGreaterThanOrEqual(1);
  });

  it('fires onResolve(id, "approve") when the Approve button is clicked', async () => {
    const onResolve = vi.fn();
    render(<ApprovalInbox approvals={[approval()]} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole('button', { name: /Approve/i }));
    expect(onResolve).toHaveBeenCalledWith('ap-1', 'approve', undefined);
  });

  it('fires onResolve(id, "reject") when the Reject button is clicked', async () => {
    const onResolve = vi.fn();
    render(<ApprovalInbox approvals={[approval()]} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole('button', { name: /Reject/i }));
    expect(onResolve).toHaveBeenCalledWith('ap-1', 'reject', undefined);
  });

  it('hides the action buttons for non-pending approvals', () => {
    render(<ApprovalInbox approvals={[approval({ status: 'approved' })]} onResolve={() => {}} />);
    expect(screen.queryByRole('button', { name: /Approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reject/i })).toBeNull();
    expect(screen.getByText('approved')).toBeInTheDocument();
  });
});
