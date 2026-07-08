import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from '../../src/pages/ChatPage';
import { useChatPanelStore } from '../../src/components/chat/ChatPanelStore';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ChatPage compatibility shim', () => {
  beforeEach(() => {
    useChatPanelStore.setState({
      state: 'hidden',
      selectedThread: null,
      launchContext: null,
      returnPath: '/home',
      openRequestId: 0,
    });
  });

  it('opens an agent thread in the persistent fullscreen overlay and returns to the launcher route', async () => {
    vi.mocked(global.fetch).mockImplementation(async () => jsonResponse({ agent: { id: 'agent-1', name: 'Orchy' } }));

    render(
      <MemoryRouter initialEntries={[{ pathname: '/chat/agent/agent-1', state: { returnTo: '/agents' } }]}>
        <Routes>
          <Route path="/chat/agent/:agentId" element={<ChatPage />} />
          <Route path="/agents" element={<div>Agents page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Agents page')).toBeInTheDocument());
    expect(useChatPanelStore.getState().state).toBe('fullscreen');
    expect(useChatPanelStore.getState().selectedThread).toMatchObject({
      kind: 'agent',
      id: 'agent-1',
      name: 'Orchy',
    });
  });
});
