/**
 * Environment tools — agent operates approvals and resolves operator gates.
 *
 * `agentis.approval.resolve` is the only tool here that mutates external
 * state. It is gated by the standard workspace ownership check.
 */

import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerEnvironmentTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.approval.resolve',
        family: 'environment',
        description: 'Approve or reject a pending approval.',
        inputSchema: {
          type: 'object',
          properties: {
            approvalId: { type: 'string' },
            decision: { type: 'string', enum: ['approve', 'reject'] },
            reason: { type: 'string' },
          },
          required: ['approvalId', 'decision'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const result = await deps.approvals.resolve({
          workspaceId: ctx.workspaceId,
          approvalId: String(args.approvalId),
          decision: args.decision as 'approve' | 'reject',
          reason: args.reason ? String(args.reason) : undefined,
        });
        return {
          approvalId: result.id,
          status: result.status,
          resolvedAt: result.resolvedAt,
        };
      },
    },
    {
      definition: {
        id: 'agentis.viewport.context',
        family: 'environment',
        description: 'Return the agent’s view of its current environment (workspace, ambient, latest activity).',
        inputSchema: { type: 'object', properties: {} },
        mutating: false,
      },
      handler: async (_args, ctx) => {
        return {
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          userId: ctx.userId,
          caller: ctx.caller,
          conversationId: ctx.conversationId ?? null,
          runId: ctx.runId ?? null,
        };
      },
    },
  ]);
}
