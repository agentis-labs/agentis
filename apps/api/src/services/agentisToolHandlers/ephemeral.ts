import { z } from 'zod';
import { schemas, type WorkflowGraph } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { startEphemeralWorkflow } from '../ephemeralWorkflowService.js';
import { compassForRun } from '../workflowCompass.js';

const ephemeralRunArgsSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  graph: schemas.workflowGraphSchema,
  inputs: z.record(z.string(), z.unknown()).default({}),
  maxDurationMs: z.number().int().positive().max(300_000).optional(),
  debugRun: z.boolean().optional(),
});

export function registerEphemeralTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.register(
    {
      id: 'agentis.ephemeral.run',
      family: 'run',
      mcpExposed: true,
      description:
        '[PAVED ROAD 3/5 — DEBUG a draft] Run a transient workflow graph once WITHOUT saving it — the ideal way to TEST a draft while building. '
        + 'Set debugRun:true to disable self-heal + fallback so you observe the RAW per-node failure. '
        + 'The graph is stored only as a run snapshot and can be promoted later if the operator wants to keep it.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short label for the temporary run.' },
          graph: { type: 'object', description: 'Agentis WorkflowGraph JSON to execute once.' },
          inputs: { type: 'object', description: 'Initial input object for root nodes.' },
          maxDurationMs: { type: 'number', description: 'Execution cap in milliseconds, max 300000.' },
          debugRun: { type: 'boolean', description: 'Test run: disable self-heal + fallback so raw per-node failures surface.' },
        },
        required: ['graph'],
      },
      mutating: true,
    },
    async (args, ctx) => {
      const body = ephemeralRunArgsSchema.parse(args);
      const result = await startEphemeralWorkflow(deps, {
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId ?? null,
          conversationId: ctx.conversationId ?? null,
        userId: ctx.userId,
        title: body.title,
        graph: body.graph as WorkflowGraph,
        inputs: body.inputs,
        maxDurationMs: body.maxDurationMs,
        debugRun: body.debugRun,
      });
      // PAVED-ROAD P1 — signpost: poll → diagnose-on-fail, real runId baked in.
      return {
        ...result,
        compass: compassForRun({
          runId: result.runId,
          workflowId: result.syntheticWorkflowId ?? 'ephemeral',
          status: 'started',
          debugRun: body.debugRun === true,
        }),
      };
    },
  );
}
