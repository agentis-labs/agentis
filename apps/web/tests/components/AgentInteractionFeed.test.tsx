import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('expands the sanitized consultation dialogue and discloses fallback routing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/v1/agents')) return jsonResponse({ agents: [] });
      return jsonResponse({
        events: [{
          id: 'consult-1',
          at: '2026-05-31T10:00:02.000Z',
          kind: 'consultation',
          eventType: 'agent_consultation',
          actor: { type: 'agent', id: 'support' },
          summary: 'Support Agent consulted Technical Specialist · 2 rounds',
          consultation: {
            id: 'consult-1',
            status: 'completed',
            caller: { id: 'support', name: 'Support Agent' },
            target: { id: 'technical', name: 'Technical Specialist', role: 'specialist' },
            roundCount: 2,
            maxRounds: 3,
            substituted: true,
            requestedTargetAgentId: 'paused-agent',
            messages: [
              { id: 'q1', sequenceNumber: 1, kind: 'question', authorAgentId: 'support', body: 'Why is it timing out?', createdAt: '2026-05-31T10:00:00.000Z' },
              { id: 'a1', sequenceNumber: 2, kind: 'answer', authorAgentId: 'technical', body: 'The retry budget is exhausted.', createdAt: '2026-05-31T10:00:01.000Z' },
            ],
          },
        }],
        nextBefore: null,
      });
    }));

    render(<AgentInteractionFeed conversationId="conversation-1" compact />);
    const summary = await screen.findByText('Support Agent consulted Technical Specialist · 2 rounds');
    await userEvent.click(summary);
    expect(screen.getByText('Why is it timing out?')).toBeInTheDocument();
    expect(screen.getByText('The retry budget is exhausted.')).toBeInTheDocument();
    expect(screen.getByText(/compatible fallback used/i)).toBeInTheDocument();
  });
});
