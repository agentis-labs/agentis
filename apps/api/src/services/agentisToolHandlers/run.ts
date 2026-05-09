/**
 * Run tools — agent triggers, cancels, replays, resumes work.
 *
 * Mutating tools always require explicit ids; the registry's argument
 * validation refuses calls missing required keys before reaching here.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { buildInitialRunState } from '../../engine/initialRunState.js';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerRunTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.workflow.run',
        family: 'run',
        description: 'Start a workflow run with optional inputs.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            inputs: { type: 'object' },
          },
          required: ['workflowId'],
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
          throw new Error(`workflow ${args.workflowId} not found in workspace`);
        }
        const graph = wf.graph as WorkflowGraph;
        const runId = randomUUID();
        const inputs = (args.inputs as Record<string, unknown>) ?? {};
        const initialState: WorkflowRunState = buildInitialRunState({
          runId,
          workflowId: wf.id,
          graph,
          inputs,
        });
        const handle = await deps.engine.startRun({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          workflowId: wf.id,
          userId: ctx.userId,
          triggerId: null,
          inputs,
          initialState,
          graph,
        });
        return { runId: handle.runId, workflowId: handle.workflowId, status: 'started' };
      },
    },
    {
      definition: {
        id: 'agentis.run.cancel',
        family: 'run',
        description: 'Cancel a running workflow run.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const run = deps.db
          .select()
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, String(args.runId)))
          .get();
        if (!run || run.workspaceId !== ctx.workspaceId) {
          throw new Error(`run ${args.runId} not found`);
        }
        await deps.engine.cancelRun(run.id);
        return { runId: run.id, status: 'cancelled' };
      },
    },
    {
      definition: {
        id: 'agentis.run.status',
        family: 'run',
        description: 'Quick status check on a run (lighter than agentis.run.inspect).',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const run = deps.db
          .select()
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, String(args.runId)))
          .get();
        if (!run || run.workspaceId !== ctx.workspaceId) return { found: false };
        return {
          found: true,
          runId: run.id,
          status: run.status,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
        };
      },
    },
    {
      definition: {
        id: 'agentis.run.replay',
        family: 'run',
        description: 'Create a child run that replays from a chosen point.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceRunId: { type: 'string' },
            mode: {
              type: 'string',
              enum: ['replay-from-node', 'replay-failed-branch', 'replay-with-edited-node', 'replay-from-checkpoint'],
            },
            targetNodeId: { type: 'string' },
            nodeConfigPatch: { type: 'object' },
          },
          required: ['sourceRunId', 'mode'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const prepared = deps.replay.prepare({
          workspaceId: ctx.workspaceId,
          sourceRunId: String(args.sourceRunId),
          mode: args.mode as 'replay-from-node' | 'replay-failed-branch' | 'replay-with-edited-node' | 'replay-from-checkpoint',
          targetNodeId: args.targetNodeId ? String(args.targetNodeId) : undefined,
          nodeConfigPatch: args.nodeConfigPatch as Record<string, unknown> | undefined,
          userId: ctx.userId,
        });
        const handle = await deps.engine.startRun({
          workspaceId: prepared.workspaceId,
          ambientId: prepared.ambientId,
          workflowId: prepared.workflowId,
          userId: prepared.userId,
          triggerId: null,
          inputs: prepared.inputs,
          initialState: prepared.initialState,
          graph: prepared.graph,
        });
        return { runId: handle.runId, parentRunId: String(args.sourceRunId), status: 'started' };
      },
    },
  ]);
}
