/**
 * agentis.strategy.* — propose and inspect the competing approaches an App runs
 * to advance its Goal (Evolution Loop). A strategy maps to an experiment arm;
 * its confidence tracks MEASURED outcomes, and the controller promotes the winner
 * and spawns the next generation. Agents propose strategies + define the matching
 * experiment (agentis.experiment.define) with the same variants.
 */

import { AgentisError } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerStrategyTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.strategy.propose',
        family: 'run',
        mcpExposed: true,
        description:
          "Propose a competing STRATEGY for the App's Goal — one approach to test (e.g. \"open with a question\"). "
          + 'Link it to an experiment arm via `experimentKey` + `variant` (define the experiment with agentis.experiment.define using the same variants). '
          + 'Its confidence tracks measured outcomes; the winner is promoted and recalled into future runs. Idempotent by `key`.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App the strategy belongs to. Defaults to the current App context.' },
            key: { type: 'string', description: 'Stable strategy key within the App (e.g. "open_question").' },
            hypothesis: { type: 'string', description: 'The approach this strategy embodies — what you are testing.' },
            experimentKey: { type: 'string', description: 'Experiment this strategy competes in (matches agentis.experiment.define key).' },
            variant: { type: 'string', description: 'The experiment arm this strategy IS (e.g. "A").' },
            metric: { type: 'string', description: "North-star metric to measure. Defaults to the App Goal's metric." },
            parentId: { type: 'string', description: 'Strategy this was spawned from (for next-generation variants).' },
            generation: { type: 'number', description: 'Generation number; spawned variants increment it.' },
          },
          required: ['key', 'hypothesis'],
        },
        mutating: true,
      },
      handler: (args, ctx) => {
        if (!deps.strategies) throw new AgentisError('RESOURCE_NOT_FOUND', 'strategy service not configured');
        const appId = (typeof args.appId === 'string' && args.appId.trim()) || ctx.appId;
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (no App in context)');
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        const hypothesis = typeof args.hypothesis === 'string' ? args.hypothesis.trim() : '';
        if (!key || !hypothesis) throw new AgentisError('VALIDATION_FAILED', 'key and hypothesis are required');
        const metric = typeof args.metric === 'string' && args.metric.trim()
          ? args.metric.trim()
          : deps.appGoal?.get(ctx.workspaceId, appId)?.northStar?.metric ?? null;
        const strategy = deps.strategies.propose({
          workspaceId: ctx.workspaceId,
          appId,
          key,
          hypothesis,
          experimentKey: typeof args.experimentKey === 'string' ? args.experimentKey.trim() || null : null,
          variant: typeof args.variant === 'string' ? args.variant.trim() || null : null,
          metric,
          parentId: typeof args.parentId === 'string' ? args.parentId.trim() || null : null,
          generation: typeof args.generation === 'number' ? args.generation : 0,
        });
        return { strategy, message: 'Strategy recorded. Define the matching experiment and route subjects to its variant to start measuring it.' };
      },
    },
    {
      definition: {
        id: 'agentis.strategy.list',
        family: 'inspect',
        mcpExposed: true,
        description: "List the App's strategies with their measured win rates, sample sizes, confidence, and status (active | proven | retired), best first.",
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App to list strategies for. Defaults to the current App context.' },
          },
        },
        mutating: false,
      },
      handler: (args, ctx) => {
        if (!deps.strategies) throw new AgentisError('RESOURCE_NOT_FOUND', 'strategy service not configured');
        const appId = (typeof args.appId === 'string' && args.appId.trim()) || ctx.appId;
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (no App in context)');
        const strategies = deps.strategies.list(ctx.workspaceId, appId);
        return { appId, count: strategies.length, strategies };
      },
    },
    {
      definition: {
        id: 'agentis.evolution.review',
        family: 'run',
        mcpExposed: true,
        description:
          "Review the Evolution Loop for an App: for each experiment, is there a statistically-real winning strategy? Returns per-experiment decisions "
          + '(insufficient_data | no_clear_winner | winner) with standings + rationale. Pass `apply: true` to ACT on winners — promote the winner (recalled into future runs) and retire the clear losers. '
          + 'When a winner is found, spawn the next generation with agentis.strategy.propose (parentId = the winner) + a new experiment.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App to review. Defaults to the current App context.' },
            apply: { type: 'boolean', description: 'Promote winners + retire losers (default false = surface only).' },
          },
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.evolution) throw new AgentisError('RESOURCE_NOT_FOUND', 'evolution service not configured');
        const appId = (typeof args.appId === 'string' && args.appId.trim()) || ctx.appId;
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (no App in context)');
        const decisions = deps.evolution.evaluate(ctx.workspaceId, appId);
        const apply = args.apply === true;
        const applied = [];
        if (apply) {
          for (const d of decisions) {
            if (d.status === 'winner') applied.push({ experimentKey: d.experimentKey, ...(await deps.evolution.apply(ctx.workspaceId, d, 'act')) });
          }
        }
        return { appId, decisions, ...(apply ? { applied } : {}) };
      },
    },
  ]);
}
