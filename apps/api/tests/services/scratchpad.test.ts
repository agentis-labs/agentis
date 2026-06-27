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

  it('write persists per-run + emits SCRATCHPAD_WRITTEN and BLACKBOARD_ENTRY', () => {
    pad.write('r1', 'foo', { x: 1 });
    expect(pad.read('r1', 'foo')).toEqual({ x: 1 });
    // Legacy State Surfaces event + the new identity-tagged blackboard entry.
    expect(events.length).toBe(2);
    const names = events.map((e) => e.envelope.event);
    expect(names).toContain(REALTIME_EVENTS.SCRATCHPAD_WRITTEN);
    expect(names).toContain(REALTIME_EVENTS.BLACKBOARD_ENTRY);
    expect(events[0]?.room).toBe('run:r1');
  });

  it('records identity-tagged entries readable via listEntries', () => {
    pad.write('r1', 'open_bugs', [1, 2], { identity: { agentId: 'a1', runtime: 'opus', label: 'Researcher' }, namespace: 'bughunt', iteration: 0 });
    const entries = pad.listEntries('r1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'fact',
      key: 'open_bugs',
      namespace: 'bughunt',
      iteration: 0,
      author: { agentId: 'a1', runtime: 'opus', label: 'Researcher' },
    });
  });

  it('claim records a confidence + supersede chain', () => {
    const first = pad.claim('r1', 'bug #3 fixed', { identity: { runtime: 'codex' }, confidence: 0.9 });
    const second = pad.claim('r1', 'bug #3 NOT fixed — test still red', { identity: { runtime: 'opus' }, confidence: 0.8, supersedes: first });
    const claims = pad.listEntries('r1').filter((e) => e.kind === 'claim');
    expect(claims).toHaveLength(2);
    expect(claims[1]?.supersedes).toBe(first);
    expect(second).not.toBe(first);
  });

  it('broadcast appears as a message entry with author identity', () => {
    pad.broadcast('r1', 'converge', 'a1', 'done: all green', { identity: { agentId: 'a1', runtime: 'opus' } });
    const messages = pad.listEntries('r1').filter((e) => e.kind === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ channel: 'converge', value: 'done: all green', author: { runtime: 'opus' } });
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
