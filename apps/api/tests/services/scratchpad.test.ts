/**
 * ScratchpadService — read/write/delete + bus emissions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { createInProcessEventBus, type BusMessage } from '../../src/event-bus.js';
import { createLogger } from '../../src/logger.js';
import { REALTIME_EVENTS } from '@agentis/core';

let pad: ScratchpadService;
let events: BusMessage[];

beforeEach(() => {
  const bus = createInProcessEventBus();
  events = [];
  bus.subscribe((m) => events.push(m));
  pad = new ScratchpadService(bus, createLogger({ level: 'error' }));
});

describe('ScratchpadService', () => {
  it('read returns undefined for unknown keys', () => {
    expect(pad.read('r1', 'missing')).toBeUndefined();
  });

  it('write persists per-run + emits SCRATCHPAD_WRITTEN', () => {
    pad.write('r1', 'foo', { x: 1 });
    expect(pad.read('r1', 'foo')).toEqual({ x: 1 });
    expect(events.length).toBe(1);
    expect(events[0]?.envelope.event).toBe(REALTIME_EVENTS.SCRATCHPAD_WRITTEN);
    expect(events[0]?.room).toBe('run:r1');
  });

  it('writes are isolated across runs', () => {
    pad.write('r1', 'foo', 1);
    pad.write('r2', 'foo', 2);
    expect(pad.read('r1', 'foo')).toBe(1);
    expect(pad.read('r2', 'foo')).toBe(2);
  });

  it('delete removes the key + emits a tombstone event', () => {
    pad.write('r1', 'foo', 'bar');
    events.length = 0;
    pad.delete('r1', 'foo');
    expect(pad.read('r1', 'foo')).toBeUndefined();
    expect(events[0]?.envelope.payload).toMatchObject({ deleted: true });
  });

  it('snapshotOf returns a plain object map', () => {
    pad.write('r1', 'a', 1);
    pad.write('r1', 'b', 2);
    expect(pad.snapshotOf('r1')).toEqual({ a: 1, b: 2 });
    expect(pad.snapshotOf('missing')).toEqual({});
  });

  it('dispose drops the entire pad', () => {
    pad.write('r1', 'a', 1);
    pad.dispose('r1');
    expect(pad.snapshotOf('r1')).toEqual({});
  });
});
