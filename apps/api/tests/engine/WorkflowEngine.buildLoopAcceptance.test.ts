/**
 * BUILD-LOOP ACCEPTANCE (WORKFLOW-BUILD-LOOP).
 *
 * A faithful reproduction of the operator's "Catalog Launch Workflow" failure
 * shape, driven through the REAL production engine + dry-run — not mocks of them.
 * Candidates flow trigger -> normalize -> scorer, then a gate routes on
 * nodes["score"].scoredCount (the exact condition that used to silently evaluate
 * to undefined, skip both branches, and produce "no store selected" forever).
 *
 * The scorer is a deterministic transform standing in for the AI scorer, so the
 * test proves the DATA FLOW + ROUTING + DRY-RUN the platform fixes are about —
 * it does not exercise a live LLM authoring the graph (that needs a running
 * instance + model keys).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  type AdapterCapabilities,
  type AdapterType,
  type AgentAdapter,
  type ChatDelta,
  type ChatInvocationOptions,
  type ChatMessage,
  type NormalizedAgentEvent,
  type NormalizedTask,
  type ToolDefinition,
  type WorkflowGraph,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { preflightWorkflow } from '../../src/services/workflow/workflowPreflight.js';
import { analyzeInputReachability } from '../../src/engine/validateExpressions.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

// The operator's real candidate batch (abbreviated), verbatim shape.
const CANDIDATES = [
  { instagramHandle: 'lojazys', name: 'ZYS | MODA FEMININA', followerCount: 6912, hasWhatsapp: true },
  { instagramHandle: 'useflavinhaaraujo', name: 'Use Flavinha Araújo', followerCount: 1110, hasWhatsapp: false },
  { instagramHandle: 'ksbellamoda', name: 'Loja moda feminina Manaus', followerCount: 91500, hasWhatsapp: false },
  { instagramHandle: 'modarihanne', name: 'R I H A N N E', followerCount: 131000, hasWhatsapp: false },
];

/** trigger -> normalize -> score -> (accept | reject), gated on nodes["score"].scoredCount. */
function catalogLaunchGraph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      {
        id: 'normalize', type: 'transform', title: 'Normalize prospect batch', position: { x: 200, y: 0 },
        config: { kind: 'transform', expression: '({ candidates: input.candidates || [], rawScoutCount: (input.candidates || []).length })' },
      },
      {
        id: 'score', type: 'transform', title: 'Prospect score', position: { x: 400, y: 0 },
        config: { kind: 'transform', expression: '({ scoredCount: (input.candidates || []).length, selected: (input.candidates || [])[0] || null, ranked: input.candidates || [] })' },
      },
      { id: 'accept', type: 'return_output', title: 'Selected store', position: { x: 600, y: 0 }, config: { kind: 'return_output', renderAs: 'markdown' } },
      { id: 'reject', type: 'return_output', title: 'No store found', position: { x: 600, y: 200 }, config: { kind: 'return_output', renderAs: 'markdown' } },
    ],
    edges: [
      { id: 't-n', source: 'trigger', target: 'normalize' },
      { id: 'n-s', source: 'normalize', target: 'score' },
      { id: 's-a', source: 'score', target: 'accept', type: 'condition', condition: 'nodes["score"].scoredCount > 0' },
      { id: 's-r', source: 'score', target: 'reject', type: 'condition', condition: 'nodes["score"].scoredCount == 0' },
    ],
  };
}

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => { vi.restoreAllMocks(); ctx.close(); });

