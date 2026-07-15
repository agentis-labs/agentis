import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextInspector } from '../../src/components/canvas/ContextInspector';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('<ContextInspector /> agent requirements', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes required affordances and previews matching connected agents', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input) === '/v1/agents') {
        return json({
          agents: [
            {
              id: 'agent-browser',
              name: 'Browser Agent',
              status: 'online',
              adapterType: 'openclaw',
              adapterCapabilities: { affordances: { browser: true, terminal: true } },
            },
            {
              id: 'agent-terminal',
              name: 'Terminal Agent',
              status: 'online',
              adapterType: 'codex',
              adapterCapabilities: { affordances: { terminal: true } },
            },
          ],
        });
      }
      return json({});
    }));
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(
      <ContextInspector
        selection={{
          kind: 'node',
          nodeId: 'node-1',
          nodeType: 'agent_task',
          data: { kind: 'agent_task', prompt: 'Research this.', capabilityTags: [], inputKeys: [], outputKeys: [] },
        }}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(await screen.findByText('What this agent can do')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Native browser'));

    await waitFor(() => expect(screen.getAllByText('Browser Agent').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Terminal Agent').length).toBeGreaterThan(0);
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable Native browser' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      requires: { browser: true },
    })));
  });
});
