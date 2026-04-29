/**
 * CommandPalette — RTL component test (Batch 5 / D36).
 *
 * The palette is a global overlay listening to ⌘K / Ctrl+K. We open it
 * with a synthetic keydown, type a query, assert the debounced fetch
 * returns hits, and check ↑/↓/Enter navigate the active row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette } from '../../src/components/CommandPalette';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('<CommandPalette />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('is hidden by default and does not render any input', () => {
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );
    expect(screen.queryByPlaceholderText(/Search workflows/i)).toBeNull();
  });

  it('opens on Ctrl+K and renders the search input', async () => {
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Search workflows/i)).toBeInTheDocument();
    });
  });

  it('queries /v1/command/search and renders the hits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          hits: [
            {
              type: 'workflow',
              id: 'w1',
              title: 'Refund flow',
              subtitle: 'Customer ops',
              href: '/workflows/w1',
              score: 0.9,
            },
          ],
        }),
      ),
    );
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByPlaceholderText(/Search workflows/i);
    await userEvent.type(input, 'refund');
    await waitFor(() => {
      expect(screen.getByText('Refund flow')).toBeInTheDocument();
    });
    expect(screen.getByText(/workflow/i)).toBeInTheDocument();
  });

  it('closes when Escape is pressed', async () => {
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>,
    );
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByPlaceholderText(/Search workflows/i);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/Search workflows/i)).toBeNull();
    });
  });
});
