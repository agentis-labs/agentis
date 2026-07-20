/**
 * Deferred start — the shared "when should this begin?" resolver behind chain
 * link delays, staggered enrolment, and agent-scheduled runs.
 */
import { describe, expect, it } from 'vitest';
import { MAX_START_DELAY_MS, resolveStartAt, staggeredStarts } from '../../src/services/workflow/deferredStart.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');
/** Deterministic jitter: always the top of the range, so bounds are assertable. */
const maxRandom = () => 0.999_999;
const noRandom = () => 0;

describe('resolveStartAt', () => {
  it('returns null for an absent or empty spec so existing callers keep starting immediately', () => {
    expect(resolveStartAt(null, NOW)).toBeNull();
    expect(resolveStartAt(undefined, NOW)).toBeNull();
    expect(resolveStartAt({}, NOW)).toBeNull();
    expect(resolveStartAt({ startAt: null, delayMs: null, jitterMs: null }, NOW)).toBeNull();
  });

  it('resolves a relative delay', () => {
    expect(resolveStartAt({ delayMs: 5 * 60_000 }, NOW)).toBe('2026-07-20T12:05:00.000Z');
  });

  it('resolves an absolute instant, and adds delay on top of it', () => {
    expect(resolveStartAt({ startAt: '2026-07-20T18:30:00.000Z' }, NOW)).toBe('2026-07-20T18:30:00.000Z');
    expect(resolveStartAt({ startAt: '2026-07-20T18:30:00.000Z', delayMs: 60_000 }, NOW))
      .toBe('2026-07-20T18:31:00.000Z');
  });

  it('treats a past startAt as already due rather than stranding it', () => {
    expect(resolveStartAt({ startAt: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(NOW.toISOString());
  });

  it('keeps jitter inside [0, jitterMs)', () => {
    expect(resolveStartAt({ delayMs: 0, jitterMs: 10_000 }, NOW, noRandom)).toBe('2026-07-20T12:00:00.000Z');
    const high = resolveStartAt({ delayMs: 0, jitterMs: 10_000 }, NOW, maxRandom)!;
    expect(new Date(high).getTime() - NOW.getTime()).toBeLessThan(10_000);
  });

  it('applies jitter alone without any delay', () => {
    expect(resolveStartAt({ jitterMs: 5_000 }, NOW, noRandom)).toBe('2026-07-20T12:00:00.000Z');
  });

  it('rejects malformed, negative, and absurd values', () => {
    expect(() => resolveStartAt({ startAt: 'next tuesday' }, NOW)).toThrow(/ISO-8601/);
    expect(() => resolveStartAt({ delayMs: -1 }, NOW)).toThrow(/cannot be negative/);
    expect(() => resolveStartAt({ jitterMs: Number.NaN }, NOW)).toThrow(/finite/);
    expect(() => resolveStartAt({ delayMs: MAX_START_DELAY_MS + 1 }, NOW)).toThrow(/one-year cap/);
    expect(() => resolveStartAt({ startAt: '2099-01-01T00:00:00.000Z' }, NOW)).toThrow(/more than a year out/);
  });
});

describe('staggeredStarts', () => {
  it('spaces a batch by everyMs starting at now', () => {
    expect(staggeredStarts(3, { everyMs: 5 * 60_000 }, NOW)).toEqual([
      '2026-07-20T12:00:00.000Z',
      '2026-07-20T12:05:00.000Z',
      '2026-07-20T12:10:00.000Z',
    ]);
  });

  it('anchors a stagger to an absolute start', () => {
    expect(staggeredStarts(2, { startAt: '2026-07-21T09:00:00.000Z', everyMs: 60_000 }, NOW)).toEqual([
      '2026-07-21T09:00:00.000Z',
      '2026-07-21T09:01:00.000Z',
    ]);
  });

  it('returns all-immediate when no timing is asked for', () => {
    expect(staggeredStarts(3, {}, NOW)).toEqual([null, null, null]);
    expect(staggeredStarts(3, undefined, NOW)).toEqual([null, null, null]);
  });

  it('jitters each item independently rather than shifting the batch in lockstep', () => {
    // A random source that differs per call — a lockstep implementation would
    // produce identical offsets from the nominal 5-minute grid.
    let call = 0;
    const varying = () => [0, 0.5, 0.9][call++ % 3]!;
    const starts = staggeredStarts(3, { everyMs: 5 * 60_000, jitterMs: 60_000 }, NOW, varying);
    const offsets = starts.map((iso, index) =>
      new Date(iso!).getTime() - NOW.getTime() - index * 5 * 60_000);
    expect(new Set(offsets).size).toBe(3);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(60_000);
    }
  });

  it('handles the empty batch and rejects a bad count', () => {
    expect(staggeredStarts(0, { everyMs: 1_000 }, NOW)).toEqual([]);
    expect(() => staggeredStarts(-1, {}, NOW)).toThrow(/non-negative integer/);
  });
});
