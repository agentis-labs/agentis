/**
 * LoginPage — component test.
 *
 * Stubs the login `fetch` call and asserts that successful auth invokes
 * `onSuccess`, while a failure response surfaces the error message.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '../../src/pages/LoginPage';

describe('<LoginPage />', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the username + credential fields and submit button', () => {
    render(<LoginPage onSuccess={() => {}} />);
    expect(screen.getByText(/Username/i)).toBeInTheDocument();
    expect(screen.getByText(/Token or password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in/i })).toBeInTheDocument();
  });

  it('pre-fills "operator" as the default username', () => {
    render(<LoginPage onSuccess={() => {}} />);
    const input = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    expect(input.value).toBe('operator');
  });

  it('calls onSuccess when login resolves OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/v1/auth/launch') {
          return new Response(JSON.stringify({ error: { code: 'RESOURCE_NOT_FOUND' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            accessToken: 'a.b.c',
            refreshToken: 'r.r.r',
            user: { id: 'u1', username: 'operator', displayName: 'Op' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const onSuccess = vi.fn();
    render(<LoginPage onSuccess={onSuccess} />);

    const inputs = screen.getAllByRole('textbox');
    await userEvent.clear(inputs[0]!);
    await userEvent.type(inputs[0]!, 'operator');
    // password field is type=password — no role 'textbox'.
    const password = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    await userEvent.type(password, 'hunter2-very-secure');
    await userEvent.click(screen.getByRole('button', { name: /Sign in/i }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it('accepts a launch token and remembers it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/v1/auth/launch') {
          return new Response(
            JSON.stringify({
              accessToken: 'access.from.launch',
              refreshToken: 'refresh.from.launch',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ error: { message: 'Unexpected request' } }), { status: 500 });
      }),
    );
    const onSuccess = vi.fn();
    render(<LoginPage onSuccess={onSuccess} />);

    const credential = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    await userEvent.type(credential, 'local-launch-token');
    await userEvent.click(screen.getByRole('button', { name: /Sign in/i }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(localStorage.getItem('agentis.access')).toBe('access.from.launch');
    expect(localStorage.getItem('agentis.launchToken')).toBe('local-launch-token');
  });

  it('shows the server error message when login fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials' },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    render(<LoginPage onSuccess={() => {}} />);
    const password = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    await userEvent.type(password, 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: /Sign in/i }));

    expect(await screen.findByText(/Invalid credentials/i)).toBeInTheDocument();
  });
});
