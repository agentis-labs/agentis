/**
 * SafeConditionParser — extended coverage beyond the original 7 tests.
 *
 * Focus: the operator surface (variable resolution, comparisons, boolean
 * algebra, missing paths, and the security promise that no host capability
 * can leak through the parser).
 */
import { describe, it, expect } from 'vitest';
import { evalCondition } from '../../src/engine/SafeConditionParser.js';

const scope = {
  inputs: { count: 5, label: 'beta', flag: true, nested: { ok: true } },
  output: { score: 0.8, items: ['a', 'b', 'c'] },
  scratchpad: { mode: 'ready', empty: '' },
};

describe('SafeConditionParser — extended', () => {
  it('handles >= and <=', () => {
    expect(evalCondition('inputs.count <= 5', scope)).toBe(true);
    expect(evalCondition('inputs.count <= 4', scope)).toBe(false);
    expect(evalCondition('inputs.count >= 5', scope)).toBe(true);
    expect(evalCondition('inputs.count >= 6', scope)).toBe(false);
  });

  it('supports == equality and != inequality', () => {
    expect(evalCondition('inputs.count == 5', scope)).toBe(true);
    expect(evalCondition('inputs.count != 6', scope)).toBe(true);
  });

  it('resolves nested object paths', () => {
    expect(evalCondition('inputs.nested.ok', scope)).toBe(true);
    expect(evalCondition('inputs.nested.missing', scope)).toBe(false);
  });

  it('array length comparison via index', () => {
    expect(evalCondition('output.items[2] == "c"', scope)).toBe(true);
  });

  it('string equality is case sensitive', () => {
    expect(evalCondition('inputs.label == "BETA"', scope)).toBe(false);
    expect(evalCondition('inputs.label == "beta"', scope)).toBe(true);
  });

  it('parenthesized grouping respected', () => {
    expect(evalCondition('(inputs.flag && output.score > 0.5) || false', scope)).toBe(true);
    expect(evalCondition('inputs.flag && (output.score > 0.95 || false)', scope)).toBe(false);
  });

  it('null and undefined comparisons', () => {
    expect(evalCondition('inputs.missing == null', scope)).toBe(true);
    expect(evalCondition('inputs.missing != "x"', scope)).toBe(true);
  });

  it('numeric literals on either side', () => {
    expect(evalCondition('5 == inputs.count', scope)).toBe(true);
    expect(evalCondition('0 < inputs.count', scope)).toBe(true);
  });

  it('does not allow assignment expressions', () => {
    expect(() => evalCondition('inputs.count = 99', scope)).toThrow();
  });

  it('does not allow object-literal construction', () => {
    expect(() => evalCondition('{} == {}', scope)).toThrow();
  });

  it('does not allow template literals', () => {
    expect(() => evalCondition('`${inputs.count}` == "5"', scope)).toThrow();
  });

  it('whitespace around operators is tolerated', () => {
    expect(evalCondition('  inputs.count   ==   5  ', scope)).toBe(true);
  });
});
