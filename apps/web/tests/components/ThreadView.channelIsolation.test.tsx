import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REALTIME_EVENTS, type RealtimeEnvelope, type RealtimeEventName } from '@agentis/core';

const state = vi.hoisted(() => ({
  api: vi.fn(),
  realtimeHandlers: [] as Array<{ events: RealtimeEventName[]; handler: (env: RealtimeEnvelope) => void }>,
}));

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api');
  return {
    ...actual,
    api: (...args: unknown[]) => state.api(...args),
    apiErrorMessage: (error: unknown) => String(error),
    streamSse: vi.fn(),
  };
});

vi.mock('../../src/lib/realtime', () => ({
  rtSubscribe: vi.fn(() => vi.fn()),
  useRealtime: (events: RealtimeEventName[], handler: (env: RealtimeEnvelope) => void) => {
    state.realtimeHandlers.push({ events, handler });
  },
}));

vi.mock('../../src/lib/viewportContext', () => ({
  useViewportAwareness: () => ({ label: null, active: false, context: { surface: 'chat' } }),
}));

vi.mock('../../src/lib/connections', () => ({
  listInteractions: vi.fn(async () => ({ events: [] })),
}));

vi.mock('../../src/lib/runModal', () => ({
  openRunModal: vi.fn(),
}));

vi.mock('../../src/components/shared/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import { ThreadView } from '../../src/components/chat/ThreadView';

function emit(event: RealtimeEventName, payload: unknown) {
  const env = { event, payload, emittedAt: new Date().toISOString() } as RealtimeEnvelope;
  for (const entry of state.realtimeHandlers) {
    if (entry.events.includes(event)) entry.handler(env);
  }
}

describe('ThreadView channel isolation', () => {
  beforeEach(() => {
    state.api.mockReset();
    state.realtimeHandlers = [];
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    state.api.mockImplementation(async (path: string) => {
      if (path === '/v1/conversations/agent-1?limit=50') {
        return {
          conversation: { id: 'desktop-conv', executionMode: 'chat' },
          messages: [{
            id: 'desktop-message',
            authorType: 'operator',
            authorId: 'user-1',
            body: 'Desktop hello',
            createdAt: '2026-06-22T00:00:00.000Z',
            metadata: {},
            deliveryStatus: 'sent',
          }],
        };
      }
      if (path === '/v1/agents/agent-1') {
        return { agent: { adapterType: 'codex', runtimeModel: 'gpt-5.5', adapterCapabilities: { interactiveChat: true, toolCalling: true } } };
      }
      if (path === '/v1/agents/agent-1/runtime-context') {
        return {
          provider: 'codex',
          models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
          currentModel: 'gpt-5.5',
          efforts: [],
        };
      }
      if (path === '/v1/agents') {
        return { agents: [{ id: 'agent-1', name: 'Orchestrator', role: 'orchestrator' }] };
      }
      return {};
    });
  });

  it('ignores realtime messages for a channel-scoped conversation while the desktop thread is open', async () => {
    render(
      <MemoryRouter>
        <ThreadView kind="agent" id="agent-1" name="Orchestrator" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Desktop hello')).toBeInTheDocument();

    act(() => {
      emit(REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED, {
        agentId: 'agent-1',
        conversationId: 'telegram-conv',
        message: {
          id: 'telegram-message',
          authorType: 'system',
          authorId: null,
          body: 'Telegram should stay separate',
          createdAt: '2026-06-22T00:01:00.000Z',
          metadata: { channel: 'telegram', channelInbound: true },
          deliveryStatus: 'mirrored',
        },
      });
    });

    expect(screen.queryByText('Telegram should stay separate')).not.toBeInTheDocument();

    act(() => {
      emit(REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED, {
        agentId: 'agent-1',
        conversationId: 'desktop-conv',
        message: {
          id: 'desktop-live',
          authorType: 'agent',
          authorId: 'agent-1',
          body: 'Desktop live reply',
          createdAt: '2026-06-22T00:02:00.000Z',
          metadata: {},
          deliveryStatus: 'delivered',
        },
      });
    });

    await waitFor(() => expect(screen.getByText('Desktop live reply')).toBeInTheDocument());
  });
});
