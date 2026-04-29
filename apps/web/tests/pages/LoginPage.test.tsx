/**
 * LoginPage — component test.
 *
 * Stubs the login `fetch` call and asserts that successful auth invokes
 * `onSuccess`, while a failure response surfaces the error message.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '../../src/pages/LoginPage';

describe('<LoginPage />', () => {
  it('renders the username + password fields and submit button', () => {
    render(<LoginPage onSuccess={() => {}} />);
    expect(screen.getByText(/Username/i)).toBeInTheDocument();
    expect(screen.getByText(/Password/i)).toBeInTheDocument();
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
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            accessToken: 'a.b.c',
            refreshToken: 'r.r.r',
            user: { id: 'u1', username: 'operator', displayName: 'Op' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
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

    expect(onSuccess).toHaveBeenCalled();
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
