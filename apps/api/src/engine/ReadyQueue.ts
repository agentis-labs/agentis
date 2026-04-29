/**
 * ReadyQueue — V1-SPEC §3.3, §6.2 spec-named module.
 *
 * Thin wrapper around the `WorkflowRunState.readyQueue` array providing
 * the canonical FIFO contract the engine relies on:
 *  - `push(item)`     — enqueue a node ready to dispatch
 *  - `shift()`        — pop the next item or undefined
 *  - `peek()`         — inspect without removing
 *  - `size()`         — current queue depth
 *
 * The engine uses this surface for clarity; persistence still happens via
 * `RunStateStore` writing the entire `WorkflowRunState`.
 */

import type { ReadyQueueItem } from '@agentis/core';

export class ReadyQueue {
  constructor(private readonly items: ReadyQueueItem[]) {}

  push(item: ReadyQueueItem): void {
    this.items.push(item);
  }

  shift(): ReadyQueueItem | undefined {
    return this.items.shift();
  }

  peek(): ReadyQueueItem | undefined {
    return this.items[0];
  }

  size(): number {
    return this.items.length;
  }

  toArray(): readonly ReadyQueueItem[] {
    return this.items;
  }
}
