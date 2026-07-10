import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SelectedAgentModelControl } from '../../src/components/agents/SelectedAgentModelControl';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fullAgent = {
  id: 'agent-1',
  name: 'Codex agent',
  adapterType: 'codex',
  runtimeModel: 'gpt-5-main',
  config: {
    command: 'codex',
    binaryPath: 'codex',
    cwd: 'C:/repo',
    model: 'gpt-5-main',
    browser: true,
    customFlag: 'keep',
  },
};

const catalog = {
  adapterType: 'codex',
  defaultModel: 'gpt-5.5',
  defaultLabel: 'Runtime default',
  supportsManual: true,
  models: [
    { id: 'gpt-5-main', label: 'GPT-5 Main', provider: 'OpenAI', recommended: true },
    { id: 'gpt-5-fast', label: 'GPT-5 Fast', provider: 'OpenAI' },
  ],
};

describe('<SelectedAgentModelControl />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('supports catalog, custom, and runtime-default selections while preserving unrelated config', async () => {
    const patchBodies: Array<Record<string, unknown>> = [];
    const onUpdated = vi.fn();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/v1/agents/agent-1' && (!init || init.method == null)) {
        return jsonResponse({ agent: fullAgent });
      }
      if (path === '/v1/harness/models/codex?agentId=agent-1') return jsonResponse(catalog);
      if (path === '/v1/agents/agent-1' && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <SelectedAgentModelControl
        agentId="agent-1"
        adapterType="codex"
        onUpdated={onUpdated}
      />,
    );

    const chooserButton = await screen.findByRole('button', { name: /gpt-5 main/i });

    await userEvent.click(chooserButton);
    await userEvent.click(await screen.findByRole('button', { name: /gpt-5 fast/i }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({
      config: {
        command: 'codex',
        binaryPath: 'codex',
        cwd: 'C:/repo',
        model: 'gpt-5-fast',
        maxTurns: 24,
        fastMode: false,
        browser: true,
        customFlag: 'keep',
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      runtimeModel: 'gpt-5-fast',
    });

    await userEvent.click(await screen.findByRole('button', { name: /gpt-5 fast/i }));
    await userEvent.type(await screen.findByPlaceholderText('Custom model id'), 'gpt-5-custom');
    await userEvent.click(screen.getByRole('button', { name: 'Use' }));

    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toEqual({
      config: {
        command: 'codex',
        binaryPath: 'codex',
        cwd: 'C:/repo',
        model: 'gpt-5-custom',
        maxTurns: 24,
        fastMode: false,
        browser: true,
        customFlag: 'keep',
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      runtimeModel: 'gpt-5-custom',
    });

    await userEvent.click(await screen.findByRole('button', { name: /gpt-5-custom/i }));
    await userEvent.click(screen.getByRole('button', { name: /default/i }));

    await waitFor(() => expect(patchBodies).toHaveLength(3));
    expect(patchBodies[2]).toEqual({
      config: {
        command: 'codex',
        binaryPath: 'codex',
        cwd: 'C:/repo',
        maxTurns: 24,
        fastMode: false,
        browser: true,
        customFlag: 'keep',
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      runtimeModel: '',
    });
    expect(onUpdated).toHaveBeenCalledTimes(3);
  });

  it('shows a saving state while a failed save is in flight, then rolls back', async () => {
    const patchRequest = deferred<Response>();
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/v1/agents/agent-1' && (!init || init.method == null)) {
        return Promise.resolve(jsonResponse({ agent: fullAgent }));
      }
      if (path === '/v1/harness/models/codex?agentId=agent-1') return Promise.resolve(jsonResponse(catalog));
      if (path === '/v1/agents/agent-1' && init?.method === 'PATCH') return patchRequest.promise;
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <SelectedAgentModelControl
        agentId="agent-1"
        adapterType="codex"
      />,
    );

    const chooserButton = await screen.findByRole('button', { name: /gpt-5 main/i });
    await userEvent.click(chooserButton);
    await userEvent.click(await screen.findByRole('button', { name: /gpt-5 fast/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /saving model/i })).toBeDisabled());

    patchRequest.resolve(jsonResponse({ error: { code: 'PATCH_FAILED', message: 'Nope' } }, 500));

    await waitFor(() => expect(screen.getByRole('button', { name: /gpt-5 main/i })).toBeEnabled());
    expect(screen.getByRole('button', { name: /gpt-5 main/i })).toBeInTheDocument();
  });

  it('stays hidden for unsupported adapters', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(
      <SelectedAgentModelControl
        agentId="agent-1"
        adapterType="mystery"
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
