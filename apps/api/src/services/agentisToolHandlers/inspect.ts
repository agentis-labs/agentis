/**
 * Inspect tools — agent reads runtime state, costs, traces, approvals.
 *
 * All tools are read-only and side-effect free. Output shapes are stable so
 * the LLM can rely on them across versions.
 */

import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerInspectTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.app.inspect',
        family: 'inspect',
        description: 'Inspect an installed app and its components.',
        inputSchema: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'] },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const appId = String(args.appId);
        const installed = deps.db
          .select()
          .from(schema.installedRegistryArtifacts)
          .where(
            and(
              eq(schema.installedRegistryArtifacts.workspaceId, ctx.workspaceId),
              eq(schema.installedRegistryArtifacts.entryId, appId),
            ),
          )
          .get();
        if (!installed) return { found: false };
        return {
          found: true,
          appId,
          version: installed.version,
          entryType: installed.entryType,
          installedAt: installed.installedAt,
          localResourceId: installed.localResourceId,
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.inspect',
        family: 'inspect',
        description: 'Read the canonical workflow graph by id.',
        inputSchema: { type: 'object', properties: { workflowId: { type: 'string' } }, required: ['workflowId'] },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const wf = deps.db
          .select()
          .from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId)))
          .get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) return { found: false };
        return { found: true, id: wf.id, title: wf.title, graph: wf.graph, createdAt: wf.createdAt };
      },
    },
    {
      definition: {
        id: 'agentis.run.inspect',
        family: 'inspect',
        description: 'Inspect a run’s status, node states, and cost summary.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: false,
        mcpExposed: true,
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
          workflowId: run.workflowId,
          status: run.status,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          replanCount: run.replanCount,
          parentRunId: run.parentRunId,
          state: run.runState,
        };
      },
    },
    {
      definition: {
        id: 'agentis.trace.inspect',
        family: 'inspect',
        description: 'Read a paginated slice of the run ledger.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            afterSequence: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['runId'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, _ctx) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
        const after = Number(args.afterSequence ?? 0);
        const events = await deps.ledger.listForRun({
          runId: String(args.runId),
          afterSequence: after,
          limit,
        });
        return { runId: String(args.runId), afterSequence: after, count: events.length, events };
      },
    },
    {
      definition: {
        id: 'agentis.cost.inspect',
        family: 'inspect',
        description: 'Aggregated cost summary for a run (LLM tokens, evaluator cost, totals).',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const runId = String(args.runId);
        // Sum evaluator costs for this run.
        const evals = deps.db
          .select()
          .from(schema.runEvaluations)
          .where(
            and(
              eq(schema.runEvaluations.workspaceId, ctx.workspaceId),
              eq(schema.runEvaluations.runId, runId),
            ),
          )
          .all();
        const evaluatorCostCents = evals.reduce((sum, e) => sum + (e.costCents ?? 0), 0);
        // Sum turn costs for this run.
        const turns = deps.db
          .select()
          .from(schema.turnState)
          .where(
            and(
              eq(schema.turnState.workspaceId, ctx.workspaceId),
              eq(schema.turnState.runId, runId),
            ),
          )
          .all();
        const turnCostCents = turns.reduce((sum, t) => sum + (t.costCents ?? 0), 0);
        return {
          runId,
          evaluatorCostCents,
          turnCostCents,
          totalCostCents: evaluatorCostCents + turnCostCents,
          evaluatorCount: evals.length,
          turnCount: turns.length,
        };
      },
    },
    {
      definition: {
        id: 'agentis.approval.list',
        family: 'inspect',
        description: 'List pending approvals for the workspace.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } } },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const items = deps.approvals.list(ctx.workspaceId, 'pending').filter((r) => !args.runId || r.runId === String(args.runId));
        return { count: items.length, approvals: items };
      },
    },
    {
      definition: {
        id: 'agentis.space.summary',
        family: 'inspect',
        description: 'High-level workspace summary: agents, workflows, runs, approvals.',
        inputSchema: { type: 'object', properties: {} },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (_args, ctx) => {
        const agents = deps.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspaceId)).all();
        const workflows = deps.db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, ctx.workspaceId)).all();
        const runs = deps.db
          .select()
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.workspaceId, ctx.workspaceId))
          .orderBy(desc(schema.workflowRuns.createdAt))
          .limit(10)
          .all();
        const pendingApprovals = deps.approvals.list(ctx.workspaceId, 'pending');
        return {
          agentCount: agents.length,
          workflowCount: workflows.length,
          recentRuns: runs.map((r) => ({ id: r.id, workflowId: r.workflowId, status: r.status, createdAt: r.createdAt })),
          pendingApprovalCount: pendingApprovals.length,
        };
      },
    },
  ]);
}
