/**
 * Pure node handlers (NATIVE-ADVANCEMENT Proposal 4) — extracted verbatim from
 * the engine's former `#executeTransform` / `#executeFilter`. They are pure
 * functions of (config, inputData, templateContext), which is exactly why they
 * are the safe first kinds to lift out of the God Object.
 */

import type { FilterNodeConfig, TransformNodeConfig } from '@agentis/core';
import { evaluateExpression, evaluateBooleanExpression } from '../safeExpression.js';
import type { NodeHandlerRegistry, PureNodeHandler } from './NodeHandler.js';

/**
 * Full expression scope for the sandbox — the Unified Expression Contract
 * promises the SAME nine names everywhere. Dropping workspace/run/loop here
 * (as this once did) made `workspace.kv.x` / `run.id` / `loop.index` resolve
 * to a silent `{}`/undefined in transform/filter bodies — the exact silent-
 * undefined class the contract exists to kill.
 */
function fullScope(tctx: Parameters<PureNodeHandler['execute']>[1]['tctx']): Record<string, unknown> {
  return {
    trigger: tctx.trigger,
    nodes: tctx.nodes,
    scratchpad: tctx.scratchpad,
    store: tctx.store,
    ...(tctx.workspace ? { workspace: tctx.workspace } : {}),
    ...(tctx.run ? { run: tctx.run } : {}),
    ...(tctx.loop ? { loop: tctx.loop } : {}),
  };
}

export const transformHandler: PureNodeHandler<TransformNodeConfig> = {
  kind: 'transform',
  execute(config, { inputData, tctx }) {
    const result = evaluateExpression<unknown>(config.expression, {
      input: inputData,
      ctx: fullScope(tctx),
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
      ctx: fullScope(tctx),
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
