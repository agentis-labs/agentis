/**
 * pursuitControl — the pure brain of the Pursuit primitive (cognitive loop).
 * Covers the multi-signal stagnation detector, progress scoring, and reflection
 * synthesis. See docs/COGNITIVE-LOOPING-RFC.md §6/§3.2/§8.
 */
import { describe, it, expect } from 'vitest';
import { detectStagnation, computeProgress, chooseReflection, toolCallSignature, isRepeatedToolCall } from '../../src/engine/pursuitControl.js';

describe('computeProgress', () => {
  it('done → 1', () => {
    expect(computeProgress({ continue: false })).toBe(1);
  });
  it('judge in progress → score/10', () => {
    expect(computeProgress({ continue: true, score: 6 })).toBeCloseTo(0.6);
  });
  it('deterministic in progress (no score) → 0', () => {
    expect(computeProgress({ continue: true })).toBe(0);
  });
  it('clamps out-of-range scores', () => {
    expect(computeProgress({ continue: true, score: 42 })).toBe(1);
    expect(computeProgress({ continue: true, score: -3 })).toBe(0);
  });
});

describe('detectStagnation — s1 structural repeat (converge parity)', () => {
  const base = { signatureRing: [], deltaTrajectory: [], assess: false, graded: false, window: 2 } as const;

  it('first pass never stalls', () => {
    const r = detectStagnation({ ...base, signature: 'a', prevSignature: undefined, prevStallStreak: 0 });
    expect(r.stalled).toBe(false);
    expect(r.stallStreak).toBe(0);
  });

  it('two identical outputs stall at window=2', () => {
    const r = detectStagnation({ ...base, signature: 'a', prevSignature: 'a', prevStallStreak: 0 });
    expect(r.stallStreak).toBe(1);
    expect(r.stalled).toBe(true); // stallStreak + 1 >= window
    expect(r.reasons).toContain('structural_repeat');
  });

  it('a changed output resets the streak and clears the stall', () => {
    const r = detectStagnation({ ...base, signature: 'b', prevSignature: 'a', prevStallStreak: 3 });
    expect(r.stallStreak).toBe(0);
    expect(r.stalled).toBe(false);
  });

  it('converge mode ignores oscillation (assess off)', () => {
    const r = detectStagnation({ ...base, signature: 'a', prevSignature: 'b', prevStallStreak: 0, signatureRing: ['a', 'b'] });
    expect(r.stalled).toBe(false); // would be oscillation, but assess is off
  });
});

describe('detectStagnation — pursue mode extras', () => {
  it('s5 oscillation: a state seen before but not immediately prior', () => {
    const r = detectStagnation({
      signature: 'a', prevSignature: 'b', prevStallStreak: 0,
      signatureRing: ['a', 'b'], deltaTrajectory: [0.5, 0.5, 0.5],
      window: 2, assess: true, graded: false,
    });
    expect(r.stalled).toBe(true);
    expect(r.reasons).toContain('oscillation');
  });

  it('s4 regression: progress dropped materially', () => {
    const r = detectStagnation({
      signature: 'z', prevSignature: 'y', prevStallStreak: 0,
      signatureRing: [], deltaTrajectory: [0.8, 0.6], // 0.6 < 0.8 - 0.05
      window: 2, assess: true, graded: true,
    });
    expect(r.stalled).toBe(true);
    expect(r.reasons).toContain('regression');
  });

  it('s3 plateau: progress flat across the window (and not already done)', () => {
    const r = detectStagnation({
      signature: 'z', prevSignature: 'y', prevStallStreak: 0,
      signatureRing: [], deltaTrajectory: [0.70, 0.70, 0.70], // window=2 → needs 3 samples
      window: 2, assess: true, graded: true,
    });
    expect(r.stalled).toBe(true);
    expect(r.reasons).toContain('plateau');
  });

  it('a flat trajectory at the goal (≈1) is success, not a plateau', () => {
    const r = detectStagnation({
      signature: 'z', prevSignature: 'y', prevStallStreak: 0,
      signatureRing: [], deltaTrajectory: [1, 1, 1],
      window: 2, assess: true, graded: true,
    });
    expect(r.stalled).toBe(false);
  });

  it('healthy monotonic progress does not stall', () => {
    const r = detectStagnation({
      signature: 'z', prevSignature: 'y', prevStallStreak: 0,
      signatureRing: [], deltaTrajectory: [0.2, 0.5, 0.8],
      window: 2, assess: true, graded: true,
    });
    expect(r.stalled).toBe(false);
    expect(r.reasons).toHaveLength(0);
  });
});

describe('chooseReflection', () => {
  it('prefers the judge critique when present (rung 1)', () => {
    const out = chooseReflection('the summary omits the Q3 figures', ['plateau'], 1);
    expect(out).toContain('the summary omits the Q3 figures');
    expect(out).toContain('plateau');
    expect(out.toLowerCase()).toContain('change approach');
  });

  it('synthesizes a structural hint when there is no critique', () => {
    const out = chooseReflection(undefined, ['structural_repeat', 'oscillation'], 1);
    expect(out).toContain('structural_repeat, oscillation');
    expect(out.toLowerCase()).toContain('change approach');
  });

  it('escalates the pivot ladder on later attempts, clamped to the last rung', () => {
    expect(chooseReflection(undefined, ['plateau'], 2).toLowerCase()).toContain('reframe');
    expect(chooseReflection(undefined, ['plateau'], 3).toLowerCase()).toContain('switch strategy');
    expect(chooseReflection(undefined, ['plateau'], 9).toLowerCase()).toContain('switch strategy');
  });
});

describe('s6 — tool-call loop guard', () => {
  it('toolCallSignature is order-independent in args', () => {
    expect(toolCallSignature('read', { a: 1, b: 2 })).toBe(toolCallSignature('read', { b: 2, a: 1 }));
    expect(toolCallSignature('read', { a: 1 })).not.toBe(toolCallSignature('write', { a: 1 }));
  });

  it('fires only once the same call would be the 3rd (default threshold)', () => {
    const sig = toolCallSignature('grep', { q: 'x' });
    expect(isRepeatedToolCall([], sig)).toBe(false);        // 1st
    expect(isRepeatedToolCall([sig], sig)).toBe(false);     // 2nd
    expect(isRepeatedToolCall([sig, sig], sig)).toBe(true); // 3rd → loop
  });

  it('a differing call resets nothing but is not counted', () => {
    const a = toolCallSignature('grep', { q: 'x' });
    const b = toolCallSignature('grep', { q: 'y' });
    expect(isRepeatedToolCall([a, b, a], a)).toBe(true); // a seen twice + this = 3
    expect(isRepeatedToolCall([a, b, a], b)).toBe(false); // b seen once + this = 2
  });
});
