/**
 * WorkflowEngine — convergence loop (`converge`, AGENT-COOPERATION-10X §Pillar 1).
 *
 * Proves the general loop-until-done primitive: a cohort body sub-workflow is
 * re-invoked each iteration, a continuation policy decides whether to keep
 * going, and the loop settles with an honest terminal verdict — bounded by a
 * hard iteration ceiling and resumable mid-flight after a crash. One child run
 * is spawned per executed iteration, which we count to prove the iteration math.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { SubflowExecutor } from '../../src/services/subflowExecutor.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function saveWorkflow(graph: WorkflowGraph): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({ id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'wf', graph, settings: {} }).run();
  return id;
}

/** Trivial cohort body (trigger only) — each iteration spawns exactly one child run. */
function bodyWorkflow(): WorkflowGraph {
  return { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } }], edges: [] } as WorkflowGraph;
}

interface EngineOpts {
  scratchpad?: ScratchpadService;
  resolveRunSpend?: (runId: string) => { costCents: number; tokens: number };
  sharedIntelligence?: unknown;
}

function buildEngine(opts: EngineOpts = {}) {
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = opts.scratchpad ?? new ScratchpadService(ctx.bus, ctx.logger);
  return new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger, scratchpad,
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    subflows: new SubflowExecutor({ db: ctx.db, ledger, scratchpad }),
    ...(opts.resolveRunSpend ? { resolveRunSpend: opts.resolveRunSpend } : {}),
    ...(opts.sharedIntelligence ? { sharedIntelligence: opts.sharedIntelligence as never } : {}),
  });
}

interface ConvergeOutput {
  converged?: boolean;
  verdict?: string;
  iterations?: number;
  history?: unknown[];
}

interface RunConvergeOpts extends EngineOpts {
  seedHistory?: unknown[];
  /** Claims pre-seeded onto the blackboard (namespace = node id 'C') before settle. */
  seedClaims?: Array<{ statement: string; runtime?: string; supersedes?: string }>;
}

async function runConverge(
  convergeConfig: Record<string, unknown>,
  opts: RunConvergeOpts = {},
): Promise<{ childRuns: number; output: ConvergeOutput }> {
  const bodyWfId = saveWorkflow(bodyWorkflow());
  const parent = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'C', type: 'converge', title: 'converge', position: { x: 1, y: 0 }, config: { kind: 'converge', bodyWorkflowId: bodyWfId, isolation: 'shared', ...convergeConfig } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'C' }],
  } as unknown as WorkflowGraph;
  const parentWfId = saveWorkflow(parent);

  const runId = randomUUID();
  const inputs = {};
  const initialState = buildInitialRunState({ runId, workflowId: parentWfId, graph: parent, inputs });
  if (opts.seedHistory) {
    (initialState.nodeStates['C'] as { outputData?: Record<string, unknown> }).outputData = {
      _convergeState: { history: opts.seedHistory, accumulated: {} },
    };
  }
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id, status: 'CREATED', runState: initialState as unknown as object }).run();

  // Pre-seed claims onto the blackboard so the goal_met promotion has something to graduate.
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  for (const c of opts.seedClaims ?? []) {
    scratchpad.claim(runId, c.statement, { namespace: 'C', identity: { runtime: c.runtime ?? null }, supersedes: c.supersedes });
  }

  const engine = buildEngine({ scratchpad, resolveRunSpend: opts.resolveRunSpend, sharedIntelligence: opts.sharedIntelligence });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) { clearTimeout(timer); off(); resolve(); }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id, triggerId: null, inputs, initialState, graph: parent });
  });

  const childRuns = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.parentRunId, runId)).all().length;
  const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  const state = run.runState as { nodeStates: Record<string, { outputData?: ConvergeOutput }> };
  return { childRuns, output: state.nodeStates.C?.outputData ?? {} };
}

