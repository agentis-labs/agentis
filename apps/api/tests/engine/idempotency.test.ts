/**
 * Node idempotency keys (NATIVE-ADVANCEMENT AEJ).
 */
import { describe, it, expect } from 'vitest';
import { nodeIdempotencyKey } from '../../src/engine/idempotency.js';

describe('nodeIdempotencyKey', () => {
  it('is stable for the same run/node/attempt (survives crash → recovery)', () => {
    expect(nodeIdempotencyKey('run1', 'nodeA', 0)).toBe(nodeIdempotencyKey('run1', 'nodeA', 0));
  });

  it('differs by run, node, and attempt', () => {
    const base = nodeIdempotencyKey('run1', 'nodeA', 0);
    expect(nodeIdempotencyKey('run2', 'nodeA', 0)).not.toBe(base);
    expect(nodeIdempotencyKey('run1', 'nodeB', 0)).not.toBe(base);
    expect(nodeIdempotencyKey('run1', 'nodeA', 1)).not.toBe(base);
  });

  it('produces a compact hex token', () => {
    expect(nodeIdempotencyKey('r', 'n')).toMatch(/^[0-9a-f]{32}$/);
  });
});
