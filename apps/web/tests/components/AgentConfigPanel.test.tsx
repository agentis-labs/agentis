import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentConfigPanel } from '../../src/components/agents/AgentConfigPanel';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const baseAgent = {
  id: 'agent-1',
  name: 'Runtime Agent',
  adapterType: 'claude_code',
  runtimeModel: null,
  role: 'worker',
  status: 'error',
  colorHex: '#60a5fa',
  capabilityTags: [],
  instructions: null,
  avatarGlyph: 'RA',
  lastHeartbeatAt: null,
  currentTaskId: null,
  isPaused: false,
  monthlyBudgetCents: null,
  currentMonthSpendCents: null,
  config: {},
};

describe('<AgentConfigPanel /> runtime connection', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  it('connects a detected OpenClaw gateway without starting an install', async () => {
    const onSaved = vi.fn();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/v1/harness/detect') {
        return jsonResponse({
          harnesses: [
            {
              adapterType: 'openclaw',
              harness: 'OpenClaw',
              status: 'found',
              detail: 'Gateway URL configured: wss://localhost:3738',
              config: { gatewayUrl: 'wss://localhost:3738' },
            },
          ],
        });
      }
      if (path === '/v1/agents/agent-1' && init?.method === 'PATCH') return jsonResponse({ ok: true });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <AgentConfigPanel
        agent={{ ...baseAgent, adapterType: 'openclaw' }}
        allAgents={[]}
        onSaved={onSaved}
      />,
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/v1/agents/agent-1',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    const installCalls = fetchSpy.mock.calls.filter(([input]) => String(input) === '/v1/harness/install');
    expect(installCalls).toHaveLength(0);
    const patchCall = fetchSpy.mock.calls.find(([input, init]) => String(input) === '/v1/agents/agent-1' && init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      config: { gatewayUrl: 'wss://localhost:3738/' },
      status: 'online',
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('does not install a missing CLI runtime when the panel opens', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/v1/harness/detect') {
        return jsonResponse({
          harnesses: [
            {
              adapterType: 'claude_code',
              harness: 'Claude Code',
              status: 'not_found',
              detail: 'claude was not found',
            },
          ],
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<AgentConfigPanel agent={baseAgent} allAgents={[]} onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/v1/harness/detect', expect.any(Object));
    });

    const installCalls = fetchSpy.mock.calls.filter(([input]) => String(input) === '/v1/harness/install');
    const agentPatchCalls = fetchSpy.mock.calls.filter(([input, init]) => String(input) === '/v1/agents/agent-1' && init?.method === 'PATCH');
    expect(installCalls).toHaveLength(0);
    expect(agentPatchCalls).toHaveLength(0);
  });
});