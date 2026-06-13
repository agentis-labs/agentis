/**
 * Fire-policy controller — EXTENSIONS-AND-LISTENER-10X §1.5.
 *
 * Sits between the predicate (which already said "this event matters") and the
 * actual workflow fire. It shapes a stream of matching events into runs:
 *
 *   immediate     1 event → 1 run, no delay
 *   batch         collect N events (or wait maxWaitMs) → 1 run with all of them
 *   debounce      fire the latest event once the stream goes quiet for windowMs
 *   throttle      at most one run per window; newest event wins
 *   leading_edge  fire on the first event, then ignore everything for cooldownMs
 *
 * `leading_edge` is the canonical mode for agent workflows: a burst of 50
 * related events should spawn one run, not fifty.
 */

import type { FirePolicy, FirePolicyMode } from '@agentis/core';
import { getPath } from './jsonpath.js';

interface PendingEvent {
  event: Record<string, unknown>;
  eventId: string;
}

export interface FirePolicyCallbacks {
  /** Fire a run from one or more events. `triggerEventId` is the event credited in health. */
  onFire(events: Record<string, unknown>[], triggerEventId: string): void;
  /** An event was dropped by the policy (debounced/throttled/cooled-down). */
  onSuppress(eventId: string, mode: FirePolicyMode): void;
}

export class FirePolicyController {
  readonly #policy: FirePolicy;
  readonly #cb: FirePolicyCallbacks;

  // leading_edge / throttle
  #cooldownUntil = 0;
  // throttle trailing
  #throttlePending: PendingEvent | null = null;
  #throttleTimer: ReturnType<typeof setTimeout> | null = null;
  // debounce
  #debouncePending: PendingEvent | null = null;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // batch
  #batch: PendingEvent[] = [];
  #batchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(policy: FirePolicy | undefined, callbacks: FirePolicyCallbacks) {
    this.#policy = policy ?? { mode: 'immediate' };
    this.#cb = callbacks;
  }

  submit(event: Record<string, unknown>, eventId: string): void {
    const p = this.#policy;
    switch (p.mode) {
      case 'immediate':
        this.#cb.onFire([event], eventId);
        return;
      case 'leading_edge': {
        const now = Date.now();
        if (now < this.#cooldownUntil) {
          this.#cb.onSuppress(eventId, 'leading_edge');
          return;
        }
        this.#cooldownUntil = now + p.cooldownMs;
        this.#cb.onFire([event], eventId);
        return;
      }
      case 'throttle':
        this.#submitThrottle(p.windowMs, event, eventId);
        return;
      case 'debounce':
        this.#submitDebounce(p.windowMs, event, eventId);
        return;
      case 'batch':
        this.#submitBatch(p.size, p.maxWaitMs, p.coalesceKey, event, eventId);
        return;
    }
  }

  #submitThrottle(windowMs: number, event: Record<string, unknown>, eventId: string): void {
    const now = Date.now();
    if (now >= this.#cooldownUntil) {
      // window open → fire immediately and start a window
      this.#cooldownUntil = now + windowMs;
      this.#cb.onFire([event], eventId);
      return;
    }
    // inside window → keep newest, suppress the previously held one
    if (this.#throttlePending) this.#cb.onSuppress(this.#throttlePending.eventId, 'throttle');
    this.#throttlePending = { event, eventId };
    if (!this.#throttleTimer) {
      const delay = Math.max(0, this.#cooldownUntil - now);
      this.#throttleTimer = setTimeout(() => this.#flushThrottle(windowMs), delay);
      this.#throttleTimer.unref?.();
    }
  }

  #flushThrottle(windowMs: number): void {
    this.#throttleTimer = null;
    const pending = this.#throttlePending;
    this.#throttlePending = null;
    if (pending) {
      this.#cooldownUntil = Date.now() + windowMs;
      this.#cb.onFire([pending.event], pending.eventId);
    }
  }

  #submitDebounce(windowMs: number, event: Record<string, unknown>, eventId: string): void {
    if (this.#debouncePending) this.#cb.onSuppress(this.#debouncePending.eventId, 'debounce');
    this.#debouncePending = { event, eventId };
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      const pending = this.#debouncePending;
      this.#debouncePending = null;
      if (pending) this.#cb.onFire([pending.event], pending.eventId);
    }, windowMs);
    this.#debounceTimer.unref?.();
  }

  #submitBatch(
    size: number,
    maxWaitMs: number,
    coalesceKey: string | undefined,
    event: Record<string, unknown>,
    eventId: string,
  ): void {
    if (coalesceKey) {
      const key = getPath(event, coalesceKey);
      const existingIdx = this.#batch.findIndex((p) => getPath(p.event, coalesceKey) !== undefined && String(getPath(p.event, coalesceKey)) === String(key));
      const existing = existingIdx >= 0 ? this.#batch[existingIdx] : undefined;
      if (existing) {
        this.#cb.onSuppress(existing.eventId, 'batch');
        this.#batch[existingIdx] = { event, eventId };
        if (this.#batch.length >= size) this.#flushBatch();
        return;
      }
    }
    this.#batch.push({ event, eventId });
    if (this.#batch.length >= size) {
      this.#flushBatch();
      return;
    }
    if (!this.#batchTimer) {
      this.#batchTimer = setTimeout(() => this.#flushBatch(), maxWaitMs);
      this.#batchTimer.unref?.();
    }
  }

  #flushBatch(): void {
    if (this.#batchTimer) {
      clearTimeout(this.#batchTimer);
      this.#batchTimer = null;
    }
    if (this.#batch.length === 0) return;
    const batch = this.#batch;
    this.#batch = [];
    const last = batch[batch.length - 1]!;
    this.#cb.onFire(batch.map((p) => p.event), last.eventId);
  }

  /** Flush anything buffered and clear timers (called on close/fire-now). */
  flush(): void {
    this.#flushBatch();
  }

  close(): void {
    for (const t of [this.#throttleTimer, this.#debounceTimer, this.#batchTimer]) {
      if (t) clearTimeout(t);
    }
    this.#throttleTimer = null;
    this.#debounceTimer = null;
    this.#batchTimer = null;
    this.#batch = [];
    this.#throttlePending = null;
    this.#debouncePending = null;
  }
}
