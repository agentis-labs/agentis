/**
 * agentis.app.goal — set or read an App's durable Goal (the Evolution Loop
 * north-star). Setting it persists to the App manifest and mirrors a governing
 * atom into the App Brain so every run recalls it. Reading returns the current
 * Goal. This is the reserved long-term "Goal" tier — run-scoped work stays an
 * Objective; a Goal is what competing Strategies are measured and evolved against.
 */

import { AgentisError } from '@agentis/core';
import { z } from 'zod';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

const northStarSchema = z.object({
  metric: z.string().min(1).max(120),
  direction: z.enum(['maximize', 'minimize']).optional(),
  target: z.number().optional(),
});

export function registerAppGoalTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.app.goal',
        family: 'build',
        mcpExposed: true,
        description:
          "Set or read an App's durable GOAL — its north-star across many runs (the reserved long-term \"Goal\" tier; run-scoped work stays an Objective). "
          + 'Provide `statement` (+ optional `northStar` metric to optimize) to SET it — it persists to the App and is recalled into every run in the App. '
          + 'Omit `statement` to READ the current Goal. The Goal is what competing strategies are measured and evolved against by the Evolution Loop.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App to set/read the Goal for. Defaults to the current App context.' },
            statement: { type: 'string', description: 'One or two sentences on what the App is trying to achieve over time. Omit to read the current Goal.' },
            northStar: {
              type: 'object',
              description: 'Optional metric the App optimizes: { metric, direction: "maximize"|"minimize" (default maximize), target?: number }.',
              properties: {
                metric: { type: 'string' },
                direction: { type: 'string', enum: ['maximize', 'minimize'] },
                target: { type: 'number' },
              },
            },
          },
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.appGoal) throw new AgentisError('RESOURCE_NOT_FOUND', 'app goal service not configured');
        const appId = (typeof args.appId === 'string' && args.appId.trim()) || ctx.appId;
        if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId is required (no App in context)');

        const statement = typeof args.statement === 'string' ? args.statement.trim() : '';
        if (!statement) {
          const goal = deps.appGoal.get(ctx.workspaceId, appId);
          return { appId, goal };
        }
        const northStar = args.northStar != null ? northStarSchema.parse(args.northStar) : undefined;
        const goal = await deps.appGoal.set(
          ctx.workspaceId,
          appId,
          {
            statement,
            ...(northStar
              ? { northStar: { metric: northStar.metric, direction: northStar.direction ?? 'maximize', ...(northStar.target != null ? { target: northStar.target } : {}) } }
              : {}),
          },
          ctx.agentId ?? null,
        );
        return { appId, goal, message: "App Goal set. It's now recalled into every run in this App's scope and steers strategy evolution." };
      },
    },
  ]);
}
