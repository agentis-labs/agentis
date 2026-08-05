/**
 * Workflow Delivery Orchestrator — SWIFT enforcement, autonomous edition.
 * Proves the whole loop hermetically with a SCRIPTED fake engine (each debug
 * run writes a controlled terminal status + verdict): it delivers on verified
 * accomplishment, repairs a deficient run and re-verifies, stops honestly on a
 * human blocker (credential / approval) without burning iterations, fails
 * honestly after the budget with the verdict intact, and reports `unverifiable`
 * when a run completes with no world-check. It NEVER fakes success.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { deliverWorkflow, type DeliverCtx } from '../../src/services/workflow/workflowDeliveryOrchestrator.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import type { RunVerdict } from '../../src/services/workflow/workflowVerdict.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { WorkflowRevisionService } from '../../src/services/workflow/workflowRevisionService.js';
import { graphContentHash } from '../../src/services/workflow/workflowCompass.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

/** A trivial green pipeline (dry-run passes) so the loop reaches the debug run. */
function pipelineGraph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'P', type: 'transform', title: 'Produce', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ storeUrl: "https://x.app", products: [1,2,3] })' } },
      { id: 'R', type: 'return_output', title: 'Return', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json', isOutput: true } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'P' }, { id: 'e2', source: 'P', target: 'R' }],
  };
}

function seedWorkflow(graph = pipelineGraph()): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'deliver me — publish a store', description: 'deliver a live store', graph, settings: {},
  }).run();
  return id;
}

type Scripted = { status: string; verdict?: RunVerdict['outcome']; failedError?: string; noVerdict?: boolean };

/** A fake engine whose each `startRun` pops the next scripted terminal outcome
 *  and writes it to the (already-inserted) run row — synchronous settlement. */
function scriptedEngine(outcomes: Scripted[]) {
  let i = 0;
  const runs: string[] = [];
  return {
    runs,
    engine: {
      startRun: async (args: { initialState: WorkflowRunState; workflowId: string }) => {
        const runId = args.initialState.runId;
        runs.push(runId);
        const o = outcomes[Math.min(i, outcomes.length - 1)]!; i += 1;
        const state = { ...args.initialState, status: o.status } as unknown as Record<string, unknown>;
        if (!o.noVerdict && o.verdict) {
          const v: RunVerdict = {
            outcome: o.verdict, at: new Date().toISOString(), graphHash: 'h',
            checks: [{ checkId: 'c', claim: 'store is live', passed: o.verdict === 'accomplished', evidence: 'probe' }],
            deficiencies: o.verdict === 'accomplished' ? [] : [{ checkId: 'c', claim: 'store is live', detail: 'GET https://x.app → 404', producingNodeIds: ['P'] }],
            sufficiency: { typedEmptyFills: [], stubSuspects: [], floorViolations: [] },
          };
          state.verdict = v;
        }
        if (o.failedError) { state.failedNodeIds = ['P']; state.nodeStates = { ...(state.nodeStates as object ?? {}), P: { status: 'FAILED', error: o.failedError } }; }
        ctx.db.update(schema.workflowRuns).set({ status: o.status, runState: state as object, completedAt: new Date().toISOString() }).where(eq(schema.workflowRuns.id, runId)).run();
        return { runId, workflowId: args.workflowId };
      },
      cancelRun: async () => {},
    },
  };
}

function deps(engine: unknown, approvals?: unknown, revisions?: WorkflowRevisionService): ToolHandlerDeps {
  return { db: ctx.db, logger: ctx.logger, bus: ctx.bus, engine, ...(approvals ? { approvals } : {}), ...(revisions ? { revisions } : {}) } as unknown as ToolHandlerDeps;
}

const dctx = (): DeliverCtx => ({ workspaceId: ctx.workspace.id, userId: ctx.user.id, ambientId: ctx.ambient.id });

