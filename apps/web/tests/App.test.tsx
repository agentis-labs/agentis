import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BrowserRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';

function makeFetchMock() {
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
    void init;
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe('<App /> launch auth', () => {
  it('exchanges the ?token= URL param (CLI flow)', async () => {
    window.history.pushState({}, '', '/workspaces?token=local-launch-token');
    const fetchMock = makeFetchMock();
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
    expect(localStorage.getItem('agentis.launchToken')).toBe('local-launch-token');
    expect(window.location.search).not.toContain('token=');
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/auth/launch',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reuses the stored launch token on a bare URL', async () => {
    window.history.pushState({}, '', '/');
    localStorage.setItem('agentis.launchToken', 'remembered-launch-token');
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(localStorage.getItem('agentis.access')).toBe('access.from.launch');
    });
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/auth/launch',
      expect.objectContaining({ method: 'POST' }),
    );
    const launchCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/v1/auth/launch');
    expect(launchCall).toBeDefined();
    expect(String(launchCall?.[1]?.body)).toContain('remembered-launch-token');
  });

  it('uses the local-only launch bypass on a bare loopback URL', async () => {
    window.history.pushState({}, '', '/');
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(localStorage.getItem('agentis.access')).toBe('access.from.launch');
    });
    expect(localStorage.getItem('agentis.launchToken')).toBeNull();
    const launchCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/v1/auth/launch');
    expect(launchCall).toBeDefined();
    expect(String(launchCall?.[1]?.body)).toContain('local-bypass');
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('shows login when local launch auth is unavailable', async () => {
    window.history.pushState({}, '', '/');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'RESOURCE_NOT_FOUND' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    });
    expect(localStorage.getItem('agentis.access')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/auth/launch',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows login form when a supplied launch token is rejected', async () => {
    window.history.pushState({}, '', '/?token=expired-token');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/v1/auth/launch') {
        return new Response(JSON.stringify({ error: { code: 'RESOURCE_NOT_FOUND' } }), {
          status: 401,
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
    expect(fetchMock).toHaveBeenCalledWith(
      '/v1/auth/launch',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
