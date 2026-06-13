/**
 * Pure node handlers (NATIVE-ADVANCEMENT Proposal 4) — extracted verbatim from
 * the engine's former `#executeTransform` / `#executeFilter`. They are pure
 * functions of (config, inputData, templateContext), which is exactly why they
 * are the safe first kinds to lift out of the God Object.
 */

import type { FilterNodeConfig, TransformNodeConfig } from '@agentis/core';
import { evaluateExpression, evaluateBooleanExpression } from '../safeExpression.js';
import type { NodeHandlerRegistry, PureNodeHandler } from './NodeHandler.js';

export const transformHandler: PureNodeHandler<TransformNodeConfig> = {
  kind: 'transform',
  execute(config, { inputData, tctx }) {
    const result = evaluateExpression<unknown>(config.expression, {
      input: inputData,
      ctx: { trigger: tctx.trigger, nodes: tctx.nodes, scratchpad: tctx.scratchpad, store: tctx.store },
    }, { timeoutMs: config.timeoutMs });
    if (config.outputKey) return { [config.outputKey]: result };
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return { value: result };
  },
};

export const filterHandler: PureNodeHandler<FilterNodeConfig> = {
  kind: 'filter',
  execute(config, { inputData, tctx }) {
    const passed = evaluateBooleanExpression(config.condition, {
      input: inputData,
      ctx: { trigger: tctx.trigger, nodes: tctx.nodes, scratchpad: tctx.scratchpad, store: tctx.store },
    }, { timeoutMs: config.timeoutMs });
    // Single payload tagged with the result so downstream nodes can read the
    // boolean or gate on it via a conditional edge.
    return { passed, input: inputData };
  },
};

/** Register every pure node handler into a registry. */
export function registerPureNodeHandlers(registry: NodeHandlerRegistry): void {
  registry.register(transformHandler);
  registry.register(filterHandler);
}
