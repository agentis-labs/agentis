/**
 * In-process realtime event bus.
 *
 * Wraps Node's EventEmitter with the closed RealtimeEvent enumeration so
 * the rest of the app cannot accidentally publish ad-hoc strings. The bus
 * fans out to:
 *   - Socket.io rooms (rooms.ts)
 *   - any in-process subscriber (engine, services, dashboard SSE fallback)
 *
 * Standard mode swaps this with a Redis-backed pub/sub adapter; the public
 * `EventBus` interface stays identical so callers never branch on mode.
 */

import { EventEmitter } from 'node:events';
import type { RealtimeEnvelope, RealtimeEventName } from '@agentis/core';

export interface BusMessage {
  /** One of the room key strings produced by REALTIME_ROOMS. */
  room: string;
  envelope: RealtimeEnvelope;
}

export type BusListener = (msg: BusMessage) => void;

export interface EventBus {
  publish(room: string, event: RealtimeEventName, payload: unknown, correlationId?: string): void;
  subscribe(listener: BusListener): () => void;
}

export function createInProcessEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(1024);
  const CHANNEL = 'msg';

  return {
    publish(room, event, payload, correlationId) {
      const envelope: RealtimeEnvelope = {
        event,
        payload,
        emittedAt: new Date().toISOString(),
        ...(correlationId ? { correlationId } : {}),
      };
      emitter.emit(CHANNEL, { room, envelope } satisfies BusMessage);
    },
    subscribe(listener) {
      emitter.on(CHANNEL, listener);
      return () => emitter.off(CHANNEL, listener);
    },
  };
}
