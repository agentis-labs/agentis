import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelChooser } from '../../src/components/agents/ModelChooser';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('<ModelChooser />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('offers an explicit custom model input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      adapterType: 'codex',
      defaultModel: 'gpt-5.3-codex',
      defaultLabel: 'Runtime default',
      supportsManual: true,
      models: [
        { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'OpenAI', recommended: true },
      ],
    })));

    const onChange = vi.fn();
    render(
      <ModelChooser
        adapterType="codex"
        value=""
        onChange={onChange}
      />,
    );

    await waitFor(() => expect(screen.getByText('Model')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /gpt-5\.3 codex/i }));

    const customInput = await screen.findByPlaceholderText('Custom model id');
    await userEvent.type(customInput, 'gpt-real-custom');
    await userEvent.click(screen.getByRole('button', { name: 'Use' }));

    expect(onChange).toHaveBeenCalledWith('gpt-real-custom');
  });
});
