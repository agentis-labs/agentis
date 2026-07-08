import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GovernancePanel } from '../../src/components/settings/GovernancePanel';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const summary = {
  fleet: {
    totalAgents: 3,
    connected: 2,
    byAdapter: {
      claude_code: { total: 2, connected: 1, online: 1, spendCents: 250 },
      cursor: { total: 1, connected: 1, online: 1, spendCents: 100 },
    },
  },
  cost: { spendTodayCents: 150, monthlySpendCents: 350, limitHitsToday: 1 },
  approvals: { pending: 2 },
  audit: { recentCount: 12, latestAt: '2026-05-31T10:00:00.000Z' },
};

describe('<GovernancePanel />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  it('renders the fleet, cost, approvals and audit snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(summary)));

    render(<GovernancePanel />);

    await waitFor(() => expect(screen.getByText('Governance')).toBeInTheDocument());
    expect(screen.getByText('2/3')).toBeInTheDocument();            // connected/total
    expect(screen.getByText('$1.50')).toBeInTheDocument();          // spend today
    expect(screen.getByText('claude_code')).toBeInTheDocument();    // fleet row
    expect(screen.getByText(/budget limit hit/i)).toBeInTheDocument();
  });

  it('shows an error when the summary fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'nope' } }, 500)));
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText(/nope/)).toBeInTheDocument());
  });
});
