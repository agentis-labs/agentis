/**
 * Three-state circuit breaker for adapters and outbound bridge calls.
 *
 *   CLOSED   → calls flow normally; failure counter increments on errors
 *   OPEN     → calls fail fast for `cooldownMs` after threshold breached
 *   HALF_OPEN→ a single trial call decides the next state
 *
 * The dashboard surfaces the state through whatever owner exposes
 * `state()`, so an operator always sees why an adapter is silent.
 */

export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

export class CircuitBreaker {
  #state: CircuitBreakerState = 'closed';
  #failures = 0;
  #openedAt = 0;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  state(): CircuitBreakerState {
    if (this.#state === 'open' && Date.now() - this.#openedAt >= this.opts.cooldownMs) {
      this.#state = 'half_open';
    }
    return this.#state;
  }

  /** Wrap an async call; throws ADAPTER_UNAVAILABLE-style errors when open. */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const s = this.state();
    if (s === 'open') {
      throw new Error('circuit_breaker_open');
    }
    try {
      const out = await fn();
      this.#onSuccess();
      return out;
    } catch (err) {
      this.#onFailure();
      throw err;
    }
  }

  #onSuccess(): void {
    this.#failures = 0;
    this.#state = 'closed';
  }

  #onFailure(): void {
    this.#failures += 1;
    if (this.#state === 'half_open' || this.#failures >= this.opts.failureThreshold) {
      this.#state = 'open';
      this.#openedAt = Date.now();
    }
  }
}