describe('Build-loop acceptance — Catalog Launch Workflow shape', () => {
  it('runs E2E green: candidates reach the scorer and the gate routes on nodes["score"].scoredCount (the exact bug, fixed)', async () => {
    const graph = catalogLaunchGraph();
    const { runId, workflowId, initialState } = persistWorkflow(graph, { candidates: CANDIDATES });
    const terminal = waitForTerminal(runId);
    await makeEngine().startRun({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id,
      triggerId: null, inputs: { candidates: CANDIDATES }, initialState, graph,
    });
    await terminal;

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = run.runState as { nodeStates: Record<string, { status: string; outputData?: Record<string, unknown> }> };

    expect(run.status).toBe('COMPLETED');
    // Candidates flowed all the way to the scorer (P0 data-flow):
    expect(state.nodeStates.score?.outputData?.scoredCount).toBe(4);
    // The gate routed correctly on the upstream node's real output (P0.1):
    expect(state.nodeStates.accept?.status).toBe('COMPLETED');
    expect(state.nodeStates.reject?.status).toBe('SKIPPED');
  });

  it('routes to reject — honestly — on an empty batch (no silent "success")', async () => {
    const graph = catalogLaunchGraph();
    const { runId, workflowId, initialState } = persistWorkflow(graph, { candidates: [] });
    const terminal = waitForTerminal(runId);
    await makeEngine().startRun({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id,
      triggerId: null, inputs: { candidates: [] }, initialState, graph,
    });
    await terminal;

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = run.runState as { nodeStates: Record<string, { status: string; outputData?: Record<string, unknown> }> };
    expect(run.status).toBe('COMPLETED');
    expect(state.nodeStates.score?.outputData?.scoredCount).toBe(0);
    expect(state.nodeStates.reject?.status).toBe('COMPLETED');
    expect(state.nodeStates.accept?.status).toBe('SKIPPED');
  });

  it('dry-run traces the I/O: the scorer receives the candidates and emits scoredCount, no external call', () => {
    const graph = catalogLaunchGraph();
    const report = preflightWorkflow({
      db: ctx.db, workspaceId: ctx.workspace.id, workflowId: 'dry-run-accept', graph,
      inputs: { candidates: CANDIDATES }, mode: 'canvas',
    });
    const score = report.nodes.score;
    expect(score).toBeDefined();
    expect(score!.status).not.toBe('failed');
    // The trace shows candidates actually arriving at the scorer (P2.3 I/O trace):
    expect(Array.isArray((score!.input as { candidates?: unknown }).candidates)).toBe(true);
    expect((score!.output as { scoredCount?: unknown }).scoredCount).toBe(4);
  });

  it('reachability lint catches the input strip that caused the original failure', () => {
    // Reproduce the operator's inputMapping/inputKeys mistake: the scorer narrows
    // its input and drops `candidates`, but still references it.
    const graph = catalogLaunchGraph();
    const score = graph.nodes.find((n) => n.id === 'score')!;
    (score.config as Record<string, unknown>).inputKeys = ['rawScoutCount'];
    const issues = analyzeInputReachability(graph);
    expect(issues.some((i) => i.identifier === 'input.candidates')).toBe(true);
  });

  it('does NOT starve an agent_task whose inputKeys are MISUSED as node references (real 71-node-workflow regression)', async () => {
    // The operator's real workflow set inputKeys: ["nodes.prospect-plan"] on agent
    // nodes (node references, not top-level keys). Honoring that literally would
    // pickKeys -> {} and starve the agent. The P0.3 guard keeps the full input.
    const captured: Record<string, unknown>[] = [];
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Scout', adapterType: 'codex', capabilityTags: [], config: {}, role: 'worker', status: 'online',
    }).run();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new CapturingAdapter(agentId, captured, { ok: true }));
    const engine = makeEngine(adapters);
    adapters.onEvent((event) => {
      if (event.eventType === 'task.completed') {
        void engine.notifyTaskCompleted({ runId: event.runId, nodeId: event.taskId, output: event.output });
      }
    });

    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'source', type: 'transform', title: 'Source', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ candidates: [1,2,3], meta: "x" })' } },
        { id: 'worker', type: 'agent_task', title: 'Scout', position: { x: 400, y: 0 }, config: { kind: 'agent_task', agentId, prompt: 'scout', inputKeys: ['nodes.source'], outputKeys: ['ok'], capabilityTags: [] } },
      ],
      edges: [{ id: 't-s', source: 'trigger', target: 'source' }, { id: 's-w', source: 'source', target: 'worker' }],
    };
    const { runId, workflowId, initialState } = persistWorkflow(graph, {});
    const terminal = waitForTerminal(runId);
    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
    await terminal;

    expect(captured.length).toBeGreaterThan(0);
    // The agent got the FULL upstream output, not {} — the misused inputKeys
    // selected nothing, so the guard preserved the input.
    expect(captured[0]).toHaveProperty('candidates');
  });

  it('adapts an agent that produced usable output but omitted declared keys — typed-empty defaults, no crash (scout regression)', async () => {
    // The operator's exact failure: "agent node 'prospect-scout' did not produce
    // declared output key(s): candidates, searchQueriesUsed, ...". The agent DID
    // produce usable output (a summary) but not the declared metadata keys → it now
    // completes with typed-empty defaults instead of hard-failing the whole run.
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Scout', adapterType: 'codex', capabilityTags: [], config: {}, role: 'worker', status: 'online',
    }).run();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new CapturingAdapter(agentId, [], { summary: 'Scouted, but returned prose not the declared JSON.' }));
    const engine = makeEngine(adapters);
    adapters.onEvent((event) => {
      if (event.eventType === 'task.completed') void engine.notifyTaskCompleted({ runId: event.runId, nodeId: event.taskId, output: event.output });
    });

    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'scout', type: 'agent_task', title: 'Instagram Scout', position: { x: 200, y: 0 }, config: { kind: 'agent_task', agentId, prompt: 'Find stores.', inputKeys: [], outputKeys: ['candidates', 'searchQueriesUsed', 'rejectedHandles', 'processedHandles', 'exhausted', 'blockers'], capabilityTags: [] } },
      ],
      edges: [{ id: 't-s', source: 'trigger', target: 'scout' }],
    };
    const { runId, workflowId, initialState } = persistWorkflow(graph, {});
    const terminal = waitForTerminal(runId);
    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
    await terminal;

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = run.runState as { nodeStates: Record<string, { status: string; outputData?: Record<string, unknown> }> };
    // No crash — the run completed (with an honest contract-violation marker).
    expect(['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION']).toContain(run.status);
    expect(state.nodeStates.scout?.status).toBe('COMPLETED');
    // Genuinely-absent metadata keys were completed with typed-empty defaults:
    expect(state.nodeStates.scout?.outputData?.candidates).toEqual([]);
    expect(state.nodeStates.scout?.outputData?.exhausted).toBe(false);
    expect(state.nodeStates.scout?.outputData?.blockers).toEqual([]);
  });

  it('RESHAPES usable-but-wrong-shape output onto the contract — recovers SUBSTANCE, not just empty defaults (LLM reshape)', async () => {
    // The agent did the real work but returned {stores:[…]} where the contract
    // declares `candidates`. A wired, grounded one-shot reshape maps its own data
    // onto the contract — so downstream gets the REAL stores, not candidates:[]
    // (which is all typed-defaulting alone could have produced).
    const RECOVERED = [{ instagramHandle: 'lojazys', name: 'ZYS' }, { instagramHandle: 'modarihanne', name: 'RIHANNE' }];
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Scout', adapterType: 'codex', capabilityTags: [], config: {}, role: 'worker', status: 'online',
    }).run();
    const adapters = new AdapterManager(ctx.logger);
    // Agent returns the RIGHT data under WRONG key names (`stores`) — and MULTIPLE
    // declared keys, so the lenient single-key auto-remap can't rescue it. This is
    // exactly where typed-defaulting alone would blank `candidates` to [].
    adapters.register(agentId, new CapturingAdapter(agentId, [], { stores: RECOVERED }));
    // A WIRED synthesis runtime that maps the source's data onto the declared keys.
    let reshapeCalls = 0;
    const reshapeRuntime = {
      completeStructured: async ({ user }: { user: string }): Promise<Record<string, unknown>> => {
        reshapeCalls += 1;
        // Grounded: recover the stores the agent ACTUALLY produced from the SOURCE.
        const m = /"stores"\s*:\s*(\[[\s\S]*?\])/.exec(user);
        return { candidates: m ? JSON.parse(m[1]) : [], exhausted: true };
      },
    };
    const engine = makeEngine(adapters, { resolveEvaluatorRuntime: () => reshapeRuntime });
    adapters.onEvent((event) => {
      if (event.eventType === 'task.completed') void engine.notifyTaskCompleted({ runId: event.runId, nodeId: event.taskId, output: event.output });
    });

    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'scout', type: 'agent_task', title: 'Scout', position: { x: 200, y: 0 }, config: { kind: 'agent_task', agentId, prompt: 'Find stores.', inputKeys: [], outputKeys: ['candidates', 'exhausted'], capabilityTags: [] } },
      ],
      edges: [{ id: 't-s', source: 'trigger', target: 'scout' }],
    };
    const { runId, workflowId, initialState } = persistWorkflow(graph, {});
    const terminal = waitForTerminal(runId);
    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
    await terminal;

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = run.runState as { nodeStates: Record<string, { status: string; outputData?: Record<string, unknown> }> };
    expect(reshapeCalls).toBe(1);
    expect(state.nodeStates.scout?.status).toBe('COMPLETED');
    // The declared keys hold the REAL recovered data — not empty defaults.
    expect(state.nodeStates.scout?.outputData?.candidates).toEqual(RECOVERED);
    expect(state.nodeStates.scout?.outputData?.exhausted).toBe(true);
  });

  it('quarantines a RESOURCE failure (usage limit) — pauses the node, never fails or edits it (Organ 4)', async () => {
    // The transcript: "Instagram Fashion Store Scout failed: Codex exited with code
    // 1: You've hit your usage limit." A rate/usage limit is NOT a workflow bug —
    // the node is quarantined (paused) so the operator waits/adds capacity and
    // resumes, instead of the run failing (which is what made the agent delete it).
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Scout', adapterType: 'codex', capabilityTags: [], config: {}, role: 'worker', status: 'online',
    }).run();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new FailingAdapter(agentId, "Codex exited with code 1: You've hit your usage limit."));
    const engine = makeEngine(adapters);
    adapters.onEvent((event) => {
      if (event.eventType === 'task.failed') {
        void engine.notifyTaskFailed({ runId: event.runId, nodeId: event.taskId, error: String((event as { error?: unknown }).error ?? '') });
      }
    });

    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'scout', type: 'agent_task', title: 'Scout', position: { x: 200, y: 0 }, config: { kind: 'agent_task', agentId, prompt: 'find', inputKeys: [], outputKeys: ['candidates'], capabilityTags: [] } },
      ],
      edges: [{ id: 't-s', source: 'trigger', target: 'scout' }],
    };
    const { runId, workflowId, initialState } = persistWorkflow(graph, {});
    await engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
    // Poll until the node is quarantined (the pause persists just after its event).
    const readRun = () => ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const deadline = Date.now() + 15_000;
    let run = readRun();
    while (Date.now() < deadline && (run.runState as { nodeStates?: Record<string, { status?: string }> }).nodeStates?.scout?.status !== 'WAITING') {
      await new Promise((r) => setTimeout(r, 40));
      run = readRun();
    }
    const state = run.runState as { nodeStates: Record<string, { status: string; blockedReason?: string }> };
    expect(run.status).not.toBe('FAILED');            // quarantined, not failed
    expect(state.nodeStates.scout?.status).toBe('WAITING');
    expect(state.nodeStates.scout?.blockedReason ?? '').toMatch(/limit/i);
  });
});

