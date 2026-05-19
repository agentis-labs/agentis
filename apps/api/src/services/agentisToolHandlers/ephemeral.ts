import { z } from 'zod';
import { schemas, type WorkflowGraph } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { startEphemeralWorkflow } from '../ephemeralWorkflowService.js';

const ephemeralRunArgsSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  graph: schemas.workflowGraphSchema,
  inputs: z.record(z.string(), z.unknown()).default({}),
  maxDurationMs: z.number().int().positive().max(300_000).optional(),
});

export function registerEphemeralTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.register(
    {
      id: 'agentis.ephemeral.run',
      family: 'run',
      description:
        'Run a transient workflow graph once without saving it to the workflow library. The graph is stored only as a run snapshot and can be promoted later if the operator wants to keep it.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short label for the temporary run.' },
          graph: { type: 'object', description: 'Agentis WorkflowGraph JSON to execute once.' },
          inputs: { type: 'object', description: 'Initial input object for root nodes.' },
          maxDurationMs: { type: 'number', description: 'Execution cap in milliseconds, max 300000.' },
        },
        required: ['graph'],
      },
      mutating: true,
    },
    async (args, ctx) => {
      const body = ephemeralRunArgsSchema.parse(args);
      return startEphemeralWorkflow(deps, {
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId ?? null,
          conversationId: ctx.conversationId ?? null,
        userId: ctx.userId,
        title: body.title,
        graph: body.graph as WorkflowGraph,
        inputs: body.inputs,
        maxDurationMs: body.maxDurationMs,
      });
    },
  );
}
