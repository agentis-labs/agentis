/**
 * NodePalette — RTL component test.
 *
 * The rebuilt palette: a searchable icon-grid of engine steps plus an Apps tab
 * of integration connectors. Assert the grid renders steps with real icons,
 * search filters, and the Apps tab lists connectors that drop pre-seeded
 * integration nodes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.fn((path: string) => {
  if (path.startsWith('/v1/workflows')) {
    return Promise.resolve({ workflows: [{ id: 'wf-1', title: 'Enrich lead' }] });
  }
  if (path.startsWith('/v1/integrations')) {
    return Promise.resolve({
      integrations: [
        { service: 'slack', name: 'Slack', operations: ['send_message'], category: 'chat' },
        { service: 'stripe', name: 'Stripe', operations: ['create_charge'], category: 'payments' },
      ],
    });
  }
  return Promise.resolve({});
});

vi.mock('../../src/lib/api', () => ({
  api: (...args: unknown[]) => apiMock(...(args as [string])),
}));

import { NodePalette } from '../../src/components/canvas/NodePalette';

describe('<NodePalette />', () => {
  it('renders the steps grid with category sections and reusable subflows', async () => {
    render(<NodePalette />);
    expect(screen.getByPlaceholderText('Search steps…')).toBeInTheDocument();
    expect(screen.getByText('Control flow')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toBeInTheDocument();
    // Reusable workflows arrive async from the API.
    expect(await screen.findByText('Enrich lead')).toBeInTheDocument();
  });

  it('filters steps by search query', async () => {
    render(<NodePalette />);
    await userEvent.type(screen.getByPlaceholderText('Search steps…'), 'router');
    expect(screen.getByText('Router')).toBeInTheDocument();
    expect(screen.queryByText('Trigger')).toBeNull();
  });

  it('lists connectors on the Apps tab and picks a pre-seeded integration node', async () => {
    const onPick = vi.fn();
    render(<NodePalette onPick={onPick} />);
    await userEvent.click(screen.getByRole('button', { name: 'apps' }));
    await userEvent.click(await screen.findByText('Slack'));
    expect(onPick).toHaveBeenCalledWith(
      'integration',
      expect.objectContaining({ integrationId: 'slack', operationId: 'send_message', label: 'Slack' }),
    );
  });
});
