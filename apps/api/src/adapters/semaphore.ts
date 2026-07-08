/**
 * Semaphore — a minimal async counting semaphore.
 *
 * Used by AdapterManager to cap the number of concurrent child processes spawned
 * across ALL runs/swarms, so a fan-out can't exhaust the host's RAM/PIDs/file
 * handles. `acquire()` resolves immediately when a slot is free, otherwise queues
 * FIFO until a `release()` hands it the slot.
 */
export class Semaphore {
  readonly #max: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(max: number) {
    this.#max = Math.max(1, Math.floor(max));
  }

  /** Wait for a free slot. Resolves once the slot is held. */
  acquire(): Promise<void> {
    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.#queue.push(resolve));
  }

  /**
   * Return a slot. If a waiter is queued it is handed the slot directly (the
   * active count stays the same); otherwise the active count drops.
   */
  release(): void {
    const next = this.#queue.shift();
    if (next) {
      next();
      return;
    }
    this.#active = Math.max(0, this.#active - 1);
  }

  /** Slots currently held. */
  get active(): number {
    return this.#active;
  }

  /** Callers parked waiting for a slot. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** Configured ceiling. */
  get max(): number {
    return this.#max;
  }
}
