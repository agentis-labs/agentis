/**
 * WaitingInputBuffer — fan-in satisfaction.
 */
import { describe, it, expect } from 'vitest';
import { WaitingInputBuffer } from '../../src/engine/WaitingInputBuffer.js';
import type { WorkflowRunState } from '@agentis/core';

type Map = WorkflowRunState['waitingInputs'];

function make(): Map {
  return {
    n3: { requiredInputs: ['n1', 'n2'], receivedInputs: {}, sourceNodeIds: ['n1', 'n2'] },
  };
}

describe('WaitingInputBuffer', () => {
  it('has() returns true for tracked nodes', () => {
    const buf = new WaitingInputBuffer(make());
    expect(buf.has('n3')).toBe(true);
    expect(buf.has('missing')).toBe(false);
  });

  it('get() returns the underlying entry', () => {
    const map = make();
    const buf = new WaitingInputBuffer(map);
    expect(buf.get('n3')).toBe(map.n3);
  });

  it('satisfy() returns false when more inputs remain', () => {
    const buf = new WaitingInputBuffer(make());
    expect(buf.satisfy('n3', 'n1', { x: 1 })).toBe(false);
  });

  it('satisfy() returns true once the last required input arrives', () => {
    const buf = new WaitingInputBuffer(make());
    expect(buf.satisfy('n3', 'n1', { x: 1 })).toBe(false);
    expect(buf.satisfy('n3', 'n2', { y: 2 })).toBe(true);
  });

  it('satisfy() stores the payload on receivedInputs', () => {
    const map = make();
    const buf = new WaitingInputBuffer(map);
    buf.satisfy('n3', 'n1', { x: 1 });
    expect(map.n3?.receivedInputs.n1).toEqual({ x: 1 });
  });

  it('satisfy() on an unknown node returns true (no-op)', () => {
    const buf = new WaitingInputBuffer(make());
    expect(buf.satisfy('missing', 'n1', {})).toBe(true);
  });

  it('remove() drops an entry', () => {
    const map = make();
    const buf = new WaitingInputBuffer(map);
    buf.remove('n3');
    expect(buf.has('n3')).toBe(false);
  });

  it('pendingNodeIds() lists current keys', () => {
    const buf = new WaitingInputBuffer(make());
    expect(buf.pendingNodeIds()).toEqual(['n3']);
  });
});
