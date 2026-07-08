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
        mcpExposed: true,
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
        id: 'agentis.task.set_steps',
        mcpExposed: true,
        family: 'run',
        description:
          'Publish the ordered checklist the operator watches live (the StepTrack shown in chat, the Live Workspace, and channels). '
          + 'Call this when you start multi-step work; pass short imperative step labels. Creates the task spine if none exists yet.',
        inputSchema: {
          type: 'object',
          properties: {
            steps: { type: 'array', items: { type: 'string' }, description: 'Ordered step labels, e.g. ["Fetch profile", "Extract metadata", "Save artifact"].' },
            taskId: { type: 'string', description: 'Existing task spine id; omit to use/create this conversation\'s spine.' },
            title: { type: 'string' },
            objective: { type: 'string' },
          },
          required: ['steps'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        if (!deps.plans) throw new Error('task spine service not available');
        const steps = Array.isArray(args.steps)
          ? args.steps.filter((item): item is string => typeof item === 'string')
          : [];
        if (steps.length === 0) throw new Error('steps must be a non-empty array of strings');
        const plan = deps.plans.setSteps(ctx.workspaceId, ctx.userId, {
          conversationId: ctx.conversationId ?? null,
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          ...(args.taskId ? { planId: String(args.taskId) } : {}),
          ...(args.title ? { title: String(args.title) } : {}),
          ...(args.objective ? { objective: String(args.objective) } : {}),
          steps,
        });
        return { taskId: plan.id, status: plan.status, steps: plan.nodes.filter((node) => node.stage === 'build').map((node) => node.title) };
      },
    },
    {
      definition: {
        id: 'agentis.task.advance_step',
        mcpExposed: true,
        family: 'run',
        description:
          'Advance the live checklist. With no target, marks the current step done and starts the next — call it each time you finish a step. '
          + 'Pass status:"failed" when a step fails. Keeps the operator\'s progress bar truthful.',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            index: { type: 'number', description: '0-based step to update; omit to advance the active step.' },
            label: { type: 'string', description: 'Step label to update (alternative to index).' },
            status: { type: 'string', enum: ['running', 'done', 'failed'], description: 'Defaults to "done".' },
          },
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        if (!deps.plans) throw new Error('task spine service not available');
        const status = ['running', 'done', 'failed'].includes(String(args.status))
          ? String(args.status) as 'running' | 'done' | 'failed'
          : undefined;
        const plan = deps.plans.advanceStep(ctx.workspaceId, ctx.userId, {
          conversationId: ctx.conversationId ?? null,
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          ...(args.taskId ? { planId: String(args.taskId) } : {}),
          ...(typeof args.index === 'number' ? { index: args.index } : {}),
          ...(args.label ? { label: String(args.label) } : {}),
          ...(status ? { status } : {}),
        });
        const buildNodes = plan.nodes.filter((node) => node.stage === 'build');
        return {
          taskId: plan.id,
          status: plan.status,
          steps: buildNodes.map((node) => ({ label: node.title, status: node.status })),
        };
      },
    },
    {
      definition: {
        id: 'agentis.task.inspect',
        mcpExposed: true,
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
        mcpExposed: true,
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
        mcpExposed: true,
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
        mcpExposed: true,
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
