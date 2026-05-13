/**
 * Realtime hook over socket.io.
 *
 * Single connection per session; subscribes to whatever rooms the caller
 * declares. The bridge enforces ownership server-side, so we don't repeat
 * those checks here.
 */

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { tokens, workspace as workspaceStore } from './api';

let sharedSocket: Socket | null = null;
let sharedSocketToken: string | null = null;

function getSocket(): Socket {
  const token = tokens.access();
  if (sharedSocket && sharedSocketToken === token) return sharedSocket;
  if (sharedSocket) {
    sharedSocket.disconnect();
    sharedSocket = null;
  }
  sharedSocketToken = token;
  sharedSocket = io({
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
  });
  return sharedSocket;
}

export function disconnectRealtime() {
  sharedSocket?.disconnect();
  sharedSocket = null;
  sharedSocketToken = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('agentis:auth-changed', disconnectRealtime);
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
  kind: 'workspace' | 'run' | 'workflow' | 'gateway' | 'agent' | 'conversation' | 'room',
  args: Record<string, string>,
): () => void {
  const sock = getSocket();
  const workspaceId = args.workspaceId ?? workspaceStore.get() ?? '';
  const nextArgs = { ...args, workspaceId };
  if (kind === 'workspace') sock.emit('subscribe:workspace', workspaceId);
  else sock.emit(`subscribe:${kind}`, nextArgs);
  return () => {
    if (kind === 'workspace') sock.emit('unsubscribe:workspace', workspaceId);
    else sock.emit(`unsubscribe:${kind}`, nextArgs);
  };
}

export function emitRealtime(event: string, payload: unknown) {
  getSocket().emit(event, payload);
}
