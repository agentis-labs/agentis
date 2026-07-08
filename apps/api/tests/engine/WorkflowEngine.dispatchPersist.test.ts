/**
 * PAVED-ROAD follow-up — dispatch-transition persistence.
 *
 * Root cause of the "workflow runtime dispatcher drain issue" misdiagnosis:
 * #dispatchAgentTask moved a node readyQueue → activeExecutions IN MEMORY but
 * never persisted, so for the node's whole (minutes-long) execution the DB row
 * still showed it queued with activeExecutions:{}. External observers
 * (run.status / check_run / the UI / another agent) read a phantom stalled
 * dispatcher — and one agent cancelled a healthy run over it.
 *
 * This fence: while an agent node is IN FLIGHT, the PERSISTED runState must
 * show it under activeExecutions (with startedAt) and not in readyQueue.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  type AdapterCapabilities,
  type AdapterType,
  type AgentAdapter,
  type NormalizedAgentEvent,
  type NormalizedTask,
  type WorkflowGraph,
  type WorkflowRunState,
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

/** Adapter that HOLDS the task in flight until the test releases it. */
class SlowAdapter implements AgentAdapter {
  readonly adapterType: AdapterType = 'http';
  readonly tasks: NormalizedTask[] = [];
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  #dispatched: (() => void) | null = null;
  /** Resolves when dispatchTask has been called (the node is in flight). */
  readonly dispatchedOnce = new Promise<void>((r) => { this.#dispatched = r; });

  constructor(private readonly agentId: string) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck() {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities {
    return { interactiveChat: true, toolCalling: true, toolForwarding: 'marker_protocol' };
  }
  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }
  async dispatchTask(task: NormalizedTask): Promise<void> {
    this.tasks.push(task);
    this.#dispatched?.();
    // Return without completing — the task stays in flight until finish().
  }
  /** Emit the completion event, ending the held task. */
  finish(): void {
    const task = this.tasks[0]!;
    for (const handler of this.#handlers) {
      handler({
        eventType: 'task.completed',
        agentId: this.agentId,
        taskId: task.taskId,
        runId: task.runId,
        workflowId: task.workflowId,
        output: { done: true },
        timestamp: new Date().toISOString(),
      });
    }
  }
  async cancelTask(): Promise<void> {}
}

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

function buildEngine(adapters: AdapterManager): WorkflowEngine {
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
  adapters.onEvent((event) => {
    if (event.eventType === 'task.completed') {
      void engine.notifyTaskCompleted({ runId: event.runId, nodeId: event.taskId, output: event.output });
    }
  });
  return engine;
}

describe('WorkflowEngine — dispatch-transition persistence', () => {
  it('persists an in-flight agent node under activeExecutions (not readyQueue) so observers never see a phantom stall', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Slow specialist',
      adapterType: 'http',
      capabilityTags: [],
      config: {},
      status: 'online',
    }).run();
    const adapters = new AdapterManager(ctx.logger);
    const adapter = new SlowAdapter(agentId);
    adapters.register(agentId, adapter);
    const engine = buildEngine(adapters);

    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'A',
          type: 'agent_task',
          title: 'ICP auditor',
          position: { x: 200, y: 0 },
          config: { kind: 'agent_task', agentId, prompt: 'Audit the ICP.', inputKeys: [], outputKeys: [], capabilityTags: [] },
        },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'A' }],
    } as WorkflowGraph;

    const wfId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      title: 'dispatch persist', graph, settings: {},
    }).run();
    const runId = randomUUID();
    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
    ctx.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
      userId: ctx.user.id, status: 'CREATED', runState: initialState,
    }).run();

    const terminal = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('run did not finish')), 15_000);
      ctx.bus.subscribe((m) => {
        if (m.room === `run:${runId}` && m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    await engine.startRun({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id,
      triggerId: null, inputs: {}, initialState, graph,
    });

    // Wait until the adapter actually holds the task (node in flight)…
    await adapter.dispatchedOnce;
    // …then read the PERSISTED state fresh from the DB, exactly like an
    // external observer (run.status / check_run / the UI) does.
    const midRun = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const persisted = midRun.runState as WorkflowRunState;
    expect(persisted.activeExecutions['A']).toBeDefined();
    expect(persisted.activeExecutions['A']?.startedAt).toBeTruthy();
    expect((persisted.readyQueue ?? []).map((i) => i.nodeId)).not.toContain('A');

    // Release the held task and let the run complete normally — the added
    // dispatch persist must not double-dispatch or wedge the pump.
    adapter.finish();
    await terminal;
    const final = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(final.status).toBe('COMPLETED');
  });
});
