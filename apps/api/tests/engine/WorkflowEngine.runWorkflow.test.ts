/**
 * AGENT-AUTONOMY §W4 — workflow-as-tool: an in-task agent runs a SAVED workflow
 * as a subroutine and WAITS for its result. The parent session yields
 * run_workflow, the child workflow runs to completion (reusing SubflowExecutor),
 * and the parent resumes with the child's output to synthesize.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type SessionAdapter, type SessionStepResult, type WorkflowGraph } from '@agentis/core';
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
import { SubflowExecutor } from '../../src/services/subflowExecutor.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dataDir: string;

const fin = (text: string): SessionStepResult => ({ text, toolCalls: [], finishReason: 'stop' });

function adapter(childWorkflowId: string): SessionAdapter {
  return {
    id: 'wf-stub',
    async executeStep({ messages }): Promise<SessionStepResult> {
      const text = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' || ');
      // Parent's second turn: the run_workflow result (a tool message with the
      // child's output) has been injected → synthesize and finish.
      if (text.includes('child_marker')) return fin('parent-synth');
      return {                                                             // parent, first turn → run the workflow as a tool
        text: 'running the saved workflow',
        toolCalls: [{ id: 'tc1', name: 'run_workflow', arguments: { workflow_id: childWorkflowId, inputs: { child_marker: 'ok' } } }],
        finishReason: 'tool_calls',
      };
    },
  };
}

function buildEngine(a: SessionAdapter): WorkflowEngine {
  const volume = new WorkspaceVolumeService(dataDir);
  const agentTools = new AgentToolRuntime({ volume });
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const sessions = new AgentSessionService(ctx.db, ctx.logger);
  const sessionRuntime = new AgentSessionRuntime({ sessions, adapter: a, scratchpad, bus: ctx.bus, logger: ctx.logger, agentTools });
  const evaluatorRuntime = new EvaluatorRuntime({
    baseUrl: 'http://stub/v1', model: 'stub', logger: ctx.logger,
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
  });
  // One shared ledger — the engine and SubflowExecutor write to the same run's
  // ledger, so separate instances would collide on (run_id, sequence_number).
  const ledger = new LedgerService(ctx.db, ctx.bus);
  return new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger, scratchpad,
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    specialists: new SpecialistAgentService(ctx.db),
    agentTools, evaluatorRuntime,
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    sessions, sessionRuntime,
    subflows: new SubflowExecutor({ db: ctx.db, ledger, scratchpad }),
  });
}

function sessionWorkflow(title: string, prompt: string): WorkflowGraph {
  return {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'S', type: 'agent_session', title, position: { x: 200, y: 0 }, config: { kind: 'agent_session', agentRole: 'analyst', prompt, inputKeys: [], outputKeys: [], capabilityTags: [] } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'S' }],
  } as WorkflowGraph;
}

function saveWorkflow(graph: WorkflowGraph): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({ id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'wf', graph, settings: {} }).run();
  return id;
}

beforeEach(async () => { ctx = await createTestContext(); dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-wf-tool-')); });
afterEach(async () => { ctx.close(); await rm(dataDir, { recursive: true, force: true }); });

/** A trivial child workflow (trigger only) whose output echoes its inputs. */
function triggerOnlyWorkflow(): WorkflowGraph {
  return {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } }],
    edges: [],
  } as WorkflowGraph;
}

describe('WorkflowEngine — workflow-as-tool (W4)', () => {
  it('runs a saved workflow as a subroutine and resumes with its result', async () => {
    const childWfId = saveWorkflow(triggerOnlyWorkflow());
    const engine = buildEngine(adapter(childWfId));

    const parentGraph = sessionWorkflow('Parent', 'PARENT coordinate the work');
    const parentWfId = saveWorkflow(parentGraph);
    const runId = randomUUID();
    const initialState = buildInitialRunState({ runId, workflowId: parentWfId, graph: parentGraph, inputs: {} });
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id, status: 'CREATED', runState: initialState }).run();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
      const off = ctx.bus.subscribe((m) => {
        if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) { clearTimeout(timer); off(); resolve(); }
      });
      void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph: parentGraph });
    });

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    const state = run.runState as { nodeStates: Record<string, { outputData?: { result?: string } }> };
    expect(state.nodeStates.S?.outputData?.result).toBe('parent-synth');

    // A child run was spawned for the workflow-as-tool call.
    const childRuns = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.parentRunId, runId)).all();
    expect(childRuns.length).toBe(1);
    expect(childRuns[0]!.status).toBe('COMPLETED');
  });

  it('authors and persists a new workflow via build_workflow (W4)', async () => {
    const buildAdapter: SessionAdapter = {
      id: 'build-stub',
      async executeStep({ messages }): Promise<SessionStepResult> {
        const text = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' || ');
        if (text.includes('workflowId')) return fin('built-and-done');   // after wake with the new id
        return {
          text: 'authoring a reusable workflow',
          toolCalls: [{ id: 'b1', name: 'build_workflow', arguments: {
            title: 'Auto WF',
            graph: { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } }], edges: [] },
          } }],
          finishReason: 'tool_calls',
        };
      },
    };
    const engine = buildEngine(buildAdapter);
    const parentGraph = sessionWorkflow('Builder', 'BUILD coordinate the work');
    const parentWfId = saveWorkflow(parentGraph);
    const runId = randomUUID();
    const initialState = buildInitialRunState({ runId, workflowId: parentWfId, graph: parentGraph, inputs: {} });
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id, status: 'CREATED', runState: initialState }).run();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
      const off = ctx.bus.subscribe((m) => {
        if (m.room === `run:${runId}` && (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED)) { clearTimeout(timer); off(); resolve(); }
      });
      void engine.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: parentWfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph: parentGraph });
    });

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    const built = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.title, 'Auto WF')).all();
    expect(built.length).toBe(1);
  });
});