describe('WorkflowEngine — convergence loop', () => {
  it('iterates until the deterministic goal is met, then settles goal_met', async () => {
    // Continue WHILE iteration < 2 → runs iterations 0,1,2 then stops.
    const { childRuns, output } = await runConverge({
      continuation: { type: 'deterministic', expr: 'iteration < 2' },
      maxIterations: 8,
    });
    expect(childRuns).toBe(3);
    expect(output.verdict).toBe('goal_met');
    expect(output.converged).toBe(true);
    expect(output.iterations).toBe(3);
    expect(output.history).toHaveLength(3);
  });

  it('respects the hard iteration ceiling with an honest verdict', async () => {
    // Always continue → only the ceiling stops it.
    const { childRuns, output } = await runConverge({
      continuation: { type: 'deterministic', expr: 'true' },
      maxIterations: 3,
    });
    expect(childRuns).toBe(3);
    expect(output.verdict).toBe('max_iterations');
    expect(output.converged).toBe(false);
    expect(output.iterations).toBe(3);
  });

  it('stops early on a stall when iterations stop making progress', async () => {
    // The trigger-only body produces an identical output every pass, so the
    // signature repeats → the stall guard fires after `window` no-change passes.
    const { childRuns, output } = await runConverge({
      continuation: { type: 'deterministic', expr: 'true' },
      maxIterations: 8,
      stallPolicy: { window: 2 },
    });
    expect(output.verdict).toBe('stalled');
    expect(childRuns).toBe(2);
    expect(output.iterations).toBe(2);
  });

  it('resumes mid-loop from persisted iteration state (durable)', async () => {
    // One iteration was persisted before the "crash"; only iters 1 and 2 run.
    const { childRuns, output } = await runConverge(
      { continuation: { type: 'deterministic', expr: 'iteration < 2' }, maxIterations: 8 },
      { seedHistory: [{ iteration: 0, durationMs: 1, continue: true, verdict: 'open', stallStreak: 0 }] },
    );
    expect(childRuns).toBe(2);
    expect(output.verdict).toBe('goal_met');
    expect(output.iterations).toBe(3);
  });

  it('stops on the USD budget against real recorded spend (budget_exhausted)', async () => {
    // Spend grows each time the breaker checks: $0.50, then $1.50 (> $1 cap).
    let calls = 0;
    const { childRuns, output } = await runConverge(
      { continuation: { type: 'deterministic', expr: 'true' }, maxIterations: 8, budget: { usd: 1 } },
      { resolveRunSpend: () => ({ costCents: (++calls) * 100 - 50, tokens: 0 }) },
    );
    expect(output.verdict).toBe('budget_exhausted');
    expect(childRuns).toBe(1); // one iteration ran before the second check tripped
    expect(output.iterations).toBe(1);
  });

  it('stops on the token budget against real recorded spend (budget_exhausted)', async () => {
    let calls = 0;
    const { output } = await runConverge(
      { continuation: { type: 'deterministic', expr: 'true' }, maxIterations: 8, budget: { tokens: 100 } },
      { resolveRunSpend: () => ({ costCents: 0, tokens: (++calls) * 80 }) },
    );
    expect(output.verdict).toBe('budget_exhausted');
  });

  it('promotes the surviving (non-superseded) claims to the Brain on goal_met', async () => {
    const promoteCalls: Array<{ taskOutput?: unknown }> = [];
    const sharedIntelligence = {
      promote: async (input: { taskOutput?: unknown }) => { promoteCalls.push(input); return { created: 1, reinforced: 0, linked: 0 }; },
      applyEvaluatorVerdict: () => {},
    };
    const { output } = await runConverge(
      { continuation: { type: 'deterministic', expr: 'iteration < 1' }, maxIterations: 8 },
      {
        sharedIntelligence,
        seedClaims: [
          { statement: 'Bug #3 in the auth handler is fixed and the regression test passes.', runtime: 'codex' },
          // A disputed claim + the claim that supersedes it — only the survivor is promoted.
          { statement: 'The rate limiter is correct as written and needs no change.', runtime: 'opus' },
        ],
      },
    );
    expect(output.verdict).toBe('goal_met');
    expect(promoteCalls).toHaveLength(1);
    const taskOutput = promoteCalls[0]?.taskOutput as { convergedClaims?: string[] };
    expect(taskOutput.convergedClaims?.length).toBeGreaterThan(0);
    expect(taskOutput.convergedClaims?.join(' ')).toMatch(/auth handler/);
  });

  it('does NOT promote when the loop did not converge (stalled)', async () => {
    const promoteCalls: unknown[] = [];
    const sharedIntelligence = {
      promote: async (input: unknown) => { promoteCalls.push(input); return { created: 0, reinforced: 0, linked: 0 }; },
      applyEvaluatorVerdict: () => {},
    };
    const { output } = await runConverge(
      { continuation: { type: 'deterministic', expr: 'true' }, maxIterations: 8, stallPolicy: { window: 2 } },
      { sharedIntelligence, seedClaims: [{ statement: 'A claim that should not be promoted because we stalled.', runtime: 'opus' }] },
    );
    expect(output.verdict).toBe('stalled');
    expect(promoteCalls).toHaveLength(0);
  });
});
