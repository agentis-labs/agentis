import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/components/chat/Composer';

function stubComposerCatalogs() {
  vi.mocked(global.fetch).mockImplementation(async (input) => {
    const url = String(input);
    const body = url.includes('/v1/workflows')
      ? { workflows: [] }
      : { agents: [] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('Composer', () => {
  it('turns the send button into the active stop control while a turn is running', () => {
    stubComposerCatalogs();
    const onSend = vi.fn();
    const onStop = vi.fn();

    render(
      <Composer
        onSend={onSend}
        isRunning
        onStop={onStop}
        draftKey="composer-stop-test"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop agent response' }));

    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });
});
