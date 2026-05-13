import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BrowserRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';

function makeFetchMock(launchPath: string) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/v1/auth/launch') {
      return new Response(
        JSON.stringify({
          accessToken: 'access.from.launch',
          refreshToken: 'refresh.from.launch',
          user: { id: 'u1', username: 'operator', displayName: 'Operator' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (path === '/v1/workspaces') {
      return new Response(
        JSON.stringify({ workspaces: [{ id: 'ws-1', name: 'Main', slug: 'main' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    void init; void launchPath;
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe('<App /> launch auth', () => {
  it('exchanges the ?token= URL param (CLI flow)', async () => {
    window.history.pushState({}, '', '/workspaces?token=local-launch-token');
    const fetchMock = makeFetchMock('/v1/auth/launch');
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );

    expect(screen.getByText(/Opening Agentis/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(localStorage.getItem('agentis.access')).toBe('access.from.launch');
    });
    expect(localStorage.getItem('agentis.refresh')).toBe('refresh.from.launch');
    expect(window.location.search).not.toContain('token=');
    expect(screen.queryByText(/Password/i)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/auth/launch',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('auto-logs in via GET /v1/auth/launch when no ?token= (bare URL)', async () => {
    window.history.pushState({}, '', '/');
    const fetchMock = makeFetchMock('/v1/auth/launch');
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );

    // Shows "Opening Agentis…" while probing localhost auto-login
    expect(screen.getByText(/Opening Agentis/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(localStorage.getItem('agentis.access')).toBe('access.from.launch');
    });
    expect(screen.queryByText(/Password/i)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/auth/launch',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('shows login form when localhost auto-login returns 404 (server deployment)', async () => {
    window.history.pushState({}, '', '/');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/v1/auth/launch') {
        return new Response(JSON.stringify({ error: { code: 'RESOURCE_NOT_FOUND' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Opening Agentis/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });
});
