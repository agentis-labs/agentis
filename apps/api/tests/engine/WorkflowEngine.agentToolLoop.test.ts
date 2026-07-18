/**
 * §2.2 — agent_task `useRoleTools` runs the in-process agentic tool-use loop
 * (no external adapter). The loop writes a file via the role-scoped runtime and
 * the node completes synchronously with the loop's output.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  type AdapterCapabilities,
  type AdapterType,
  type AgentAdapter,
  type NormalizedAgentEvent,
  type NormalizedTask,
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
import { WorkspaceVolumeService } from '../../src/services/workspace/workspaceVolume.js';
import { AgentToolRuntime } from '../../src/services/agent/agentToolRuntime.js';
import { EvaluatorRuntime } from '../../src/services/evaluatorRuntime.js';
import { SpecialistAgentService } from '../../src/services/specialist/specialistAgents.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { BusMessage } from '../../src/event-bus.js';

let ctx: TestContext;
let engine: WorkflowEngine;
let dataDir: string;

/** Scripted chat-completions fetch: write_file, then final. */
function scriptedFetch(decisions: Array<Record<string, unknown>>): typeof fetch {
  let i = 0;
  return (async () => {
    const decision = decisions[Math.min(i, decisions.length - 1)];
    i += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function quotaErrorFetch(): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify({
      error: {
        message: 'You exceeded your current quota. Please check your plan and billing details.',
      },
    }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

class CapturingAgenticAdapter implements AgentAdapter {
  readonly adapterType: AdapterType = 'codex';
  readonly tasks: NormalizedTask[] = [];
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();

  constructor(private readonly agentId: string) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck() {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'marker_protocol',
      affordances: { fileSystem: true, terminal: true },
    };
  }
  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    this.tasks.push(task);
    queueMicrotask(() => {
      for (const handler of this.#handlers) {
        handler({
          eventType: 'task.completed',
          agentId: this.agentId,
          taskId: task.taskId,
          runId: task.runId,
          workflowId: task.workflowId,
          output: { routedTo: this.agentId },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }
  async cancelTask(): Promise<void> {}
}

function buildEngine(fetchImpl: typeof fetch, adapters = new AdapterManager(ctx.logger)): WorkflowEngine {
  const volume = new WorkspaceVolumeService(dataDir);
  const evaluatorRuntime = new EvaluatorRuntime({
    baseUrl: 'http://stub/v1',
    model: 'stub',
    logger: ctx.logger,
    fetchImpl,
  });
  const created = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    specialists: new SpecialistAgentService(ctx.db),
    agentTools: new AgentToolRuntime({ volume }),
    evaluatorRuntime,
    extensions: {} as unknown as ExtensionRuntime,
    adapters,
  });
  adapters.onEvent((event) => {
    if (event.eventType === 'task.completed') {
      void created.notifyTaskCompleted({ runId: event.runId, nodeId: event.taskId, output: event.output });
    } else if (event.eventType === 'task.failed') {
      void created.notifyTaskFailed({ runId: event.runId, nodeId: event.taskId, error: event.error });
    }
  });
  return created;
}

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-engine-loop-'));
  engine = buildEngine(scriptedFetch([
    { thought: 'write the result', action: 'tool', tool: 'write_file', args: { path: 'out/result.txt', content: 'hello from loop' } },
    { thought: 'done', action: 'final', output: 'Wrote out/result.txt' },
  ]));
});

afterEach(async () => {
  ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

function runGraph(
  graph: WorkflowGraph,
  events: string[],
  isTerminal: (message: BusMessage) => boolean = (message) => {
    return message.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || message.envelope.event === REALTIME_EVENTS.RUN_FAILED;
  },
): Promise<string> {
  const wfId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'loop', graph, settings: {},
  }).run();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
    userId: ctx.user.id, status: 'CREATED', runState: initialState,
  }).run();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}`) {
        events.push(m.envelope.event);
        if (isTerminal(m)) {
          clearTimeout(timer); off(); resolve(runId);
        }
      }
    });
    void engine.startRun({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id,
      triggerId: null, inputs: {}, initialState, graph,
    });
  });
}

describe('WorkflowEngine — agent_task agentic-by-default', () => {
  it('runs the tool loop in-process and completes the node with its output', async () => {
    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Coder', position: { x: 200, y: 0 }, config: {
          kind: 'agent_task', agentRole: 'coder', useRoleTools: true, capabilityTags: [],
          prompt: 'Write the result file.', inputKeys: [], outputKeys: [],
        } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'A' }],
    } as WorkflowGraph;

    const events: string[] = [];
    const runId = await runGraph(graph, events);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    const state = run.runState as { nodeStates: Record<string, { outputData?: { output?: string } }> };
    expect(state.nodeStates.A?.outputData?.output).toMatch(/Wrote out\/result\.txt/);
  });

  it('runs the tool loop for a PLAIN agent_task (no useRoleTools) — agentic is the default', async () => {
    // WITHOUT useRoleTools and with built-in role manifests retired, the agent
    // still ACTS via the universal floor (run_code) instead of a single
    // fire-and-forget completion — agentic execution is the default.
    engine = buildEngine(scriptedFetch([
      { thought: 'compute the result', action: 'tool', tool: 'run_code', args: { expression: '40 + 2' } },
      { thought: 'done', action: 'final', output: 'Computed the result: 42.' },
    ]));
    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Analyst', position: { x: 200, y: 0 }, config: {
          kind: 'agent_task', agentRole: 'analyst', capabilityTags: [],
          prompt: 'Compute the result.', inputKeys: [], outputKeys: [],
        } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'A' }],
    } as WorkflowGraph;

    const events: string[] = [];
    const runId = await runGraph(graph, events);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    const state = run.runState as { nodeStates: Record<string, { outputData?: { output?: string; toolCalls?: number } }> };
    expect(state.nodeStates.A?.outputData?.output).toMatch(/42/);
    expect(state.nodeStates.A?.outputData?.toolCalls).toBe(1);
  });

  it('gives a CUSTOM specialist role the default toolbox (tool-using, not single-shot)', async () => {
    // A custom role has no platform tool manifest — Gap-fix A grants it the
    // universal default toolbox (incl. run_code), so it can actually act.
    engine = buildEngine(scriptedFetch([
      { thought: 'compute', action: 'tool', tool: 'run_code', args: { expression: '2 + 2' } },
      { thought: 'done', action: 'final', output: 'The answer is 4.' },
    ]));
    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Tax Analyst', position: { x: 200, y: 0 }, config: {
          kind: 'agent_task', agentRole: 'tax_analyst', capabilityTags: [],
          prompt: 'Compute the figure.', inputKeys: [], outputKeys: [],
        } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'A' }],
    } as WorkflowGraph;

    const events: string[] = [];
    const runId = await runGraph(graph, events);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    const state = run.runState as { nodeStates: Record<string, { outputData?: { output?: string; toolCalls?: number } }> };
    expect(state.nodeStates.A?.outputData?.output).toMatch(/answer is 4/i);
    expect(state.nodeStates.A?.outputData?.toolCalls).toBe(1); // the custom role actually called a tool
  });

  it('defers to an agentic adapter instead of replacing its harness loop', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Codex Coder',
      role: 'coder',
      adapterType: 'codex',
      capabilityTags: ['code'],
      config: {},
      status: 'online',
    }).run();
    const adapters = new AdapterManager(ctx.logger);
    const adapter = new CapturingAgenticAdapter(agentId);
    adapters.register(agentId, adapter);
    engine = buildEngine(scriptedFetch([
      { thought: 'this would prove the platform loop stole the task', action: 'tool', tool: 'write_file', args: { path: 'stolen.txt', content: 'wrong path' } },
      { thought: 'wrong', action: 'final', output: 'wrong executor' },
    ]), adapters);

    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Coder', position: { x: 200, y: 0 }, config: {
          kind: 'agent_task', agentId, agentRole: 'coder', capabilityTags: ['code'],
          prompt: 'Use the configured harness.', inputKeys: [], outputKeys: [],
        } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'A' }],
    } as WorkflowGraph;

    const events: string[] = [];
    const runId = await runGraph(graph, events);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    expect(adapter.tasks).toHaveLength(1);
    const state = run.runState as { nodeStates: Record<string, { outputData?: { routedTo?: string; toolCalls?: number } }> };
    expect(state.nodeStates.A?.outputData?.routedTo).toBe(agentId);
    expect(state.nodeStates.A?.outputData?.toolCalls).toBeUndefined();
  });

  it('pauses instead of failing or fake-running when the model account has no credits', async () => {
    engine = buildEngine(quotaErrorFetch());
    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Coder', position: { x: 200, y: 0 }, config: {
          kind: 'agent_task', agentRole: 'coder', useRoleTools: true, capabilityTags: [],
          prompt: 'Write the result file.', inputKeys: [], outputKeys: [],
        } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'A' }],
    } as WorkflowGraph;

    const events: string[] = [];
    // The settle signal is RUN_PAUSED, not RUN_RUNNING. A run parked on a
    // recoverable blocker used to fall through to RUN_RUNNING (WAITING had no
    // branch in the event mapping), so it announced "running" and then went
    // permanently silent — indistinguishable from a freeze to an operator
    // watching the canvas. This test previously asserted that lie.
    const pausedPayloads: Array<Record<string, unknown>> = [];
    const offPaused = ctx.bus.subscribe((m) => {
      if (m.envelope.event === REALTIME_EVENTS.RUN_PAUSED) pausedPayloads.push(m.envelope.payload as Record<string, unknown>);
    });
    const runId = await runGraph(graph, events, (message) => {
      const payload = message.envelope.payload as { status?: string };
      return message.envelope.event === REALTIME_EVENTS.RUN_PAUSED && payload.status === 'WAITING';
    });
    offPaused();
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('WAITING');
    const state = run.runState as {
      nodeStates: Record<string, { status?: string; blockedReason?: string }>;
      failedNodeIds: string[];
    };
    expect(state.nodeStates.A?.status).toBe('WAITING');
    expect(state.nodeStates.A?.blockedReason).toMatch(/credits|billing/i);
    expect(state.failedNodeIds).toEqual([]);
    expect(events).toContain(REALTIME_EVENTS.NODE_WAITING_FOR_INPUT);
    // The run-level signal must say PAUSED and carry WHY, so the operator sees
    // "out of credits" rather than a bare status change (or nothing at all).
    expect(events).toContain(REALTIME_EVENTS.RUN_PAUSED);
    expect(events).not.toContain(REALTIME_EVENTS.RUN_FAILED);
    expect(pausedPayloads.length).toBeGreaterThan(0);
    expect(String(pausedPayloads[0]!.blockedReason)).toMatch(/credits|billing/i);
  });

  it('accepts a final output object and satisfies declared agent output keys', async () => {
    engine = buildEngine(scriptedFetch([
      {
        thought: 'done',
        action: 'final',
        output: {
          subject: 'Digest',
          htmlBody: '<p>Ready.</p>',
          topStories: [],
          sentStoryKeys: [],
          sentCount: 0,
        },
      },
    ]));
    const graph: WorkflowGraph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Analyst', position: { x: 200, y: 0 }, config: {
          kind: 'agent_task', agentRole: 'analyst', capabilityTags: [],
          prompt: 'Return a digest object.', inputKeys: [], outputKeys: ['subject', 'htmlBody', 'topStories', 'sentStoryKeys', 'sentCount'],
        } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'A' }],
    } as WorkflowGraph;

    const events: string[] = [];
    const runId = await runGraph(graph, events);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    const state = run.runState as {
      nodeStates: Record<string, {
        outputData?: {
          output?: unknown;
          subject?: string;
          htmlBody?: string;
          topStories?: unknown[];
          sentStoryKeys?: string[];
          sentCount?: number;
        };
        contractDeviation?: unknown;
      }>;
    };
    expect(state.nodeStates.A?.contractDeviation).toBeUndefined();
    expect(state.nodeStates.A?.outputData).toMatchObject({
      output: {
        subject: 'Digest',
        htmlBody: '<p>Ready.</p>',
        topStories: [],
        sentStoryKeys: [],
        sentCount: 0,
      },
      subject: 'Digest',
      htmlBody: '<p>Ready.</p>',
      topStories: [],
      sentStoryKeys: [],
      sentCount: 0,
    });
  });
});
