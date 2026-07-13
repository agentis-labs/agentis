import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socketHarness = vi.hoisted(() => {
  const sockets: Array<{
    connected: boolean;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    io: { on: ReturnType<typeof vi.fn> };
    trigger: (event: string, payload?: unknown) => void;
  }> = [];

  return {
    sockets,
    create: vi.fn(() => {
      const handlers = new Map<string, Set<(payload?: unknown) => void>>();
      const socket = {
        connected: false,
        on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
          const listeners = handlers.get(event) ?? new Set();
          listeners.add(handler);
          handlers.set(event, listeners);
          return socket;
        }),
        off: vi.fn((event: string, handler: (payload?: unknown) => void) => {
          handlers.get(event)?.delete(handler);
          return socket;
        }),
        emit: vi.fn(() => socket),
        disconnect: vi.fn(() => {
          socket.connected = false;
          return socket;
        }),
        io: { on: vi.fn() },
        trigger: (event: string, payload?: unknown) => {
          for (const handler of handlers.get(event) ?? []) handler(payload);
        },
      };
      sockets.push(socket);
      return socket;
    }),
  };
});

vi.mock('socket.io-client', () => ({ io: socketHarness.create }));

import {
  disconnectRealtime,
  rtSubscribe,
  useRealtime,
  type RealtimeEnvelope,
} from '../../src/lib/realtime';

describe('realtime connection lifecycle', () => {
  beforeEach(() => {
    localStorage.setItem('agentis.access', 'access-1');
    localStorage.setItem('agentis.workspace', 'workspace-1');
    socketHarness.sockets.length = 0;
    socketHarness.create.mockClear();
  });

  afterEach(() => {
    disconnectRealtime();
  });

  it('rejoins active rooms whenever Socket.IO reconnects', () => {
    const stop = rtSubscribe('workflow', { workflowId: 'workflow-1' });
    const socket = socketHarness.sockets[0]!;

    expect(socket.emit).not.toHaveBeenCalledWith('subscribe:workflow', expect.anything());

    socket.connected = true;
    socket.trigger('connect');
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenLastCalledWith('subscribe:workflow', {
      workflowId: 'workflow-1',
      workspaceId: 'workspace-1',
    });

    socket.connected = false;
    socket.trigger('disconnect');
    socket.connected = true;
    socket.trigger('connect');
    expect(socket.emit).toHaveBeenCalledTimes(2);

    stop();
    expect(socket.emit).toHaveBeenLastCalledWith('unsubscribe:workflow', {
      workflowId: 'workflow-1',
      workspaceId: 'workspace-1',
    });
  });

  it('keeps a shared room joined until its final consumer unsubscribes', () => {
    const stopFirst = rtSubscribe('agent', { agentId: 'agent-1' });
    const stopSecond = rtSubscribe('agent', { agentId: 'agent-1' });
    const socket = socketHarness.sockets[0]!;
    socket.connected = true;
    socket.trigger('connect');

    expect(socket.emit).toHaveBeenCalledTimes(1);
    stopFirst();
    expect(socket.emit).toHaveBeenCalledTimes(1);
    stopSecond();
    expect(socket.emit).toHaveBeenCalledTimes(2);
    expect(socket.emit).toHaveBeenLastCalledWith('unsubscribe:agent', {
      agentId: 'agent-1',
      workspaceId: 'workspace-1',
    });
  });

  it('rebinds listeners and subscriptions after silent token rotation', () => {
    const received: RealtimeEnvelope[] = [];
    const hook = renderHook(() => useRealtime(['test:event'], (env) => received.push(env)));
    const stop = rtSubscribe('workflow', { workflowId: 'workflow-1' });
    const firstSocket = socketHarness.sockets[0]!;
    firstSocket.connected = true;
    firstSocket.trigger('connect');
    firstSocket.trigger('test:event', {
      event: 'test:event', payload: { generation: 1 }, emittedAt: '2026-07-13T12:00:00.000Z',
    });

    localStorage.setItem('agentis.access', 'access-2');
    window.dispatchEvent(new CustomEvent('agentis:auth-changed'));

    const secondSocket = socketHarness.sockets[1]!;
    expect(firstSocket.disconnect).toHaveBeenCalledOnce();
    secondSocket.connected = true;
    secondSocket.trigger('connect');
    secondSocket.trigger('test:event', {
      event: 'test:event', payload: { generation: 2 }, emittedAt: '2026-07-13T12:00:01.000Z',
    });

    expect(secondSocket.emit).toHaveBeenCalledWith('subscribe:workflow', {
      workflowId: 'workflow-1',
      workspaceId: 'workspace-1',
    });
    expect(received.map((env) => env.payload)).toEqual([
      { generation: 1 },
      { generation: 2 },
    ]);

    stop();
    hook.unmount();
  });
});
