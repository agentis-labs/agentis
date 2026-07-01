/**
 * AGENT-AUTONOMY §W7/W5.0 — workflow self-healing end-to-end through the engine.
 *
 *   (a) output recovery: a node misses its declared output contract → self-heal
 *       recovers the keys from the agent's own output → the run completes;
 *   (b) autonomous structural repair: self-heal applies a certified graph patch
 *       (graphRevision bumps) and re-dispatches → the run completes;
 *   (c) approve mode: a structural fix pauses the node for approval, and
 *       resolveApproval('approve') applies it + resumes to completion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type AgentAdapter, type WorkflowGraph } from '@agentis/core';
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
import { setSelfHealConfig } from '../../src/services/selfHealSettings.js';
import { WorkflowSelfHealService, type SelfHealResult } from '../../src/services/workflowSelfHeal.js';
import { setSelfHealConfig } from '../../src/services/selfHealSettings.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { BusMessage } from '../../src/event-bus.js';

let ctx: TestContext;
let dataDir: string;

function scriptedFetch(decision: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

interface BuildEngineOptions {
  evaluatorRuntime?: EvaluatorRuntime | null;
  adapters?: AdapterManager;
  resolveAgentRuntime?: (workspaceId: string, agentId: string, task?: string | null, explicitModel?: string | null) => AgentAdapter | undefined;
  toolRegistry?: AgentisToolRegistry;
}

function buildEngine(heal: ((input: unknown) => Promise<SelfHealResult>) | WorkflowSelfHealService, options: BuildEngineOptions = {}): WorkflowEngine {
  const volume = new WorkspaceVolumeService(dataDir);
  const defaultEvaluatorRuntime = new EvaluatorRuntime({
    baseUrl: 'http://stub/v1', model: 'stub', logger: ctx.logger,
    fetchImpl: scriptedFetch({ thought: 'done', action: 'final', output: 'The lead is promising.' }),
  });
  const deps = {
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    specialists: new SpecialistAgentService(ctx.db),
    agentTools: new AgentToolRuntime({ volume }),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: options.adapters ?? new AdapterManager(ctx.logger),
    selfHeal: typeof heal === 'function' ? ({ heal } as unknown as WorkflowSelfHealService) : heal,
  } as ConstructorParameters<typeof WorkflowEngine>[0];
  if (options.evaluatorRuntime !== null) {
    deps.evaluatorRuntime = options.evaluatorRuntime ?? defaultEvaluatorRuntime;
  }
  if (options.resolveAgentRuntime) deps.resolveAgentRuntime = options.resolveAgentRuntime;
  if (options.toolRegistry) deps.toolRegistry = options.toolRegistry;
  return new WorkflowEngine(deps);
}

function chatCapableAdapter(): AgentAdapter {
  return {
    adapterType: 'codex',
    connect: async () => {},
    disconnect: async () => {},
    healthCheck: async () => ({ isHealthy: true, checkedAt: new Date().toISOString() }),
    capabilities: () => ({ interactiveChat: true, toolCalling: false, toolForwarding: 'none' }),
    dispatchTask: async () => {},
    cancelTask: async () => {},
    onEvent: () => {},
    chat: async function* () {
      yield { type: 'text', delta: '{"ok":true}' };
      yield { type: 'done', finishReason: 'stop' };
    },
  } as AgentAdapter;
}

function selfHealChatAdapter(args: {
  nodes: WorkflowGraph['nodes'];
  edges: WorkflowGraph['edges'];
  seenTools: string[][];
}): AgentAdapter {
  return {
    adapterType: 'codex',
    connect: async () => {},
    disconnect: async () => {},
    healthCheck: async () => ({ isHealthy: true, checkedAt: new Date().toISOString() }),
    capabilities: () => ({ interactiveChat: true, toolCalling: true, toolForwarding: 'native' }),
    dispatchTask: async () => {},
    cancelTask: async () => {},
    onEvent: () => {},
    chat: async function* (messages, tools) {
      args.seenTools.push(tools.map((tool) => tool.name));
      const system = String(messages[0]?.content ?? '');
      if (system.includes('intent-preservation judge')) {
        yield { type: 'text', delta: '{"preservesIntent":true,"grounded":true,"reason":"same output meaning"}' };
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      yield {
        type: 'activity',
        id: 'self-heal-chat-working',
        phase: 'runtime',
        status: 'running',
        label: 'Inspecting failed workflow',
      };
      yield {
        type: 'text',
        delta: `<agentis_self_heal_repair>${JSON.stringify({
          nodes: args.nodes,
          edges: args.edges,
          resumeNodeId: 'A',
          grounding: 'chat repair removed the unsatisfied declared output contract',
          preservesIntent: true,
          grounded: true,
          cannotRepair: false,
        })}</agentis_self_heal_repair>`,
      };
      yield { type: 'done', finishReason: 'stop' };
    },
  } as AgentAdapter;
}

function failingTaskAdapter(): AgentAdapter {
  return {
    adapterType: 'claude_code',
    connect: async () => {},
    disconnect: async () => {},
    healthCheck: async () => ({ isHealthy: true, checkedAt: new Date().toISOString() }),
    capabilities: () => ({ interactiveChat: false, toolCalling: false, toolForwarding: 'none' }),
    dispatchTask: async () => {
      throw new Error('claude_code exited 1');
    },
    cancelTask: async () => {},
    onEvent: () => {},
  } as AgentAdapter;
}

function graphWithKeys(outputKeys: string[]): WorkflowGraph {
  return {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'A', type: 'agent_task', title: 'Qualify lead', position: { x: 200, y: 0 }, config: {
        kind: 'agent_task', agentRole: 'analyst', useRoleTools: true, capabilityTags: [],
        prompt: 'Qualify the lead.', inputKeys: [], outputKeys,
      } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'A' }],
  } as WorkflowGraph;
}

function graphWithPinnedMissingAdapter(): WorkflowGraph {
  return {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'A', type: 'agent_task', title: 'Draft candidate bundle', position: { x: 200, y: 0 }, config: {
        kind: 'agent_task', agentId: 'missing-agent', useRoleTools: false, useSession: false,
        prompt: 'Draft the candidate bundle.', inputKeys: [], outputKeys: [],
      } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'A' }],
  } as WorkflowGraph;
}

function runTo(engine: WorkflowEngine, graph: WorkflowGraph, isTerminal: (m: BusMessage) => boolean): Promise<string> {
  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'sh', graph, settings: {} }).run();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: initialState }).run();
  return new Promise<string>((resolve, reject) => {
    const seen: string[] = [];
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout; seen events: ${seen.join(', ') || 'none'}`));
    }, 15_000);
    off = ctx.bus.subscribe((m) => {
      if (m.room !== `run:${runId}`) return;
      seen.push(m.envelope.event);
      if (isTerminal(m)) { clearTimeout(timer); off(); resolve(runId); }
    });
    void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
  });
}

const completedOrFailed = (m: BusMessage) => m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED;

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-engine-selfheal-'));
});
afterEach(async () => { ctx.close(); await rm(dataDir, { recursive: true, force: true }); });

describe('WorkflowEngine — self-healing (W7/W5.0)', () => {
  it('recovers a declared-output miss from the agent output and completes (W5.0)', async () => {
    // Two declared keys ⇒ no single-key text fallback ⇒ a real contract miss.
    const engine = buildEngine(async () => ({ outcome: 'output_fixed', output: { output: 'The lead is promising.', location: 'Paris', budget: 5000 }, diagnosis: 'recovered from output' }));
    const runId = await runTo(engine, graphWithKeys(['location', 'budget']), completedOrFailed);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    const state = run.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
    expect(state.nodeStates.A?.outputData?.location).toBe('Paris');
  });

  it('applies a certified structural patch autonomously, then completes (W7)', async () => {
    // The patch removes the unsatisfiable contract from node A (intent preserved:
    // still qualifies the lead) so the re-dispatch succeeds.
    setSelfHealConfig(ctx.db, ctx.workspace.id, { mode: 'bypass' });
    const engine = buildEngine(async (input) => {
      const graph = (input as { graph: WorkflowGraph }).graph;
      const patchedGraph: WorkflowGraph = { ...graph, nodes: graph.nodes.map((n) => n.id === 'A' ? { ...n, config: { ...n.config, outputKeys: [] } } : n) };
      return { outcome: 'graph_repair', patchedGraph, diagnosis: 'contract unsatisfiable from this input', grounding: 'error cited missing keys', tier: 'minimal_patch', resumeNodeId: 'A' } as SelfHealResult;
    });
    const runId = await runTo(engine, graphWithKeys(['location', 'budget']), completedOrFailed);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    expect((run.runState as { graphRevision?: number }).graphRevision ?? 0).toBeGreaterThan(0);
    const checkpoint = ctx.db.select().from(schema.workflowRepairCheckpoints).where(eq(schema.workflowRepairCheckpoints.runId, runId)).get();
    expect(checkpoint?.graphBefore).toBeTruthy();
    expect(checkpoint?.graphAfter).toBeTruthy();
  });

  it('approve mode: pauses for approval, then applies + resumes on approve (W7)', async () => {
    const engine = buildEngine(async (input) => {
      const graph = (input as { graph: WorkflowGraph }).graph;
      const patchedGraph: WorkflowGraph = { ...graph, nodes: graph.nodes.map((n) => n.id === 'A' ? { ...n, config: { ...n.config, outputKeys: [] } } : n) };
      return { outcome: 'graph_repair', patchedGraph, diagnosis: 'needs a contract fix', grounding: 'grounded', tier: 'minimal_patch', resumeNodeId: 'A' } as SelfHealResult;
    });
    const waitForApproval = (m: BusMessage) => m.envelope.event === REALTIME_EVENTS.NODE_WAITING_FOR_INPUT || completedOrFailed(m);
    const runId = await runTo(engine, graphWithKeys(['location', 'budget']), waitForApproval);

    const pending = new ApprovalInboxService(ctx.db, ctx.bus).list(ctx.workspace.id, 'pending');
    expect(pending.length).toBeGreaterThan(0);
    const approvalId = pending[0]!.id;
    expect(pending[0]!.source).toBe('self_heal');
    expect(pending[0]!.payload).toMatchObject({
      kind: 'graph_patch',
      nodeId: 'A',
      patch: { reason: 'self_heal' },
    });

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('approve-timeout')), 15_000);
      const off = ctx.bus.subscribe((m) => { if (m.room === `run:${runId}` && completedOrFailed(m)) { clearTimeout(timer); off(); resolve(); } });
    });
    await engine.resolveApproval({ runId, approvalId, decision: 'approve' });
    await done;
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
  });

  it('rolls back the latest checkpoint without overwriting a later graph revision', async () => {
    setSelfHealConfig(ctx.db, ctx.workspace.id, { mode: 'bypass' });
    const engine = buildEngine(async (input) => {
      const graph = (input as { graph: WorkflowGraph }).graph;
      const patchedGraph: WorkflowGraph = { ...graph, nodes: graph.nodes.map((node) => node.id === 'A' ? { ...node, config: { ...node.config, outputKeys: [] } } : node) };
      return { outcome: 'graph_repair', patchedGraph, diagnosis: 'contract cannot be satisfied', grounding: 'missing declared fields', tier: 'minimal_patch', resumeNodeId: 'A' } as SelfHealResult;
    });
    const runId = await runTo(engine, graphWithKeys(['location', 'budget']), completedOrFailed);
    const checkpoint = ctx.db.select().from(schema.workflowRepairCheckpoints).where(eq(schema.workflowRepairCheckpoints.runId, runId)).get()!;
    const result = await engine.rollbackSelfHeal({ runId, checkpointId: checkpoint.id });
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(result.newRevision).toBeGreaterThan(checkpoint.revisionAfter);
    expect(((run.graphSnapshot as WorkflowGraph).nodes.find((node) => node.id === 'A')?.config as { outputKeys?: string[] }).outputKeys).toEqual(['location', 'budget']);
    expect(ctx.db.select().from(schema.workflowRepairCheckpoints).where(eq(schema.workflowRepairCheckpoints.id, checkpoint.id)).get()?.rolledBackAt).toBeTruthy();
  });

  it('surfaces a self-heal approval when dispatch fails through the shared failure path', async () => {
    const engine = buildEngine(async (input) => {
      const graph = (input as { graph: WorkflowGraph }).graph;
      const patchedGraph: WorkflowGraph = {
        ...graph,
        nodes: graph.nodes.map((n) => n.id === 'A'
          ? { ...n, config: { ...n.config, agentId: undefined, agentRole: 'analyst', useRoleTools: true } }
          : n),
      };
      return {
        outcome: 'graph_repair',
        patchedGraph,
        diagnosis: 'The node is pinned to an agent with no connected runtime.',
        grounding: 'Dispatch raised ADAPTER_UNAVAILABLE before the node could run.',
        tier: 'minimal_patch',
        resumeNodeId: 'A',
      } as SelfHealResult;
    });
    const waitForApproval = (m: BusMessage) => {
      const payload = m.envelope.payload as { status?: string };
      return (m.envelope.event === REALTIME_EVENTS.RUN_RUNNING && payload.status === 'WAITING') || completedOrFailed(m);
    };
    await runTo(engine, graphWithPinnedMissingAdapter(), waitForApproval);

    const pending = new ApprovalInboxService(ctx.db, ctx.bus).list(ctx.workspace.id, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.source).toBe('self_heal');
    expect(pending[0]!.payload).toMatchObject({
      kind: 'graph_patch',
      nodeId: 'A',
      diagnosis: 'The node is pinned to an agent with no connected runtime.',
    });
  });

  it('rebuilds a failed unresolved frontier and resumes from the replacement node', async () => {
    setSelfHealConfig(ctx.db, ctx.workspace.id, { mode: 'bypass' });
    const engine = buildEngine(async (input) => {
      const graph = (input as { graph: WorkflowGraph }).graph;
      const original = graph.nodes.find((node) => node.id === 'A')!;
      const replacement = { ...original, id: 'A-rebuilt', title: 'Rebuilt qualifier', config: { ...original.config, outputKeys: [] } };
      return {
        outcome: 'graph_repair',
        patchedGraph: {
          ...graph,
          nodes: graph.nodes.filter((node) => node.id !== 'A').concat(replacement),
          edges: graph.edges.filter((edge) => edge.target !== 'A').concat({ id: 'e-rebuilt', source: 'T', target: 'A-rebuilt' }),
        },
        diagnosis: 'The original step cannot resolve its upstream target path.',
        grounding: 'The failing targetPath names a node that does not exist in the active graph.',
        tier: 'rebuild',
        resumeNodeId: 'A-rebuilt',
      } as SelfHealResult;
    });
    const runId = await runTo(engine, graphWithKeys(['location', 'budget']), completedOrFailed);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    expect((run.graphSnapshot as WorkflowGraph).nodes.some((node) => node.id === 'A-rebuilt')).toBe(true);
    expect((run.runState as { selfHealIncidents?: Record<string, { plans?: Array<{ tier?: string }> }> }).selfHealIncidents?.A?.plans?.[0]?.tier).toBe('rebuild');
  });

  it('blocks a repeated repair fingerprint instead of looping', async () => {
    setSelfHealConfig(ctx.db, ctx.workspace.id, { mode: 'bypass', maxRepairPlans: 3 });
    const engine = buildEngine(async (input) => {
      const graph = (input as { graph: WorkflowGraph }).graph;
      return {
        outcome: 'graph_repair',
        patchedGraph: graph,
        diagnosis: 'The same bad contract remains unresolved.',
        grounding: 'The real node output still has no declared fields.',
        tier: 'minimal_patch',
        resumeNodeId: 'A',
      } as SelfHealResult;
    });
    const runId = await runTo(engine, graphWithKeys(['location', 'budget']), completedOrFailed);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const incident = (run.runState as { selfHealIncidents?: Record<string, { status?: string; plans?: Array<{ fingerprint?: string }> }> }).selfHealIncidents?.A;
    // The repeated fingerprint is deduped to a single distinct plan and the node
    // then ADAPTS (typed-empty defaults + visible deviation) — no infinite
    // re-apply loop, no crash.
    expect(run.status).toBe('COMPLETED_WITH_CONTRACT_VIOLATION');
    expect(incident?.plans).toHaveLength(1);
  });

  function seedOrchestrator(): string {
    const orchestratorId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: orchestratorId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Orchy', adapterType: 'codex', capabilityTags: [], config: {}, status: 'online', role: 'orchestrator',
    }).run();
    return orchestratorId;
  }

  it('reroutes a runtime-blocked step to the orchestrator and proposes it for approval (default)', async () => {
    // The step's pinned agent has no runtime. Deterministic runtime repair must
    // re-route to the orchestrator (the default healer) WITHOUT spending an LLM
    // call. In approve mode that surfaces as a one-click approval.
    const orchestratorId = seedOrchestrator();
    let sawHeal = false;
    let resolvedOrchestrator = false;
    const engine = buildEngine(async () => {
      sawHeal = true; // the LLM heal path must NOT be reached for a runtime failure
      return { outcome: 'escalate', reason: 'should not be called', diagnosis: 'n/a' };
    }, {
      evaluatorRuntime: null,
      resolveAgentRuntime: (_workspaceId, agentId) => {
        if (agentId !== orchestratorId) return undefined; // the pinned agent can't bind
        resolvedOrchestrator = true;
        return chatCapableAdapter();
      },
    });

    const waitForApproval = (m: BusMessage) => {
      const payload = m.envelope.payload as { status?: string };
      return (m.envelope.event === REALTIME_EVENTS.RUN_RUNNING && payload.status === 'WAITING') || completedOrFailed(m);
    };
    await runTo(engine, graphWithPinnedMissingAdapter(), waitForApproval);

    expect(sawHeal).toBe(false);
    expect(resolvedOrchestrator).toBe(true);
    const pending = new ApprovalInboxService(ctx.db, ctx.bus).list(ctx.workspace.id, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.source).toBe('self_heal');
    const payload = pending[0]!.payload as { kind: string; nodeId: string; patch: { updateNodes: Array<{ id: string; config: { agentId?: string } }> } };
    expect(payload.kind).toBe('graph_patch');
    expect(payload.nodeId).toBe('A');
    expect(payload.patch.updateNodes.find((n) => n.id === 'A')?.config.agentId).toBe(orchestratorId);
  });

  it('runs the full-power replan through the same chat executor and returns a validated repair graph', async () => {
    setSelfHealConfig(ctx.db, ctx.workspace.id, { mode: 'bypass' });
    const orchestratorId = seedOrchestrator();
    const failingAgentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: failingAgentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      name: 'Digest writer', adapterType: 'claude_code', capabilityTags: [], config: {}, status: 'online', role: 'worker',
    }).run();
    const initialGraph = graphWithKeys(['location', 'budget']);
    const baseGraph = {
      ...initialGraph,
      nodes: initialGraph.nodes.map((node) => node.id === 'A'
        ? { ...node, config: { ...node.config, agentId: failingAgentId, useRoleTools: false, useSession: false } }
        : node),
    };
    const patchedNodes = baseGraph.nodes.map((node) => node.id === 'A'
      ? { ...node, type: 'return_output' as const, config: { kind: 'return_output' as const, renderAs: 'json' as const } }
      : node);
    const seenTools: string[][] = [];
    const adapter = selfHealChatAdapter({ nodes: patchedNodes, edges: baseGraph.edges, seenTools });
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registry.register(
      {
        id: 'agentis.workflow.patch',
        family: 'build',
        description: 'Patch a live workflow run.',
        inputSchema: { type: 'object', properties: {} },
        mutating: true,
      },
      async () => ({ patched: true }),
    );
    registry.register(
      {
        id: 'agentis.agents.create',
        family: 'build',
        description: 'Create an internal repair agent.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        mutating: true,
        autoExecute: true,
      },
      async () => ({ agentId: 'new-agent' }),
    );
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(orchestratorId, adapter);
    const engine = buildEngine(new WorkflowSelfHealService(ctx.logger), {
      adapters,
      evaluatorRuntime: null,
      toolRegistry: registry,
      resolveAgentRuntime: (_workspaceId, agentId) => {
        if (agentId === orchestratorId) return adapter;
        if (agentId === failingAgentId) return failingTaskAdapter();
        return undefined;
      },
    });

    const runId = await runTo(engine, baseGraph, completedOrFailed);

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    expect((run.graphSnapshot as WorkflowGraph).nodes.find((node) => node.id === 'A')?.config).toMatchObject({ kind: 'return_output' });
    expect(seenTools.some((tools) => tools.includes('agentis.agents.create'))).toBe(true);
    expect(seenTools.every((tools) => !tools.includes('agentis.workflow.patch'))).toBe(true);
    const state = run.runState as { selfHealIncidents?: Record<string, { status?: string }> };
    expect(state.selfHealIncidents?.A?.status).toBe('APPLIED');
  });

  it('adapts (typed-empty defaults + visible deviation) when self-heal cannot ground a repair — no blind re-run loop, no crash', async () => {
    // The real failure log: blindly re-running the same step burned minutes. The
    // orchestrator (the primary repair, inside heal()) already had its full turn,
    // so on escalation we stop and offer the operator the report path — we do NOT
    // loop the failed step.
    setSelfHealConfig(ctx.db, ctx.workspace.id, { maxRepairPlans: 1 });
    const engine = buildEngine(async () => ({
      outcome: 'escalate',
      reason: 'Could not derive a grounded repair for this failure.',
      diagnosis: 'The node did not produce its declared output keys.',
    }));
    const { events } = ctx.captureBus();
    const runId = await runTo(engine, graphWithKeys(['location', 'budget']), completedOrFailed);

    // No blind agent self-correction loop.
    const retried = events.some((m) =>
      m.envelope.event === REALTIME_EVENTS.NODE_RETRY_SCHEDULED
      && (m.envelope.payload as { reason?: string }).reason === 'self_heal_retry_with_repair_context');
    expect(retried).toBe(false);

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    // NEW CONTRACT: an agent that produced USABLE output but not its declared keys
    // ADAPTS (typed-empty defaults) and completes with a visible, honest deviation —
    // it does not crash the run. Honest hard-failure is reserved for a node that
    // produced NOTHING usable (covered by the reliability suite).
    expect(run.status).toBe('COMPLETED_WITH_CONTRACT_VIOLATION');
    const state = run.runState as { nodeStates: Record<string, { status?: string; contractDeviation?: { kind?: string; missingKeys?: string[] } }>; selfHealIncidents?: Record<string, { status?: string }> };
    expect(state.nodeStates.A?.status).toBe('COMPLETED');
    expect(state.nodeStates.A?.contractDeviation?.kind).toBe('missing_declared_output_keys');
    expect(state.nodeStates.A?.contractDeviation?.missingKeys).toEqual(expect.arrayContaining(['location', 'budget']));
    const status = state.selfHealIncidents?.A?.status;
    expect(['EXHAUSTED', 'BLOCKED']).toContain(status);
  });
});
