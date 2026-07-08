/**
 * CircuitBreaker — open / half-open / closed state machine.
 */
import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker } from '../../src/adapters/CircuitBreaker.js';

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
    expect(cb.state()).toBe('closed');
  });

  it('opens after failureThreshold consecutive failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100 });
    await expect(cb.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    await expect(cb.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(cb.state()).toBe('open');
  });

  it('fails fast while open with circuit_breaker_open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    await expect(cb.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    await expect(cb.exec(async () => 'wont-run')).rejects.toThrow('circuit_breaker_open');
  });

  it('transitions to half_open after cooldown elapses', async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50 });
      await expect(cb.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      expect(cb.state()).toBe('open');
      vi.advanceTimersByTime(60);
      expect(cb.state()).toBe('half_open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('half_open + success → closed and resets failure counter', async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10 });
      await expect(cb.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      vi.advanceTimersByTime(20);
      expect(cb.state()).toBe('half_open');
      const result = await cb.exec(async () => 'ok');
      expect(result).toBe('ok');
      expect(cb.state()).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('half_open + failure → open again', async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10 });
      await expect(cb.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow();
      vi.advanceTimersByTime(20);
      expect(cb.state()).toBe('half_open');
      await expect(cb.exec(async () => Promise.reject(new Error('y')))).rejects.toThrow();
      expect(cb.state()).toBe('open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('successive successes keep state closed', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 100 });
    for (let i = 0; i < 5; i++) {
      const v = await cb.exec(async () => i);
      expect(v).toBe(i);
    }
    expect(cb.state()).toBe('closed');
  });
});
