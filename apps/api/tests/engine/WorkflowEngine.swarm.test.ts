/**
 * WorkflowEngine — agent_swarm first_success sibling cancellation.
 *
 * When a `first_success` swarm gets its first winning subtask, the engine must
 * settle the node AND cancel every still-in-flight sibling (stop wasted work +
 * cost) rather than orphaning them. This drives a real swarm through the engine
 * with a mock adapter and asserts the losing siblings are cancelled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  REALTIME_EVENTS,
  type AgentAdapter,
  type AdapterCapabilities,
  type AdapterHealthStatus,
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
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

/** A no-op adapter that records dispatched + cancelled task ids. Never auto-completes. */
class RecordingAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  readonly dispatched: string[] = [];
  readonly cancelled: string[] = [];
  #handler: ((e: NormalizedAgentEvent) => void) | null = null;
  constructor(private readonly maxConcurrent?: number) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: false,
      toolCalling: false,
      toolForwarding: 'none',
      ...(this.maxConcurrent ? { execution: { maxConcurrent: this.maxConcurrent } } : {}),
    };
  }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    this.dispatched.push(task.taskId);
  }
  async cancelTask(taskId: string): Promise<void> {
    this.cancelled.push(taskId);
  }
  onEvent(handler: (e: NormalizedAgentEvent) => void): void {
    this.#handler = handler;
  }
}

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

function waitForRunStatus(runId: string, target: 'COMPLETED' | 'FAILED'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const evt = target === 'COMPLETED' ? REALTIME_EVENTS.RUN_COMPLETED : REALTIME_EVENTS.RUN_FAILED;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${target}`)), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room === `run:${runId}` && m.envelope.event === evt) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

/** Build a single-swarm workflow, seed it, register the adapter, and start the run. */
async function startSwarm(opts: {
  adapter: RecordingAdapter;
  mergeStrategy: 'collect_all' | 'first_success' | 'majority_vote';
  maxParallel: number;
  items: unknown[];
}): Promise<{ engine: WorkflowEngine; runId: string }> {
  const agentId = randomUUID();
  const adapters = new AdapterManager(ctx.logger);
  adapters.register(agentId, opts.adapter);

  const graph: WorkflowGraph = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      {
        id: 'SW',
        type: 'agent_swarm',
        title: 'swarm',
        position: { x: 100, y: 0 },
        config: {
          kind: 'agent_swarm',
          prompt: 'do the thing',
          inputArrayPath: 'items',
          maxParallel: opts.maxParallel,
          mergeStrategy: opts.mergeStrategy,
          capabilityTags: [],
          agentId,
          outputKey: 'results',
        },
      },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'SW' }],
  };

  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'swarm-wf', graph, settings: {},
  }).run();
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: {},
  }).run();

  const engine = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters,
  });

  const inputs = { items: opts.items };
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs });
  await engine.startRun({
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: wfId,
    userId: ctx.user.id,
    triggerId: null,
    inputs,
    initialState,
    graph,
  });
  return { engine, runId };
}

describe('WorkflowEngine — agent_swarm', () => {
  it('cancels in-flight siblings once one subtask wins (first_success)', async () => {
    const adapter = new RecordingAdapter();
    const { engine, runId } = await startSwarm({ adapter, mergeStrategy: 'first_success', maxParallel: 3, items: ['a', 'b', 'c'] });

    // All three subtasks dispatch (maxParallel = 3) and stay in flight (the mock
    // never auto-completes).
    await vi.waitFor(() => expect(adapter.dispatched.length).toBe(3), { timeout: 10_000 });
    expect(adapter.cancelled).toEqual([]);

    // Subtask 0 wins → node settles, siblings 1 & 2 must be cancelled.
    const done = waitForRunStatus(runId, 'COMPLETED');
    await engine.notifyTaskCompleted({ runId, nodeId: 'SW::swarm::0', output: { ok: true } });
    await done;

    expect(adapter.cancelled.sort()).toEqual(['SW::swarm::1', 'SW::swarm::2']);
  });

  it('clamps parallelism to the adapter maxConcurrent', async () => {
    // The adapter declares it can run only ONE task at a time. Even though the
    // node asks for maxParallel 3, the pool must dispatch one and refill as each
    // completes — never 3 concurrent processes against a 1-concurrency runtime.
    const adapter = new RecordingAdapter(1);
    const { engine, runId } = await startSwarm({ adapter, mergeStrategy: 'collect_all', maxParallel: 3, items: ['a', 'b', 'c'] });

    await vi.waitFor(() => expect(adapter.dispatched.length).toBe(1), { timeout: 10_000 });
    // Completing the in-flight one frees the single slot for the next.
    await engine.notifyTaskCompleted({ runId, nodeId: 'SW::swarm::0', output: { ok: true } });
    await vi.waitFor(() => expect(adapter.dispatched.length).toBe(2), { timeout: 10_000 });

    const done = waitForRunStatus(runId, 'COMPLETED');
    await engine.notifyTaskCompleted({ runId, nodeId: 'SW::swarm::1', output: { ok: true } });
    await engine.notifyTaskCompleted({ runId, nodeId: 'SW::swarm::2', output: { ok: true } });
    await done;
    // At no point were more than the allowed number dispatched ahead of completions.
    expect(adapter.dispatched.length).toBe(3);
  });
});
