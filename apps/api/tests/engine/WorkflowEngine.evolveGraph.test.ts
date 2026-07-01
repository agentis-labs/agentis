/**
 * AGENT-PRIMARY M1 + M2 — evolveGraph (the contract transaction) and the TRUE
 * e2e: an agent inside a run calls `evolve_plan`, the engine validates + commits,
 * and the newly-authored node executes to completion in the same run.
 *
 *  - transaction: commit · coupling-reject · authority-reject · immutable-reject
 *  - e2e: agent_session emits evolve_plan → new transform node runs → run COMPLETED
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type SessionAdapter, type SessionStepResult, type WorkflowGraph, type WorkflowGraphPatch } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { WorkspaceVolumeService } from '../../src/services/workspaceVolume.js';
import { AgentToolRuntime } from '../../src/services/agentToolRuntime.js';
import { EvaluatorRuntime } from '../../src/services/evaluatorRuntime.js';
import { SpecialistAgentService } from '../../src/services/specialistAgents.js';
import { AgentSessionService } from '../../src/services/agentSession.js';
import { AgentSessionRuntime } from '../../src/services/agentSessionRuntime.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dataDir: string;

function tf(id: string, expression: string) {
  return { id, type: 'transform', title: id, position: { x: 0, y: 0 }, config: { kind: 'transform', expression } };
}
const trigger = { id: 'T', type: 'trigger', title: 'T', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } };

/** base: T → P(produces {items}). Evolutions hang off P. */
function baseGraph(): WorkflowGraph {
  return {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [trigger, tf('P', '({ items: [] })')],
    edges: [{ id: 'e1', source: 'T', target: 'P' }],
  } as unknown as WorkflowGraph;
}

function buildEngine(adapter?: SessionAdapter): WorkflowEngine {
  const volume = new WorkspaceVolumeService(dataDir);
  const agentTools = new AgentToolRuntime({ volume });
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const sessions = new AgentSessionService(ctx.db, ctx.logger);
  // Late-bind the evolve callback so the session runtime reaches the engine.
  let evolveFn: ((a: { runId: string; patch: WorkflowGraphPatch }) => ReturnType<WorkflowEngine['evolveGraph']>) | undefined;
  const sessionRuntime = new AgentSessionRuntime({
    sessions, ...(adapter ? { adapter } : {}), scratchpad, bus: ctx.bus, logger: ctx.logger, agentTools,
    evolvePlan: (a) => evolveFn!(a),
  });
  const evaluatorRuntime = new EvaluatorRuntime({
    baseUrl: 'http://stub/v1', model: 'stub', logger: ctx.logger,
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
  });
  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus), scratchpad,
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    specialists: new SpecialistAgentService(ctx.db),
    agentTools, evaluatorRuntime,
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    sessions, sessionRuntime,
  });
  evolveFn = (a) => engine.evolveGraph(a);
  return engine;
}

/** Seed a run at rest (no live ctx) so we can call evolveGraph directly. */
function seedRun(graph: WorkflowGraph, mutate?: (state: ReturnType<typeof buildInitialRunState>) => void, settings: object = {}): { wfId: string; runId: string } {
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'wf', graph, settings,
  }).run();
  const state = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  mutate?.(state);
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id,
    status: 'RUNNING', runState: state,
  }).run();
  return { wfId, runId };
}

function patch(over: Partial<WorkflowGraphPatch>): WorkflowGraphPatch {
  return { patchId: randomUUID(), reason: 'agent_evolve', baseGraphRevision: 0, addNodes: [], updateNodes: [], removeNodeIds: [], addEdges: [], removeEdgeIds: [], ...over };
}

