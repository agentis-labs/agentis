import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentInteractionFeed } from '../../src/components/agents/AgentInteractionFeed';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('<AgentInteractionFeed />', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'a.b.c');
    localStorage.setItem('agentis.workspace', 'ws-1');
  });

  it('renders the merged agent-to-agent timeline', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('agentId=agent-1');
      return jsonResponse({
        events: [
          { id: 'e1', at: '2026-05-31T10:00:02.000Z', kind: 'message', eventType: 'agent_message', actor: { type: 'agent', id: 'agent-1' }, summary: 'On it' },
          { id: 'e2', at: '2026-05-31T10:00:01.000Z', kind: 'activity', eventType: 'task_delegated', actor: { type: 'agent', id: 'agent-2' }, summary: 'delegated a task' },
        ],
        nextBefore: null,
      });
    }));

    render(<AgentInteractionFeed agentId="agent-1" />);

    await waitFor(() => expect(screen.getByText('On it')).toBeInTheDocument());
    expect(screen.getByText('task_delegated')).toBeInTheDocument();
    expect(screen.getByText('delegated a task')).toBeInTheDocument();
  });

  it('shows an empty state when there are no interactions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ events: [], nextBefore: null })));
    render(<AgentInteractionFeed agentId="agent-1" />);
    await waitFor(() => expect(screen.getByText(/No agent-to-agent interactions yet/i)).toBeInTheDocument());
  });
});
