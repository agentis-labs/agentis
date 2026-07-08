/**
 * Node handler registry + pure handlers (NATIVE-ADVANCEMENT Proposal 4).
 */
import { describe, it, expect } from 'vitest';
import { NodeHandlerRegistry } from '../../src/engine/handlers/NodeHandler.js';
import { registerPureNodeHandlers, transformHandler, filterHandler } from '../../src/engine/handlers/pureHandlers.js';
import { buildTemplateContext } from '../../src/engine/templateResolver.js';

const tctx = buildTemplateContext({ triggerInputs: {}, nodeOutputs: {}, scratchpad: {}, store: {} });

describe('NodeHandlerRegistry', () => {
  it('registers and resolves pure handlers by kind', () => {
    const reg = new NodeHandlerRegistry();
    registerPureNodeHandlers(reg);
    expect(reg.has('transform')).toBe(true);
    expect(reg.has('filter')).toBe(true);
    expect(reg.has('agent_task')).toBe(false);
    expect(reg.get('transform')).toBe(transformHandler);
    expect(reg.kinds().sort()).toEqual(['filter', 'transform']);
  });
});

describe('transformHandler', () => {
  it('evaluates the expression into an object output', () => {
    const out = transformHandler.execute({ kind: 'transform', expression: '({ doubled: input.n * 2 })' } as never, { inputData: { n: 21 }, tctx });
    expect(out).toEqual({ doubled: 42 });
  });
  it('wraps a scalar under outputKey', () => {
    const out = transformHandler.execute({ kind: 'transform', expression: 'input.n + 1', outputKey: 'next' } as never, { inputData: { n: 1 }, tctx });
    expect(out).toEqual({ next: 2 });
  });
});

describe('filterHandler', () => {
  it('tags the payload with the boolean result', () => {
    expect(filterHandler.execute({ kind: 'filter', condition: 'input.score > 5' } as never, { inputData: { score: 8 }, tctx }))
      .toEqual({ passed: true, input: { score: 8 } });
    expect(filterHandler.execute({ kind: 'filter', condition: 'input.score > 5' } as never, { inputData: { score: 4 }, tctx }))
      .toEqual({ passed: false, input: { score: 4 } });
  });
});
