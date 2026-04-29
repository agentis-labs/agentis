/**
 * Realtime hook over socket.io.
 *
 * Single connection per session; subscribes to whatever rooms the caller
 * declares. The bridge enforces ownership server-side, so we don't repeat
 * those checks here.
 */

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { tokens } from './api';

let sharedSocket: Socket | null = null;

function getSocket(): Socket {
  if (sharedSocket) return sharedSocket;
  sharedSocket = io({
    auth: { token: tokens.access() },
    transports: ['websocket'],
    reconnection: true,
  });
  return sharedSocket;
}

export interface RealtimeEnvelope<TPayload = unknown> {
  event: string;
  payload: TPayload;
  emittedAt: string;
}

export function useRealtime(events: string[], handler: (env: RealtimeEnvelope) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const sock = getSocket();
    const wrapped = (env: RealtimeEnvelope) => handlerRef.current(env);
    for (const ev of events) sock.on(ev, wrapped);
    return () => {
      for (const ev of events) sock.off(ev, wrapped);
    };
  }, [events.join('|')]);
}

export function rtSubscribe(
  kind: 'workspace' | 'run' | 'workflow' | 'gateway' | 'agent' | 'conversation',
  args: Record<string, string>,
) {
  const sock = getSocket();
  if (kind === 'workspace') sock.emit('subscribe:workspace', args.workspaceId);
  else if (kind === 'run') sock.emit('subscribe:run', args);
  else if (kind === 'workflow') sock.emit('subscribe:workflow', args);
  else if (kind === 'gateway') sock.emit('subscribe:gateway', args);
  else if (kind === 'agent') sock.emit('subscribe:agent', args);
  else if (kind === 'conversation') sock.emit('subscribe:conversation', args);
}
