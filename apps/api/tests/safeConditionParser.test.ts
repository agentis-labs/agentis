/**
 * SafeConditionParser — V1-SPEC §6 / D07.
 *
 * Why these tests: the parser is the single chokepoint that protects
 * Agentis from arbitrary JS execution in workflow edge conditions and
 * router branches. A regression here is a remote-code-execution class
 * bug, not a feature regression.
 */
import { describe, it, expect } from 'vitest';
import {
  evalCondition,
} from '../src/engine/SafeConditionParser.js';

describe('evalCondition', () => {
  const scope = {
    inputs: { count: 3, label: 'beta', flag: true },
    output: { score: 0.8, items: ['a', 'b'] },
    scratchpad: { mode: 'ready' },
  };

  it('returns true for empty / whitespace conditions (n8n parity)', () => {
    expect(evalCondition('', scope)).toBe(true);
    expect(evalCondition('   ', scope)).toBe(true);
  });

  it('compares numbers and strings against scope paths', () => {
    expect(evalCondition('inputs.count > 2', scope)).toBe(true);
    expect(evalCondition('inputs.count >= 3', scope)).toBe(true);
    expect(evalCondition('inputs.count < 3', scope)).toBe(false);
    expect(evalCondition('inputs.label == "beta"', scope)).toBe(true);
    expect(evalCondition('inputs.label != "alpha"', scope)).toBe(true);
  });

  it('supports && / || / ! with proper precedence', () => {
    expect(evalCondition('inputs.flag && output.score > 0.5', scope)).toBe(true);
    expect(evalCondition('inputs.flag && output.score > 0.95', scope)).toBe(false);
    expect(evalCondition('!inputs.flag', scope)).toBe(false);
    expect(evalCondition('!inputs.flag || output.score > 0.5', scope)).toBe(true);
  });

  it('supports bracket indexing for arrays and string keys', () => {
    expect(evalCondition('output.items[0] == "a"', scope)).toBe(true);
    expect(evalCondition('output["score"] > 0.5', scope)).toBe(true);
  });

  it('treats unknown paths as undefined (n8n parity, no eval surface)', () => {
    // The parser does not throw on unknown roots — it returns `undefined`
    // so authors can write `inputs.maybe` without exploding. The point of
    // this test is to PROVE there is no eval surface: even paths that
    // resolve to global names like `process` or `console` cannot reach
    // the host runtime.
    expect(evalCondition('process.env.SECRET == "x"', scope)).toBe(false);
    expect(evalCondition('console == null', scope)).toBe(true);
  });

  it('throws SafeConditionError on unparseable input', () => {
    expect(() => evalCondition('inputs.count > > 1', scope)).toThrow();
    expect(() => evalCondition('"unterminated', scope)).toThrow();
  });

  it('rejects function calls — no eval surface', () => {
    expect(() => evalCondition('inputs.count + 1', scope)).toThrow();
    expect(() => evalCondition('alert(1)', scope)).toThrow();
  });
});
