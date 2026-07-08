import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Bot } from 'lucide-react';
import { CanvasNodeDetailPanel } from '../../src/components/home/CanvasNodeDetailPanel';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('<CanvasNodeDetailPanel />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders the shared quick model control for supported agent nodes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/v1/agents/agent-1' && (!init || init.method == null)) {
        return jsonResponse({
          agent: {
            id: 'agent-1',
            name: 'Atlas',
            adapterType: 'codex',
            runtimeModel: 'gpt-5-main',
            config: { command: 'codex', model: 'gpt-5-main' },
          },
        });
      }
      if (path === '/v1/harness/models/codex?agentId=agent-1') {
        return jsonResponse({
          adapterType: 'codex',
          defaultModel: 'gpt-5.5',
          defaultLabel: 'Runtime default',
          supportsManual: true,
          models: [{ id: 'gpt-5-main', label: 'GPT-5 Main', provider: 'OpenAI' }],
        });
      }
      return jsonResponse({});
    }));

    render(
      <CanvasNodeDetailPanel
        node={{
          id: 'agent-agent-1',
          kind: 'manager',
          tier: 1,
          title: 'Atlas',
          subtitle: 'manager - Codex',
          x: 0,
          y: 0,
          width: 220,
          height: 120,
          tooltipLines: [],
          route: '/agents/agent-1',
          icon: <Bot size={18} />,
          agent: {
            id: 'agent-1',
            name: 'Atlas',
            adapterType: 'codex',
            runtimeModel: 'gpt-5-main',
            status: 'online',
          } as never,
        }}
        observabilityEvents={[]}
        onClose={() => undefined}
        onNavigate={() => undefined}
        onOpenChat={() => undefined}
        onRefresh={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Runtime model/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /gpt-5 main/i })).toBeInTheDocument();
  });
});