beforeEach(async () => { ctx = await createTestContext(); dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-evolve-')); });
afterEach(async () => { ctx.close(); await rm(dataDir, { recursive: true, force: true }); });

describe('WorkflowEngine.evolveGraph — the contract transaction', () => {
  it('commits an additive, coupling-clean evolution and bumps the revision', async () => {
    const engine = buildEngine();
    const { wfId, runId } = seedRun(baseGraph());
    const res = await engine.evolveGraph({
      runId, authority: 'agent',
      patch: patch({ addNodes: [tf('A', '({ ok: true })')], addEdges: [{ id: 'e2', source: 'P', target: 'A' }] }),
    });
    expect(res.committed).toBe(true);
    if (res.committed) expect(res.newRevision).toBe(2);
    const wf = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, wfId)).get()!;
    expect((wf.graph as WorkflowGraph).nodes.map((n) => n.id).sort()).toEqual(['A', 'P', 'T']);
  });

  it('rejects a NEW coupling break with a named regression (never commits)', async () => {
    const engine = buildEngine();
    const { wfId, runId } = seedRun(baseGraph());
    const res = await engine.evolveGraph({
      runId, authority: 'agent',
      patch: patch({ addNodes: [tf('Q', '({ bad: input.missing })')], addEdges: [{ id: 'e2', source: 'P', target: 'Q' }] }),
    });
    expect(res.committed).toBe(false);
    if (!res.committed) {
      expect(res.rejected).toBe('regression');
      expect(res.regressions.some((r) => r.code === 'COUPLING_BREAK' && r.nodeId === 'Q')).toBe(true);
    }
    // The graph is untouched — no half-applied state.
    const wf = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, wfId)).get()!;
    expect((wf.graph as WorkflowGraph).nodes.map((n) => n.id).sort()).toEqual(['P', 'T']);
  });

  it('refuses agent self-evolution in operator (deterministic) mode', async () => {
    const engine = buildEngine();
    const { runId } = seedRun(baseGraph());
    const res = await engine.evolveGraph({
      runId, authority: 'operator',
      patch: patch({ addNodes: [tf('A', '({ ok: true })')], addEdges: [{ id: 'e2', source: 'P', target: 'A' }] }),
    });
    expect(res.committed).toBe(false);
    if (!res.committed) expect(res.rejected).toBe('authority');
  });

  it('refuses to remove a node that is already completed (immutable spine)', async () => {
    const engine = buildEngine();
    const { runId } = seedRun(baseGraph(), (state) => {
      state.nodeStates.P = { nodeId: 'P', status: 'COMPLETED' };
    });
    const res = await engine.evolveGraph({ runId, authority: 'agent', patch: patch({ removeNodeIds: ['P'] }) });
    expect(res.committed).toBe(false);
    if (!res.committed) expect(res.regressions.some((r) => r.code === 'IMMUTABLE_NODE')).toBe(true);
  });

  it('M3: refuses to auto-commit an OUTWARD new step under agent_within_green', async () => {
    const engine = buildEngine();
    const { runId } = seedRun(baseGraph());
    const outward = { id: 'OUT', type: 'integration', title: 'Send', position: { x: 0, y: 0 }, config: { kind: 'integration', integrationId: 'email' } };
    const res = await engine.evolveGraph({
      runId, authority: 'agent_within_green',
      patch: patch({ addNodes: [outward], addEdges: [{ id: 'e2', source: 'P', target: 'OUT' }] }),
    });
    expect(res.committed).toBe(false);
    if (!res.committed) {
      expect(res.rejected).toBe('authority');
      expect(res.regressions.some((r) => r.nodeId === 'OUT')).toBe(true);
    }
  });

  it('M6: executionMode "deterministic" resolves to operator authority (refuses evolution)', async () => {
    const engine = buildEngine();
    // No authority override — resolution flows through the workflow's executionMode.
    const { runId } = seedRun(baseGraph(), undefined, { executionMode: 'deterministic' });
    const res = await engine.evolveGraph({
      runId,
      patch: patch({ addNodes: [tf('A', '({ ok: true })')], addEdges: [{ id: 'e2', source: 'P', target: 'A' }] }),
    });
    expect(res.committed).toBe(false);
    if (!res.committed) expect(res.rejected).toBe('authority');
  });

  it('M6: a committed evolution writes a rollback checkpoint', async () => {
    const engine = buildEngine();
    const { runId } = seedRun(baseGraph());
    const res = await engine.evolveGraph({
      runId, authority: 'agent',
      patch: patch({ addNodes: [tf('A', '({ ok: true })')], addEdges: [{ id: 'e2', source: 'P', target: 'A' }] }),
    });
    expect(res.committed).toBe(true);
    const checkpoints = ctx.db.select().from(schema.workflowRepairCheckpoints)
      .where(eq(schema.workflowRepairCheckpoints.runId, runId)).all();
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0]!.incidentId).toBe('evolve');
  });
});

// ── The true e2e: an agent inside a run authors a step and it executes. ──

const fin = (text: string): SessionStepResult => ({ text, toolCalls: [], finishReason: 'stop' });

/** First turn: evolve the plan (add a downstream transform). After it commits: complete. */
function evolvingAdapter(): SessionAdapter {
  return {
    id: 'evolve-stub',
    async executeStep({ messages }): Promise<SessionStepResult> {
      const text = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' || ');
      if (text.includes('Plan extended')) return fin('done — the new step will run');
      return {
        text: 'discovered a missing step; extending the plan',
        toolCalls: [{
          id: 'tc1', name: 'evolve_plan',
          arguments: {
            reason: 'need a finalize step the original plan lacked',
            addNodes: [tf('X', '({ evolved: true })')],
            addEdges: [{ id: 'sx', source: 'S', target: 'X' }],
          },
        }],
        finishReason: 'tool_calls',
      };
    },
  };
}

describe('WorkflowEngine — agent self-evolution e2e (M2)', () => {
  it('an agent_session evolves its own live graph and the new node runs to completion', async () => {
    const engine = buildEngine(evolvingAdapter());
    const g: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        trigger,
        { id: 'S', type: 'agent_session', title: 'Lead', position: { x: 200, y: 0 }, config: { kind: 'agent_session', agentRole: 'orchestrator', prompt: 'Reach the objective; evolve the plan if a step is missing.', inputKeys: [], outputKeys: [], capabilityTags: [] } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'S' }],
    } as unknown as WorkflowGraph;

    const wfId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'evolve-e2e', graph: g, settings: {} }).run();
    const runId = randomUUID();
    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph: g, inputs: {} });
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: initialState }).run();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
      const off = ctx.bus.subscribe((m) => {
        if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) { clearTimeout(timer); off(); resolve(); }
      });
      void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph: g });
    });

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    // The agent-authored node exists in the persisted graph AND executed.
    const finalGraph = (ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, wfId)).get()!.graph) as WorkflowGraph;
    expect(finalGraph.nodes.some((n) => n.id === 'X')).toBe(true);
    const state = run.runState as { nodeStates: Record<string, { status: string; outputData?: { evolved?: boolean } }> };
    expect(state.nodeStates.X?.status).toBe('COMPLETED');
    expect(state.nodeStates.X?.outputData?.evolved).toBe(true);
  });
});
