/**
 * In-process EventBus — publish/subscribe contract.
 */
import { describe, it, expect } from 'vitest';
import { createInProcessEventBus, type BusMessage } from '../src/event-bus.js';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';

describe('createInProcessEventBus', () => {
  it('delivers published envelopes to subscribers with the room key', () => {
    const bus = createInProcessEventBus();
    const seen: BusMessage[] = [];
    bus.subscribe((m) => seen.push(m));
    bus.publish(REALTIME_ROOMS.run('r1'), REALTIME_EVENTS.RUN_RUNNING, { runId: 'r1' });
    expect(seen.length).toBe(1);
    expect(seen[0]?.room).toBe('run:r1');
    expect(seen[0]?.envelope.event).toBe('run.running');
    expect(seen[0]?.envelope.payload).toEqual({ runId: 'r1' });
    expect(seen[0]?.envelope.emittedAt).toMatch(/T/);
  });

  it('subscribe returns an unsubscribe handle', () => {
    const bus = createInProcessEventBus();
    let count = 0;
    const stop = bus.subscribe(() => {
      count++;
    });
    bus.publish('x', REALTIME_EVENTS.RUN_RUNNING, {});
    stop();
    bus.publish('x', REALTIME_EVENTS.RUN_RUNNING, {});
    expect(count).toBe(1);
  });

  it('attaches correlationId when provided', () => {
    const bus = createInProcessEventBus();
    let envelope: BusMessage['envelope'] | undefined;
    bus.subscribe((m) => {
      envelope = m.envelope;
    });
    bus.publish('room', REALTIME_EVENTS.NODE_STARTED, {}, 'corr-1');
    expect(envelope?.correlationId).toBe('corr-1');
  });

  it('supports multiple independent subscribers', () => {
    const bus = createInProcessEventBus();
    let a = 0;
    let b = 0;
    bus.subscribe(() => a++);
    bus.subscribe(() => b++);
    bus.publish('x', REALTIME_EVENTS.RUN_RUNNING, {});
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
