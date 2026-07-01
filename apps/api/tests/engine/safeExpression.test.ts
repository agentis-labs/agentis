/**
 * Constrained expression evaluator — supports BOTH single-expression and
 * function-body (statement) transforms, so LLM-synthesized workflows run, not
 * only the trivial single-expression case. Security boundary (VM realm + static
 * guard) is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { evaluateExpression, evaluateBooleanExpression } from '../../src/engine/safeExpression.js';

describe('evaluateExpression', () => {
  it('evaluates a single object expression', () => {
    expect(evaluateExpression('({ doubled: input.n * 2 })', { input: { n: 21 } })).toEqual({ doubled: 42 });
  });

  it('evaluates a function body that uses `return` (the case that was failing)', () => {
    const expr = 'const to = input.email; return { to, subject: "Hi " + input.name };';
    expect(evaluateExpression(expr, { input: { email: 'a@b.co', name: 'Robson' } }))
      .toEqual({ to: 'a@b.co', subject: 'Hi Robson' });
  });

  it('evaluates a multi-statement body with control flow', () => {
    const expr = `
      const items = input.items || [];
      const total = items.reduce((s, x) => s + x, 0);
      if (total > 10) return { tier: "high", total };
      return { tier: "low", total };
    `;
    expect(evaluateExpression(expr, { input: { items: [4, 5, 6] } })).toEqual({ tier: 'high', total: 15 });
  });

  it('reads ctx (trigger/nodes/scratchpad/store)', () => {
    expect(evaluateExpression('({ x: ctx.trigger.topic })', { input: {}, ctx: { trigger: { topic: 'AI' } } }))
      .toEqual({ x: 'AI' });
  });

  it('exposes template-style aliases for inline AScript fields', () => {
    expect(evaluateExpression('({ name: $json.name.toUpperCase(), prior: $nodes.fetch.count, topic: $trigger.topic })', {
      input: { name: 'ada' },
      ctx: { trigger: { topic: 'AI' }, nodes: { fetch: { count: 3 } } },
    })).toEqual({ name: 'ADA', prior: 3, topic: 'AI' });
  });

  it('supports plain context aliases like `nodes` for workflow transforms', () => {
    expect(evaluateExpression(
      `({
        nowIso: new Date().toISOString(),
        sinceIso: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        sinceUnix: Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000),
        date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()),
        previousKeys: nodes['read-previous-ai-digest-state'].previouslySentStoryKeys || []
      })`,
      {
        input: {},
        ctx: {
          nodes: {
            'read-previous-ai-digest-state': {
              previouslySentStoryKeys: ['story-1', 'story-2'],
            },
          },
        },
      },
    )).toMatchObject({
      date: expect.any(String),
      previousKeys: ['story-1', 'story-2'],
    });
  });

  it('accepts the `inputs`/`output` aliases (AEC) so condition-valid expressions also run as transforms', () => {
    // Regression: the doctrine teaches `inputs[...]` for routers; an agent that
    // carried it into a transform used to die with "inputs is not defined".
    // The unified contract aliases inputs ≡ output ≡ input (router runtime parity).
    expect(evaluateExpression('({ rejected: inputs.candidates.filter((c) => c.score < 0.5) })', {
      input: { candidates: [{ score: 0.2 }, { score: 0.9 }] },
    })).toEqual({ rejected: [{ score: 0.2 }] });
    expect(evaluateExpression('({ echoed: output.value })', { input: { value: 7 } })).toEqual({ echoed: 7 });
    // The portable per-node accessor still works alongside the alias.
    expect(evaluateExpression('({ prior: inputs.value, byId: nodes.fetch.count })', {
      input: { value: 1 },
      ctx: { nodes: { fetch: { count: 3 } } },
    })).toEqual({ prior: 1, byId: 3 });
  });

  it('allows realistic transforms to exceed the old fixed 250ms deadline', () => {
    expect(evaluateExpression(
      'const until = Date.now() + 350; while (Date.now() < until) {} return { count: input.items.length };',
      { input: { items: Array.from({ length: 2_000 }, (_, index) => index) } },
    )).toEqual({ count: 2_000 });
  });

  it('still hard-stops runaway expressions with a bounded override', () => {
    expect(() => evaluateExpression('while (true) {}', { input: {} }, { timeoutMs: 20 }))
      .toThrow(/timed out/i);
  });

  it('evaluateBooleanExpression supports both forms', () => {
    expect(evaluateBooleanExpression('input.score > 5', { input: { score: 8 } })).toBe(true);
    expect(evaluateBooleanExpression('if (input.score > 5) return true; return false;', { input: { score: 2 } })).toBe(false);
  });

  it('still blocks dangerous tokens in either form', () => {
    expect(() => evaluateExpression('process.env', { input: {} })).toThrow(/blocked token/);
    expect(() => evaluateExpression('return require("fs");', { input: {} })).toThrow(/blocked token/);
    expect(() => evaluateExpression('return this.constructor.constructor("return process")();', { input: {} })).toThrow();
  });

  it('surfaces a clear error for a genuinely broken expression', () => {
    expect(() => evaluateExpression('const ;;; bad', { input: {} })).toThrow(/expression evaluation failed/);
  });
});
