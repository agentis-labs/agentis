import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerStatusBar } from '../../src/components/chat/ComposerStatusBar';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<ComposerStatusBar />', () => {
  it('renders runtime menus in a portal so the composer cannot clip them', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/runtime-context')) {
        return jsonResponse({
          provider: 'codex',
          models: [{ id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' }],
          currentModel: 'gpt-5.4-mini',
          efforts: [{ id: 'low', label: 'Low' }],
          currentEffort: 'low',
          fastModeSupported: true,
          fastModeEnabled: false,
        });
      }
      return jsonResponse({
        agent: {
          id: 'agent-1',
          adapterType: 'codex',
          runtimeModel: 'gpt-5.4-mini',
          config: {},
        },
      });
    }));

    const { container } = render(<ComposerStatusBar agentId="agent-1" />);

    await screen.findByRole('button', { name: 'Select model' });
    await user.click(screen.getByRole('button', { name: 'Select model' }));

    await waitFor(() => expect(document.body).toHaveTextContent('Enable fast mode'));
    expect(container).not.toHaveTextContent('Enable fast mode');
  });
});
