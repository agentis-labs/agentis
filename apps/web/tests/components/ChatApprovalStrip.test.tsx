/**
 * ChatApprovalStrip — approval-as-conversation surfaced above the composer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  approvals: [] as Array<{ id: string; title?: string; source?: string; workflowName?: string; summary?: string; createdAt: string }>,
  apiCalls: [] as Array<{ path: string; init: unknown }>,
  refreshed: 0,
}));

vi.mock('../../src/lib/workspaceData', () => ({
  useWorkspaceData: () => ({ approvals: state.approvals }),
  refreshWorkspaceSnapshot: async () => { state.refreshed += 1; },
}));
vi.mock('../../src/lib/api', () => ({
  api: async (path: string, init: unknown) => { state.apiCalls.push({ path, init }); return {}; },
}));

import { ChatApprovalStrip } from '../../src/components/chat/ChatApprovalStrip';

beforeEach(() => {
  state.approvals = [];
  state.apiCalls = [];
  state.refreshed = 0;
});

describe('<ChatApprovalStrip />', () => {
  it('renders nothing when there are no pending approvals', () => {
    const { container } = render(<ChatApprovalStrip />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a rich card with the action summary and resolves on approve', async () => {
    state.approvals = [{
      id: 'ap_1',
      workflowName: 'Send Hi Robson Email',
      summary: 'Approve running Send Email (agentmail). to: robson@example.com. subject: Hi Robson.',
      createdAt: new Date().toISOString(),
    }];
    render(<ChatApprovalStrip />);

    expect(screen.getByText('Send Hi Robson Email')).toBeTruthy();
    expect(screen.getByText(/Approve running Send Email/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText(/Approve & run/i));
    });

    await waitFor(() => expect(state.apiCalls.length).toBe(1));
    expect(state.apiCalls[0]!.path).toBe('/v1/approvals/ap_1/resolve');
    expect(JSON.parse((state.apiCalls[0]!.init as { body: string }).body)).toEqual({ decision: 'approve' });
    expect(state.refreshed).toBe(1);
  });

  it('rejects with the reject decision', async () => {
    state.approvals = [{ id: 'ap_2', createdAt: new Date().toISOString() }];
    render(<ChatApprovalStrip />);
    await act(async () => {
      fireEvent.click(screen.getByText(/Reject/i));
    });
    await waitFor(() => expect(state.apiCalls.length).toBe(1));
    expect(state.apiCalls[0]!.path).toBe('/v1/approvals/ap_2/resolve');
    expect(JSON.parse((state.apiCalls[0]!.init as { body: string }).body)).toEqual({ decision: 'reject' });
  });

  it('labels self-heal approvals as repair requests', async () => {
    state.approvals = [{
      id: 'ap_self_heal',
      source: 'self_heal',
      title: 'Approve self-healing fix',
      summary: 'The node output missed its declared location field.',
      createdAt: new Date().toISOString(),
    }];
    render(<ChatApprovalStrip />);

    expect(screen.getByText('Self-healing fix ready')).toBeTruthy();
    expect(screen.getByText(/missed its declared location field/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText(/Approve fix/i));
    });

    await waitFor(() => expect(state.apiCalls.length).toBe(1));
    expect(JSON.parse((state.apiCalls[0]!.init as { body: string }).body)).toEqual({ decision: 'approve' });
  });
});
