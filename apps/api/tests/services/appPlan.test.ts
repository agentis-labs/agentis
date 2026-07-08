/**
 * app.plan — the plan-first decomposition ordering (GAP A1/B4). The dependency
 * order is the one non-trivial bit: a workflow must be built after everything it
 * dependsOn, so the returned checklist is executable top-to-bottom.
 */
import { describe, expect, it } from 'vitest';
import { orderByDependsOn } from '../../src/services/agentisToolHandlers/appPlan.js';

const wf = (key: string, dependsOn: string[] = []) => ({ key, title: key, purpose: key, dependsOn });

describe('orderByDependsOn', () => {
  it('places each workflow after the ones it depends on', () => {
    const order = orderByDependsOn([wf('deliver', ['build']), wf('build', ['find']), wf('find')]).map((w) => w.key);
    expect(order.indexOf('find')).toBeLessThan(order.indexOf('build'));
    expect(order.indexOf('build')).toBeLessThan(order.indexOf('deliver'));
  });

  it('keeps independent workflows and tolerates unknown deps without looping', () => {
    const order = orderByDependsOn([wf('a'), wf('b', ['ghost']), wf('c', ['a'])]).map((w) => w.key);
    expect(order).toHaveLength(3);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
  });

  it('does not hang on a dependency cycle (emits every node once)', () => {
    const order = orderByDependsOn([wf('x', ['y']), wf('y', ['x'])]).map((w) => w.key).sort();
    expect(order).toEqual(['x', 'y']);
  });
});
