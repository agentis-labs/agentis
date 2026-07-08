/**
 * resolveParallelism — engine tick-concurrency resolver.
 *
 * Guards the footgun where `AGENTIS_WORKFLOW_PARALLELISM=unbounded` resolved to
 * Number.MAX_SAFE_INTEGER, letting one fan-out schedule effectively limitless
 * dispatches. Everything is now bounded by a hard ceiling.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveParallelism, WORKFLOW_PARALLELISM_HARD_CAP } from '../../src/engine/WorkflowEngine.js';

const original = process.env.AGENTIS_WORKFLOW_PARALLELISM;
afterEach(() => {
  if (original === undefined) delete process.env.AGENTIS_WORKFLOW_PARALLELISM;
  else process.env.AGENTIS_WORKFLOW_PARALLELISM = original;
});

describe('resolveParallelism', () => {
  it('caps "unbounded" at the hard ceiling instead of MAX_SAFE_INTEGER', () => {
    process.env.AGENTIS_WORKFLOW_PARALLELISM = 'unbounded';
    expect(resolveParallelism()).toBe(WORKFLOW_PARALLELISM_HARD_CAP);
    expect(resolveParallelism()).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('caps an oversized explicit number at the hard ceiling', () => {
    process.env.AGENTIS_WORKFLOW_PARALLELISM = '100000';
    expect(resolveParallelism()).toBe(WORKFLOW_PARALLELISM_HARD_CAP);
  });

  it('honors a sane explicit number', () => {
    process.env.AGENTIS_WORKFLOW_PARALLELISM = '12';
    expect(resolveParallelism()).toBe(12);
  });

  it('falls back to 8 for non-numeric junk', () => {
    process.env.AGENTIS_WORKFLOW_PARALLELISM = 'nonsense';
    expect(resolveParallelism()).toBe(8);
  });

  it('never exceeds the ceiling on "auto"', () => {
    process.env.AGENTIS_WORKFLOW_PARALLELISM = 'auto';
    const n = resolveParallelism();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(WORKFLOW_PARALLELISM_HARD_CAP);
  });
});
