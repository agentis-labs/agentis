/**
 * SettingsChannelsPage — RTL component test (Batch 4 / D35).
 *
 * Stubs `fetch` so the page can render with a fake list of agents and
 * channel connections, then asserts the form-driven create flow surfaces
 * the webhook secret reveal modal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SettingsChannelsPage } from '../../src/pages/SettingsChannelsPage';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('<SettingsChannelsPage />', () => {
  beforeEach(() => {
    // Pretend we have a token so api() doesn't redirect to login.
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.refresh', 'r.r.r');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('lists existing connections fetched from /v1/channels', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/v1/channels')) {
          return jsonResponse({
            connections: [
              {
                id: 'c1',
                kind: 'telegram',
                name: 'Tg main',
                agentId: 'a1',
                status: 'active',
                defaultChatId: '999',
                lastEventAt: null,
                lastError: null,
              },
            ],
          });
        }
        if (url.endsWith('/v1/agents')) {
          return jsonResponse({ agents: [{ id: 'a1', name: 'Hermes' }] });
        }
        return jsonResponse({}, 404);
      }),
    );

    render(
      <MemoryRouter>
        <SettingsChannelsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Tg main')).toBeInTheDocument();
    });
    expect(screen.getByText(/telegram · Hermes · chat 999/i)).toBeInTheDocument();
  });

  it('shows the webhook secret modal after a successful create', async () => {
    let createCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/channels') && (init?.method ?? 'GET') === 'POST') {
          createCalled = true;
          return jsonResponse(
            {
              connection: {
                id: 'c-new',
                kind: 'telegram',
                name: 'New tg',
                agentId: 'a1',
                status: 'active',
                defaultChatId: null,
                lastEventAt: null,
                lastError: null,
              },
              webhookSecret: 'deadbeefcafebabe1234567890abcdef1234567890abcdef',
              webhookUrl: '/v1/webhooks/channel/c-new',
            },
            201,
          );
        }
        if (url.endsWith('/v1/channels')) return jsonResponse({ connections: [] });
        if (url.endsWith('/v1/agents'))
          return jsonResponse({ agents: [{ id: 'a1', name: 'Hermes' }] });
        return jsonResponse({}, 404);
      }),
    );

    render(
      <MemoryRouter>
        <SettingsChannelsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/No channels connected yet\./i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /\+ Connect/i }));
    await userEvent.type(screen.getByLabelText('name'), 'New tg');
    await userEvent.type(screen.getByLabelText('token'), 'super-secret-token');
    await userEvent.click(screen.getByRole('button', { name: /^Connect$/ }));

    await waitFor(() => {
      expect(screen.getByText(/Webhook details/i)).toBeInTheDocument();
    });
    expect(createCalled).toBe(true);
    expect(screen.getByText(/deadbeefcafebabe/)).toBeInTheDocument();
    expect(screen.getByText('/v1/webhooks/channel/c-new')).toBeInTheDocument();
  });
});