describe('deliverWorkflow', () => {
  it('executes and attributes proof to the candidate revision, never the active mirror', async () => {
    const wfId = seedWorkflow();
    const revisions = new WorkflowRevisionService(ctx.db);
    const active = revisions.ensureWorkflow(ctx.workspace.id, wfId).active;
    const candidateGraph = pipelineGraph();
    candidateGraph.nodes[1] = { ...candidateGraph.nodes[1]!, title: 'Deterministic candidate producer' };
    const hash = graphContentHash(candidateGraph);
    ctx.db.update(schema.workflows).set({ settings: {
      spec: {
        version: 1,
        objective: 'Produce the store payload',
        acceptance: [{ id: 'payload', claim: 'payload exists', verify: 'expr', expr: 'output.products.length > 0' }],
        reworkBudget: 1,
        createdAt: new Date().toISOString(),
        reconciledHash: hash,
      },
    } }).where(eq(schema.workflows.id, wfId)).run();
    const candidate = revisions.createCandidate({
      workspaceId: ctx.workspace.id,
      workflowId: wfId,
      graph: candidateGraph,
      baseRevisionId: active.id,
      source: 'agent_build',
      actor: { type: 'agent', id: 'builder' },
      reason: 'replace Hermes with deterministic component',
    }).revision;
    let executedGraph: WorkflowGraph | undefined;
    let executedRevisionId: string | undefined;
    const { engine } = scriptedEngine([{ status: 'COMPLETED', verdict: 'accomplished' }]);
    const base = engine as unknown as { startRun(args: Record<string, unknown>): Promise<unknown>; cancelRun(): Promise<void> };
    const wrapped = {
      ...base,
      startRun: async (args: Record<string, unknown>) => {
        executedGraph = args.graph as WorkflowGraph;
        executedRevisionId = args.workflowRevisionId as string;
        return base.startRun(args);
      },
    };

    const result = await deliverWorkflow(deps(wrapped, undefined, revisions), dctx(), { workflowId: wfId });

    expect(result.outcome).toBe('accomplished');
    expect(executedRevisionId).toBe(candidate.id);
    expect(executedGraph?.nodes[1]?.title).toBe('Deterministic candidate producer');
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, result.runId!)).get();
    expect(run?.workflowRevisionId).toBe(candidate.id);
    expect((run?.graphSnapshot as WorkflowGraph).nodes[1]?.title).toBe('Deterministic candidate producer');
  });

  it('ACCOMPLISHED on the first verified run → delivered', async () => {
    const wfId = seedWorkflow();
    const { engine } = scriptedEngine([{ status: 'COMPLETED', verdict: 'accomplished' }]);
    const result = await deliverWorkflow(deps(engine), dctx(), { workflowId: wfId, maxIterations: 3 });
    expect(result.delivered).toBe(true);
    expect(result.outcome).toBe('accomplished');
    expect(result.iterations).toBe(1);
    expect(result.verdict?.outcome).toBe('accomplished');
    expect(result.message).toMatch(/VERIFIED against the world/i);
  });

  it('repairs a deficient run and re-verifies → delivered on the 2nd attempt', async () => {
    const wfId = seedWorkflow();
    const { engine, runs } = scriptedEngine([{ status: 'COMPLETED', verdict: 'hollow' }, { status: 'COMPLETED', verdict: 'accomplished' }]);
    let repairs = 0;
    const result = await deliverWorkflow(deps(engine), dctx(), {
      workflowId: wfId, maxIterations: 3,
      repair: async () => { repairs += 1; }, // no-op; the scripted engine drives the 2nd outcome
    });
    expect(result.delivered).toBe(true);
    expect(result.iterations).toBe(2);
    expect(repairs).toBe(1);            // exactly one repair between the two runs
    expect(runs).toHaveLength(2);       // two real debug runs happened
  });

  it('BLOCKED_ON_HUMAN on a missing credential — stops immediately, does NOT burn iterations', async () => {
    const wfId = seedWorkflow();
    const { engine, runs } = scriptedEngine([{ status: 'FAILED', failedError: 'HTTP 401 unauthorized: missing credential for vercel' }]);
    let repairs = 0;
    const result = await deliverWorkflow(deps(engine), dctx(), { workflowId: wfId, maxIterations: 3, repair: async () => { repairs += 1; } });
    expect(result.outcome).toBe('blocked_on_human');
    expect(result.delivered).toBe(false);
    expect(result.blockers?.[0]?.kind).toBe('credential');
    expect(result.blockers?.[0]?.humanAction).toMatch(/Connect the missing credential/i);
    expect(repairs).toBe(0);            // a human blocker is NOT something to repair-loop over
    expect(runs).toHaveLength(1);       // stopped after the first run
  });

  it('BLOCKED_ON_HUMAN on a pending approval — reports the exact human action', async () => {
    const wfId = seedWorkflow();
    // The run parks WAITING; an approval exists for it.
    const { engine } = scriptedEngine([{ status: 'WAITING', noVerdict: true }]);
    let capturedRunId = '';
    const approvals = {
      list: () => [{ runId: capturedRunId, nodeTitle: 'Approve Deploy' }],
    };
    // capture the runId the orchestrator creates so the fake approval matches it
    const baseEngine = engine as { startRun: (a: { initialState: WorkflowRunState; workflowId: string }) => Promise<{ runId: string; workflowId: string }> };
    const wrapped = { ...baseEngine, startRun: async (a: { initialState: WorkflowRunState; workflowId: string }) => { capturedRunId = a.initialState.runId; return baseEngine.startRun(a); }, cancelRun: async () => {} };
    const result = await deliverWorkflow(deps(wrapped, approvals), dctx(), { workflowId: wfId, maxIterations: 3, maxWallMs: 5000 });
    expect(result.outcome).toBe('blocked_on_human');
    expect(result.blockers?.[0]?.kind).toBe('approval');
    expect(result.blockers?.[0]?.humanAction).toMatch(/Approve or reject/i);
  });

  it('FAILED after the iteration budget — honest, with the last verdict + deficiencies', async () => {
    const wfId = seedWorkflow();
    const { engine, runs } = scriptedEngine([{ status: 'COMPLETED', verdict: 'failed_checks' }]); // always deficient
    const result = await deliverWorkflow(deps(engine), dctx(), { workflowId: wfId, maxIterations: 2, repair: async () => {} });
    expect(result.delivered).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(result.iterations).toBe(2);
    expect(runs).toHaveLength(2);       // tried the full budget
    expect(result.verdict?.outcome).toBe('failed_checks');
    expect(result.message).toMatch(/Not accomplished after 2/i);
    expect(result.timeline.filter((entry) => entry.stage === 'dry_run')).toHaveLength(1);
    expect(result.timeline.filter((entry) => entry.stage === 'dry_run_reused')).toHaveLength(1);
  });

  it('UNVERIFIABLE when a run completes with no world-check (completion is not proof)', async () => {
    const wfId = seedWorkflow();
    const { engine } = scriptedEngine([{ status: 'COMPLETED', noVerdict: true }]);
    const result = await deliverWorkflow(deps(engine), dctx(), { workflowId: wfId, maxIterations: 2, repair: async () => {} });
    expect(result.outcome).toBe('unverifiable');
    expect(result.delivered).toBe(false);
    expect(result.message).toMatch(/accomplishment cannot be proven/i);
  });

  it('requires a goal or a workflowId', async () => {
    const { engine } = scriptedEngine([{ status: 'COMPLETED', verdict: 'accomplished' }]);
    const result = await deliverWorkflow(deps(engine), dctx(), {});
    expect(result.outcome).toBe('failed');
    expect(result.message).toMatch(/requires either a goal/i);
  });
});
