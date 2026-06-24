/**
 * Durable task-spine tools.
 *
 * These tools expose the promoted ChatPlan contract without creating a parallel
 * intent/workflow runtime. Chat, MCP, workflow tools, and future harnesses all
 * talk to the same PlanService row.
 */

import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerTaskSpineTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.task.accept',
        family: 'run',
        description: 'Accept an operator objective into the durable task spine.',
        inputSchema: {
          type: 'object',
          properties: {
            objective: { type: 'string' },
            title: { type: 'string' },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            assumptions: { type: 'array', items: { type: 'string' } },
          },
          required: ['objective'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        if (!deps.plans) throw new Error('task spine service not available');
        const acceptanceCriteria = Array.isArray(args.acceptanceCriteria)
          ? args.acceptanceCriteria.filter((item): item is string => typeof item === 'string')
          : undefined;
        const assumptions = Array.isArray(args.assumptions)
          ? args.assumptions.filter((item): item is string => typeof item === 'string')
          : undefined;
        const plan = deps.plans.createTask({
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          conversationId: ctx.conversationId ?? null,
          objective: String(args.objective),
          ...(args.title ? { title: String(args.title) } : {}),
          ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
          ...(assumptions ? { assumptions } : {}),
        });
        return { taskId: plan.id, plan, status: plan.status };
      },
    },
    {
      definition: {
        id: 'agentis.task.inspect',
        family: 'inspect',
        description: 'Inspect one durable task spine row by task/plan id.',
        inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
        mutating: false,
      },
      handler: (args, ctx) => {
        if (!deps.plans) throw new Error('task spine service not available');
        return deps.plans.get(ctx.workspaceId, String(args.taskId));
      },
    },
    {
      definition: {
        id: 'agentis.task.bind_run',
        family: 'run',
        description: 'Bind a workflow run to a durable task spine row.',
        inputSchema: {
          type: 'object',
          properties: { taskId: { type: 'string' }, runId: { type: 'string' } },
          required: ['taskId', 'runId'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        if (!deps.plans) throw new Error('task spine service not available');
        const plan = deps.plans.bindRun(ctx.workspaceId, ctx.userId, String(args.taskId), String(args.runId));
        return { taskId: plan.id, runIds: plan.runIds ?? [], status: plan.status };
      },
    },
    {
      definition: {
        id: 'agentis.task.record_decision',
        family: 'run',
        description: 'Record a durable decision on a task spine.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            summary: { type: 'string' },
            rationale: { type: 'string' },
          },
          required: ['taskId', 'summary'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        if (!deps.plans) throw new Error('task spine service not available');
        const plan = deps.plans.recordDecision(ctx.workspaceId, ctx.userId, String(args.taskId), {
          summary: String(args.summary),
          ...(args.rationale ? { rationale: String(args.rationale) } : {}),
          actorId: ctx.agentId ?? ctx.userId,
          ...(ctx.runId ? { runId: ctx.runId } : {}),
        });
        return { taskId: plan.id, decisions: plan.decisions ?? [] };
      },
    },
    {
      definition: {
        id: 'agentis.task.flag_deviation',
        family: 'run',
        description: 'Record a durable deviation on a task spine.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            kind: { type: 'string', enum: ['reject_input', 'rescope', 'blocked'] },
            reason: { type: 'string' },
            proposed: { type: 'string' },
          },
          required: ['taskId', 'kind', 'reason'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        if (!deps.plans) throw new Error('task spine service not available');
        const kind = ['reject_input', 'rescope', 'blocked'].includes(String(args.kind))
          ? String(args.kind) as 'reject_input' | 'rescope' | 'blocked'
          : 'rescope';
        const plan = deps.plans.recordDeviation(ctx.workspaceId, ctx.userId, String(args.taskId), {
          kind,
          reason: String(args.reason),
          ...(args.proposed ? { proposed: String(args.proposed) } : {}),
          actorId: ctx.agentId ?? ctx.userId,
          ...(ctx.runId ? { runId: ctx.runId } : {}),
        });
        return { taskId: plan.id, deviations: plan.deviations ?? [], status: plan.status };
      },
    },
  ]);
}
