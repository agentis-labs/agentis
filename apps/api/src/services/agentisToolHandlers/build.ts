/**
 * Build tools — agent creates and patches workflows.
 *
 * Mutating; gated by the runtime policy engine in production deployments.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerBuildTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.workflow.create',
        family: 'build',
        description: 'Create a new workflow from a graph payload.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            graph: { type: 'object' },
          },
          required: ['name', 'graph'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const id = randomUUID();
        const now = new Date().toISOString();
        const graph = args.graph as WorkflowGraph;
        deps.db
          .insert(schema.workflows)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            ambientId: ctx.ambientId ?? null,
            userId: ctx.userId,
            title: String(args.name),
            summary: args.description ? String(args.description) : null,
            graph,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        return { workflowId: id, title: String(args.name) };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.patch',
        family: 'build',
        description: 'Patch a workflow graph (replaces the graph atomically).',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            graph: { type: 'object' },
          },
          required: ['workflowId', 'graph'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const wf = deps.db
          .select()
          .from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId)))
          .get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) {
          throw new Error(`workflow ${args.workflowId} not found`);
        }
        const graph = args.graph as WorkflowGraph;
        deps.db
          .update(schema.workflows)
          .set({ graph, updatedAt: new Date().toISOString() })
          .where(eq(schema.workflows.id, wf.id))
          .run();
        return { workflowId: wf.id, patched: true };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.validate',
        family: 'build',
        description: 'Validate a graph against the engine’s static checks (cycles, dangling refs).',
        inputSchema: { type: 'object', properties: { graph: { type: 'object' } }, required: ['graph'] },
        mutating: false,
      },
      handler: async (args, _ctx) => {
        // Delegate to the existing validator. Imported lazily to keep the handler
        // file independent of engine wiring.
        const { validateWorkflowGraph } = await import('../../engine/validateGraph.js');
        try {
          validateWorkflowGraph(args.graph as WorkflowGraph);
          return { valid: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'invalid graph';
          return { valid: false, errorMessage: message };
        }
      },
    },
  ]);
}
