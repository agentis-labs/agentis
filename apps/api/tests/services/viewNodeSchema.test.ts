/**
 * viewNodeSchema regression guard — the recursive view-tree schema MUST be a
 * discriminated union, not a plain z.union.
 *
 * A plain z.union validates a malformed node against every member and aggregates
 * `unionErrors` recursively → O(members^depth). One bad deep view tree then
 * produced a multi-hundred-MB ZodError and OOM-killed the API ("JavaScript heap
 * out of memory", a 408-level-nested error blob). This test builds a deep
 * malformed tree and asserts the resulting error stays BOUNDED.
 */

import { describe, it, expect } from 'vitest';
import { viewNodeSchema } from '@agentis/core';

/**
 * A deeply-nested but INVALID tree: a LINEAR chain of single-child Stacks ending
 * in a Metric that omits its required fields. Single object reference per level
 * (NOT a shared-reference DAG — that would expand exponentially on traversal
 * regardless of the schema). This is the shape a model emits: plain nested JSON.
 * Under a plain z.union the ERROR object alone is ~O(members^depth); under a
 * discriminated union it stays linear.
 */
function deepBadTree(depth: number): unknown {
  let node: unknown = { type: 'Metric' /* missing required `label` + `value` */ };
  for (let i = 0; i < depth; i += 1) {
    node = { type: 'Stack', children: [node] };
  }
  return node;
}

describe('viewNodeSchema (discriminated union)', () => {
  it('parses a valid nested tree', () => {
    const ok = viewNodeSchema.safeParse({
      type: 'Stack',
      children: [
        { type: 'Hero', title: 'Welcome' },
        { type: 'Split', left: { type: 'Markdown', value: 'hi' }, right: { type: 'Metric', label: 'Total', value: 5 } },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('produces a BOUNDED error on a deep malformed tree (no exponential blowup)', () => {
    const result = viewNodeSchema.safeParse(deepBadTree(40));
    expect(result.success).toBe(false);
    if (result.success) return;
    // With a discriminated union the error follows ONE branch per level (linear).
    // A plain union here would generate a multi-MB＋ blob. Assert it stays small.
    const size = JSON.stringify(result.error.issues).length;
    expect(size).toBeLessThan(200_000);
  });

  it('reports a single discriminator error for an unknown type', () => {
    const result = viewNodeSchema.safeParse({ type: 'NotARealNode', foo: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toMatch(/discriminator|invalid_union_discriminator|Invalid/i);
  });
});