/** Records the inputData handed to the dispatched agent, then completes the task. */
class CapturingAdapter implements AgentAdapter {
  readonly adapterType: AdapterType = 'codex';
  readonly #handlers = new Set<(e: NormalizedAgentEvent) => void>();
  constructor(
    private readonly agentId: string,
    private readonly sink: Record<string, unknown>[],
    private readonly payload: Record<string, unknown>,
  ) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck() { return { isHealthy: true, checkedAt: new Date().toISOString() }; }
  capabilities(): AdapterCapabilities { return { interactiveChat: true, toolCalling: false }; }
  onEvent(handler: (e: NormalizedAgentEvent) => void): void { this.#handlers.add(handler); }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    this.sink.push(task.inputData as Record<string, unknown>);
    queueMicrotask(() => {
      for (const handler of this.#handlers) {
        handler({
          eventType: 'task.completed', agentId: this.agentId, taskId: task.taskId,
          runId: task.runId, workflowId: task.workflowId,
          output: { text: ['```json', JSON.stringify(this.payload), '```'].join('\n') },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }
  async *chat(_h: ChatMessage[], _t: ToolDefinition[], _o?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    yield { type: 'done', finishReason: 'stop' };
  }
  async cancelTask(): Promise<void> {}
}

/** Dispatches then emits a `task.failed` with a fixed error (to drive #failNode). */
class FailingAdapter implements AgentAdapter {
  readonly adapterType: AdapterType = 'codex';
  readonly #handlers = new Set<(e: NormalizedAgentEvent) => void>();
  constructor(private readonly agentId: string, private readonly error: string) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck() { return { isHealthy: true, checkedAt: new Date().toISOString() }; }
  capabilities(): AdapterCapabilities { return { interactiveChat: true, toolCalling: false }; }
  onEvent(handler: (e: NormalizedAgentEvent) => void): void { this.#handlers.add(handler); }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    queueMicrotask(() => {
      for (const handler of this.#handlers) {
        handler({ eventType: 'task.failed', agentId: this.agentId, taskId: task.taskId, runId: task.runId, workflowId: task.workflowId, error: this.error, timestamp: new Date().toISOString() } as NormalizedAgentEvent);
      }
    });
  }
  async *chat(_h: ChatMessage[], _t: ToolDefinition[], _o?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    yield { type: 'done', finishReason: 'stop' };
  }
  async cancelTask(): Promise<void> {}
}

function makeEngine(adapters: AdapterManager = new AdapterManager(ctx.logger), extra: Record<string, unknown> = {}): WorkflowEngine {
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters,
    ...extra,
  } as ConstructorParameters<typeof WorkflowEngine>[0]);
}

function persistWorkflow(graph: WorkflowGraph, inputs: Record<string, unknown>): {
  workflowId: string;
  runId: string;
  initialState: ReturnType<typeof buildInitialRunState>;
} {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId, graph, inputs });
  ctx.db.insert(schema.workflows).values({
    id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'Catalog Launch Workflow (acceptance)', graph, settings: {},
  }).run();
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId, userId: ctx.user.id,
    status: 'CREATED', runState: initialState,
  }).run();
  return { workflowId, runId, initialState };
}

function waitForTerminal(runId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const unsubscribe = ctx.bus.subscribe((message) => {
      if (
        message.room === `run:${runId}`
        && (message.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || message.envelope.event === REALTIME_EVENTS.RUN_FAILED)
      ) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}
