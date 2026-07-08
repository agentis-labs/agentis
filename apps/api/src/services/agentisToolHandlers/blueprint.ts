/**
 * Blueprint tools (BRAIN-BLUEPRINT-10X) — roll a workflow back to its blessed,
 * production-proven graph.
 *
 * The blessed graph = the bytes that actually RAN in the last ACCOMPLISHED
 * production run (blueprint stamp → that run's graphSnapshot; fallback: newest
 * accomplished run). This is the recovery path for the exact disaster the
 * self-heal guard now prevents: an automatic "repair" that restructured a
 * working workflow.
 */

import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { findBlessedGraph } from '../workflow/workflowBlueprint.js';
import { graphContentHash, readBuildLoop, stampBuildLoop } from '../workflow/workflowCompass.js';

export function registerBlueprintTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.register(
    {
      id: 'agentis.workflow.restore_blueprint',
      family: 'run',
      mcpExposed: true,
      description:
        'Restore a workflow to its BLESSED blueprint — the exact graph that ran in its last ACCOMPLISHED production run. '
        + 'Use when a repair/edit broke a previously-working workflow ("it was perfect, now it fails"). '
        + 'Replaces the current graph with the proven bytes and reports what changed. '
        + 'Returns restored:false with the reason when the workflow has never accomplished (nothing proven to restore).',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: 'The workflow to roll back.' },
          runId: { type: 'string', description: 'Optional: restore the exact graph that ran in THIS run (its graphSnapshot), instead of the blessed default. Use when you know which run was good (e.g. the last one before a bad repair) even though it never earned a formal verdict.' },
        },
        required: ['workflowId'],
      },
      mutating: true,
    },
    async (args, ctx) => {
      const workflowId = String(args.workflowId ?? '').trim();
      if (!workflowId) throw new Error('workflowId is required');
      const explicitRunId = typeof args.runId === 'string' && args.runId.trim() ? args.runId.trim() : null;
      const wf = deps.db
        .select({ id: schema.workflows.id, title: schema.workflows.title, graph: schema.workflows.graph, settings: schema.workflows.settings })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, ctx.workspaceId)))
        .get();
      if (!wf) throw new Error(`workflow ${workflowId} not found in workspace`);

      // Explicit run override — the operator names the known-good run; the graph
      // that actually ran lives in its graphSnapshot (written at startRun and on
      // every mid-run patch). This covers proven-in-practice workflows that never
      // earned a formal ACCOMPLISHED verdict.
      let blessed = null as ReturnType<typeof findBlessedGraph>;
      if (explicitRunId) {
        const run = deps.db
          .select({ id: schema.workflowRuns.id, workflowId: schema.workflowRuns.workflowId, graphSnapshot: schema.workflowRuns.graphSnapshot })
          .from(schema.workflowRuns)
          .where(and(eq(schema.workflowRuns.id, explicitRunId), eq(schema.workflowRuns.workspaceId, ctx.workspaceId)))
          .get();
        if (!run || run.workflowId !== workflowId) throw new Error(`run ${explicitRunId} not found for workflow ${workflowId}`);
        const graph = (run.graphSnapshot ?? null) as WorkflowGraph | null;
        if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
          return { restored: false, workflowId, reason: `run ${explicitRunId} kept no usable graph snapshot.` };
        }
        blessed = { graph, graphHash: graphContentHash(graph), runId: run.id, source: 'explicit_run' };
      } else {
        blessed = findBlessedGraph(deps.db, ctx.workspaceId, workflowId);
      }
      if (!blessed) {
        return {
          restored: false,
          workflowId,
          reason:
            'No blessed blueprint exists: this workflow has never had an ACCOMPLISHED production run (or its accomplished runs kept no graph snapshot). '
            + 'Fix it forward instead: agentis.run.diagnose the failure, then agentis.build_workflow with a scoped patchDraft.',
        };
      }

      const currentHash = graphContentHash(wf.graph as WorkflowGraph);
      if (currentHash === blessed.graphHash) {
        return {
          restored: false,
          workflowId,
          alreadyBlessed: true,
          graphHash: blessed.graphHash,
          reason: `The current graph already IS the blessed blueprint (@${blessed.graphHash.slice(0, 12)}). If runs still fail, the problem is runtime-class (model/credential/quota) — diagnose the run, not the graph.`,
        };
      }

      const current = wf.graph as WorkflowGraph;
      const blessedGraph = blessed.graph;
      deps.db
        .update(schema.workflows)
        .set({ graph: blessedGraph as unknown as object, contentHash: blessed.graphHash, updatedAt: new Date().toISOString() })
        .where(eq(schema.workflows.id, workflowId))
        .run();
      // Re-align the authored-hash stamp so the compass reads this hash as the
      // saved state; the blueprint stamp itself is untouched (still blessed).
      stampBuildLoop(deps.db, workflowId, { graphHash: blessed.graphHash, validatedAt: new Date().toISOString() });

      const loop = readBuildLoop(wf.settings);
      deps.logger.info('workflow.blueprint_restored', {
        workspaceId: ctx.workspaceId,
        workflowId,
        fromRunId: blessed.runId,
        source: blessed.source,
        replacedHash: currentHash,
        blessedHash: blessed.graphHash,
      });
      return {
        restored: true,
        workflowId,
        title: wf.title,
        fromRunId: blessed.runId,
        source: blessed.source,
        graphHash: blessed.graphHash,
        replacedGraphHash: currentHash,
        nodeCount: blessedGraph.nodes.length,
        replacedNodeCount: current?.nodes?.length ?? 0,
        hardenedStampPresent: Boolean(loop.hardened),
        note: 'Graph replaced with the production-proven bytes. Re-run the workflow; if the original failure was runtime-class (bad model/credential), fix that too or it will fail again for the same non-graph reason.',
      };
    },
  );

  registry.register(
    {
      id: 'agentis.workflow.bless',
      family: 'run',
      mcpExposed: true,
      description:
        'BLESS a workflow: mark a run\'s graph as the proven blueprint ("this works"), granting it blueprint protection — '
        + 'self-heal may never autonomously restructure it, and agentis.workflow.restore_blueprint can always roll back to it. '
        + 'The verdict engine blesses automatically on ACCOMPLISHED production runs; use this for operator-confirmed success on '
        + 'workflows that work in practice but never earned a formal verdict. Defaults to the latest COMPLETED run; pass runId to pick one.',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: 'The workflow to bless.' },
          runId: { type: 'string', description: 'Optional: bless the graph that ran in THIS run. Default: the latest COMPLETED run with a usable snapshot.' },
        },
        required: ['workflowId'],
      },
      mutating: true,
      autoExecute: true,
    },
    async (args, ctx) => {
      const workflowId = String(args.workflowId ?? '').trim();
      if (!workflowId) throw new Error('workflowId is required');
      const wf = deps.db
        .select({ id: schema.workflows.id, title: schema.workflows.title, graph: schema.workflows.graph })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, ctx.workspaceId)))
        .get();
      if (!wf) throw new Error(`workflow ${workflowId} not found in workspace`);

      const explicitRunId = typeof args.runId === 'string' && args.runId.trim() ? args.runId.trim() : null;
      let run = explicitRunId
        ? deps.db
            .select({ id: schema.workflowRuns.id, workflowId: schema.workflowRuns.workflowId, status: schema.workflowRuns.status, graphSnapshot: schema.workflowRuns.graphSnapshot })
            .from(schema.workflowRuns)
            .where(and(eq(schema.workflowRuns.id, explicitRunId), eq(schema.workflowRuns.workspaceId, ctx.workspaceId)))
            .get()
        : undefined;
      if (explicitRunId && (!run || run.workflowId !== workflowId)) {
        throw new Error(`run ${explicitRunId} not found for workflow ${workflowId}`);
      }
      if (!run) {
        // Default: the newest COMPLETED run with a usable snapshot — the run the
        // operator is looking at when they say "this works".
        run = deps.db
          .select({ id: schema.workflowRuns.id, workflowId: schema.workflowRuns.workflowId, status: schema.workflowRuns.status, graphSnapshot: schema.workflowRuns.graphSnapshot, createdAt: schema.workflowRuns.createdAt })
          .from(schema.workflowRuns)
          .where(and(eq(schema.workflowRuns.workflowId, workflowId), eq(schema.workflowRuns.workspaceId, ctx.workspaceId), eq(schema.workflowRuns.status, 'COMPLETED')))
          .all()
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .find((r) => {
            const g = r.graphSnapshot as WorkflowGraph | null;
            return Boolean(g && Array.isArray(g.nodes) && g.nodes.length > 0);
          });
      }
      const snapshot = (run?.graphSnapshot ?? null) as WorkflowGraph | null;
      if (!run || !snapshot || !Array.isArray(snapshot.nodes) || snapshot.nodes.length === 0) {
        return {
          blessed: false,
          workflowId,
          reason: explicitRunId
            ? `run ${explicitRunId} kept no usable graph snapshot.`
            : 'No COMPLETED run with a usable graph snapshot exists yet — run the workflow successfully once, then bless it.',
        };
      }

      const graphHash = graphContentHash(snapshot);
      const at = new Date().toISOString();
      stampBuildLoop(deps.db, workflowId, { blueprint: { at, runId: run.id, graphHash } });
      const matchesCurrentGraph = graphContentHash(wf.graph as WorkflowGraph) === graphHash;
      deps.logger.info('workflow.blessed_by_operator', { workspaceId: ctx.workspaceId, workflowId, runId: run.id, graphHash, matchesCurrentGraph });
      return {
        blessed: true,
        workflowId,
        title: wf.title,
        runId: run.id,
        graphHash,
        matchesCurrentGraph,
        note: matchesCurrentGraph
          ? 'Blessed. The CURRENT graph is now blueprint-protected: self-heal will never autonomously restructure it, and restore_blueprint can always roll back to it.'
          : 'Blessed — but the CURRENT graph differs from the blessed snapshot, so protection applies only after you restore (agentis.workflow.restore_blueprint) or the current graph proves itself.',
      };
    },
  );
}
