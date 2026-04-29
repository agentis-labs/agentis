/**
 * ReadyQueue — FIFO contract.
 */
import { describe, it, expect } from 'vitest';
import { ReadyQueue } from '../../src/engine/ReadyQueue.js';
import type { ReadyQueueItem } from '@agentis/core';

const item = (nodeId: string): ReadyQueueItem => ({
  nodeId,
  priority: 0,
  insertedAt: new Date().toISOString(),
  inputData: {},
});

describe('ReadyQueue', () => {
  it('size starts at the underlying array length', () => {
    const q = new ReadyQueue([item('a'), item('b')]);
    expect(q.size()).toBe(2);
  });

  it('peek returns head without removing', () => {
    const q = new ReadyQueue([item('a'), item('b')]);
    expect(q.peek()?.nodeId).toBe('a');
    expect(q.size()).toBe(2);
  });

  it('shift returns FIFO order', () => {
    const q = new ReadyQueue([item('a'), item('b'), item('c')]);
    expect(q.shift()?.nodeId).toBe('a');
    expect(q.shift()?.nodeId).toBe('b');
    expect(q.shift()?.nodeId).toBe('c');
    expect(q.shift()).toBeUndefined();
  });

  it('push appends to the end', () => {
    const arr: ReadyQueueItem[] = [];
    const q = new ReadyQueue(arr);
    q.push(item('a'));
    q.push(item('b'));
    expect(arr.map((i) => i.nodeId)).toEqual(['a', 'b']);
  });

  it('toArray returns the live underlying view', () => {
    const arr = [item('a')];
    const q = new ReadyQueue(arr);
    q.push(item('b'));
    expect(q.toArray()).toBe(arr);
  });

  it('peek + shift return undefined on empty queue', () => {
    const q = new ReadyQueue([]);
    expect(q.peek()).toBeUndefined();
    expect(q.shift()).toBeUndefined();
    expect(q.size()).toBe(0);
  });
});
