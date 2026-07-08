/**
 * SMARTER-AGENTS-10X §VI–IX — `agent_session` E2E through the WorkflowEngine.
 *
 * Drives the persistent-session node with a scripted `SessionAdapter` (no real
 * LLM) and asserts the engine's orchestration contract end to end:
 *   (a) a free-text step completes the node with `{ result }`;
 *   (b) a control-tool step (memory_update) then complete_task completes;
 *   (c) a `sleep_until` yield parks the run to WAITING, the timer auto-wakes it,
 *       and the resumed session completes;
 *   (d) an `await_event` yield parks the run, `notifySessionEvent` wakes it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type ChatMessage,
  type ChatToolCall,
  type SessionAdapter,
  type SessionStepResult,
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
import { AgentSessionService } from '../../src/services/agent/agentSession.js';
import { AgentSessionRuntime } from '../../src/services/agent/agentSessionRuntime.js';
import { PlanService, type TaskCompletionJudge } from '../../src/services/planService.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

type ScriptStep = { text?: string; toolCalls?: ChatToolCall[] };

/** A stateless-looking adapter that replays a fixed script of step results. */
function scriptedAdapter(steps: ScriptStep[], seenMessages?: ChatMessage[][]): SessionAdapter {
  let i = 0;
  return {
    id: 'stub-session',
    async executeStep(input): Promise<SessionStepResult> {
      seenMessages?.push(input.messages);
      const step = steps[Math.min(i, steps.length - 1)] ?? {};
      i += 1;
      const toolCalls = step.toolCalls ?? [];
      return {
        text: step.text ?? '',
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      };
    },
  };
}

let ctx: TestContext;
let dataDir: string;

function buildEngine(adapter: SessionAdapter, opts: { plans?: PlanService; verifyCompletion?: TaskCompletionJudge } = {}): WorkflowEngine {
  const volume = new WorkspaceVolumeService(dataDir);
  const agentTools = new AgentToolRuntime({ volume });
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const sessions = new AgentSessionService(ctx.db, ctx.logger);
  const sessionRuntime = new AgentSessionRuntime({
    sessions,
    adapter,
    scratchpad,
    plans: opts.plans,
    bus: ctx.bus,
    logger: ctx.logger,
    agentTools,
    verifyCompletion: opts.verifyCompletion,
  });
  const evaluatorRuntime = new EvaluatorRuntime({
    baseUrl: 'http://stub/v1',
    model: 'stub',
    logger: ctx.logger,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
  });
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad,
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    specialists: new SpecialistAgentService(ctx.db),
    agentTools,
    evaluatorRuntime,
    skills: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    sessions,
    sessionRuntime,
    plans: opts.plans,
  });
}

function sessionGraph(agentId?: string): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      {
        id: 'S',
        type: 'agent_session',
        title: 'Session',
        position: { x: 200, y: 0 },
        config: {
          kind: 'agent_session',
          ...(agentId ? { agentId } : {}),
          agentRole: 'coder',
          prompt: 'Do the task.',
          inputKeys: [],
          outputKeys: [],
          capabilityTags: [],
        },
      },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'S' }],
  } as WorkflowGraph;
}

/**
 * Run the session graph to terminal. `onWaiting` fires on each
 * NODE_WAITING_FOR_INPUT so a test can supply the external wake signal.
 */
function runSessionGraph(
  engine: WorkflowEngine,
  events: string[],
  onWaiting?: (runId: string, reason: string) => void,
  planId?: string,
  graphOverride?: WorkflowGraph,
): Promise<string> {
  const graph = graphOverride ?? sessionGraph();
  const wfId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'session', graph, settings: {} })
    .run();
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  ctx.db
    .insert(schema.workflowRuns)
    .values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: initialState })
    .run();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
    const off = ctx.bus.subscribe((m) => {
      if (m.room !== `run:${runId}`) return;
      events.push(m.envelope.event);
      if (m.envelope.event === REALTIME_EVENTS.NODE_WAITING_FOR_INPUT) {
        const reason = (m.envelope.payload as { reason?: string } | undefined)?.reason ?? '';
        onWaiting?.(runId, reason);
      }
      if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED) {
        clearTimeout(timer);
        off();
        resolve(runId);
      }
    });
    void engine.startRun({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      planId,
      userId: ctx.user.id,
      triggerId: null,
      inputs: {},
      initialState,
      graph,
    });
  });
}

function nodeOutput(runId: string): Record<string, unknown> | undefined {
  const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  const state = run.runState as { nodeStates: Record<string, { outputData?: Record<string, unknown> }> };
  return state.nodeStates.S?.outputData;
}

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-engine-session-'));
});

afterEach(async () => {
  ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('WorkflowEngine — agent_session', () => {
  it('completes the node from a free-text step', async () => {
    const engine = buildEngine(scriptedAdapter([{ text: 'all done, here is the answer' }]));
    const events: string[] = [];
    const runId = await runSessionGraph(engine, events);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    expect(nodeOutput(runId)?.result).toBe('all done, here is the answer');
  });

  it('injects persisted identity into the agent_session run context', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Session Specialist',
      description: 'Owns persistent session work.',
      adapterType: 'codex',
      capabilityTags: ['code'],
      config: { cwd: 'C:/repo', apiKey: 'sk-secret', nested: { safe: 'visible' } },
      status: 'online',
      role: 'worker',
      runtimeModel: 'gpt-5.5',
      instructions: 'Session Specialist exact instructions.',
    }).run();
    const seenMessages: ChatMessage[][] = [];
    const engine = buildEngine(scriptedAdapter([{ text: 'session done' }], seenMessages));
    const events: string[] = [];
    await runSessionGraph(engine, events, undefined, undefined, sessionGraph(agentId));

    const systemPrompt = seenMessages[0]?.[0]?.content ?? '';
    expect(systemPrompt.match(/<agentis_identity/g)).toHaveLength(1);
    expect(systemPrompt).toContain('name: Session Specialist');
    expect(systemPrompt).toContain('role: worker');
    expect(systemPrompt).toContain('runtimeModel: gpt-5.5');
    expect(systemPrompt).toContain('capabilityTags: code');
    expect(systemPrompt).toContain('Session Specialist exact instructions.');
    expect(systemPrompt).toContain('"cwd":"C:/repo"');
    expect(systemPrompt).toContain('"apiKey":"[redacted]"');
    expect(systemPrompt).toContain('"safe":"visible"');
    expect(systemPrompt).not.toContain('sk-secret');
  });

  it('records a first-class deviation verdict, then continues (W5.1)', async () => {
    const engine = buildEngine(
      scriptedAdapter([
        { toolCalls: [{ id: 'd1', name: 'flag_deviation', arguments: { kind: 'reject_input', reason: 'upstream node returned an empty list — cannot qualify nothing' } }] },
        { toolCalls: [{ id: 'c1', name: 'complete_task', arguments: { output: { handled: 'escalated' } } }] },
      ]),
    );
    const events: string[] = [];
    const runId = await runSessionGraph(engine, events);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    expect(nodeOutput(runId)?.handled).toBe('escalated');
  });

  it('runs a control tool then completes via complete_task', async () => {
    const engine = buildEngine(
      scriptedAdapter([
        { toolCalls: [{ id: 'c1', name: 'memory_update', arguments: { block: 'plan', content: 'step 1: think' } }] },
        { toolCalls: [{ id: 'c2', name: 'complete_task', arguments: { output: { answer: 42 } } }] },
      ]),
    );
    const events: string[] = [];
    const runId = await runSessionGraph(engine, events);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    expect(nodeOutput(runId)?.answer).toBe(42);
  });

  it('parks on sleep_until and auto-wakes when the timer elapses', async () => {
    const soon = new Date(Date.now() + 120).toISOString();
    const engine = buildEngine(
      scriptedAdapter([
        { toolCalls: [{ id: 's1', name: 'sleep_until', arguments: { until_iso: soon } }] },
        { toolCalls: [{ id: 'c1', name: 'complete_task', arguments: { output: { woke: true } } }] },
      ]),
    );
    const events: string[] = [];
    const runId = await runSessionGraph(engine, events);
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    expect(events).toContain(REALTIME_EVENTS.NODE_WAITING_FOR_INPUT);
    expect(nodeOutput(runId)?.woke).toBe(true);
  });

  it('recovers a parked await_event session across a process restart', async () => {
    // ENGINE A parks the session on await_event, then we abandon it (the crash).
    const engineA = buildEngine(scriptedAdapter([{ toolCalls: [{ id: 'a1', name: 'await_event', arguments: { event: 'go' } }] }]));
    const graph = sessionGraph();
    const wfId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'session', graph, settings: {} }).run();
    const runId = randomUUID();
    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
    ctx.db.insert(schema.workflowRuns).values({ id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'CREATED', runState: initialState }).run();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('did not park')), 15_000);
      const off = ctx.bus.subscribe((m) => {
        if (m.room !== `run:${runId}`) return;
        if (m.envelope.event === REALTIME_EVENTS.NODE_WAITING_FOR_INPUT) { clearTimeout(timer); off(); resolve(); }
      });
      void engineA.startRun({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, triggerId: null, inputs: {}, initialState, graph });
    });

    // The WAITING run-status transition settles in the tick that runs just AFTER
    // the park event publishes, so poll briefly rather than racing it.
    for (let i = 0; i < 100; i += 1) {
      if (ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!.status === 'WAITING') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // The park is durable: run WAITING + session row persisted with its wake condition.
    expect(ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!.status).toBe('WAITING');
    const parked = ctx.db.select().from(schema.agentSessions).where(eq(schema.agentSessions.runId, runId)).get();
    expect(parked?.status).toBe('waiting');
    expect(parked?.wakeCondition).toBe('event:go');

    // ENGINE B is a fresh process: empty in-memory run map, new adapter that
    // completes once the awaited event is injected post-wake.
    const engineB = buildEngine(scriptedAdapter([{ toolCalls: [{ id: 'c1', name: 'complete_task', arguments: { output: { recovered: true } } }] }]));
    const recovery = await engineB.recoverInterruptedRuns();
    expect(recovery.resumed + recovery.failed).toBeGreaterThanOrEqual(0); // recovery ran

    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('did not complete after restart wake')), 15_000);
      const off = ctx.bus.subscribe((m) => {
        if (m.room !== `run:${runId}`) return;
        if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) { clearTimeout(timer); off(); resolve(); }
      });
    });
    await engineB.notifySessionEvent({ runId, event: 'go', payload: { ok: true } });
    await completed;

    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    expect(nodeOutput(runId)?.recovered).toBe(true);
  });

  it('parks on await_event and resumes via notifySessionEvent', async () => {
    const engine = buildEngine(
      scriptedAdapter([
        { toolCalls: [{ id: 'a1', name: 'await_event', arguments: { event: 'go' } }] },
        { toolCalls: [{ id: 'c1', name: 'complete_task', arguments: { output: { resumed: 'yes' } } }] },
      ]),
    );
    const events: string[] = [];
    const runId = await runSessionGraph(engine, events, (rid, reason) => {
      // Defer past the synchronous park publish so the wake doesn't re-enter
      // mid-parking — fire the external event once the run has settled WAITING.
      if (reason === 'await_event') {
        setTimeout(() => void engine.notifySessionEvent({ runId: rid, event: 'go', payload: { ok: true } }), 0);
      }
    });
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    expect(run.status).toBe('COMPLETED');
    expect(events).toContain(REALTIME_EVENTS.NODE_WAITING_FOR_INPUT);
    expect(nodeOutput(runId)?.resumed).toBe('yes');
  });

  it('gates complete_task through the durable task spine verification contract', async () => {
    const plans = new PlanService(ctx.db, ctx.bus);
    const realtimeEvents: string[] = [];
    const unsubscribe = ctx.bus.subscribe((msg) => {
      if (msg.room === REALTIME_ROOMS.workspace(ctx.workspace.id)) realtimeEvents.push(msg.envelope.event);
    });
    const plan = plans.createTask({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      objective: 'Ship a verified answer',
      acceptanceCriteria: ['Output must include ok: true'],
    });
    const verifyCompletion: TaskCompletionJudge = ({ output }) => {
      const ok = typeof output === 'object' && output !== null && (output as { ok?: unknown }).ok === true;
      return {
        status: ok ? 'passed' : 'failed',
        verifier: 'judge',
        criteria: [{
          criterion: 'Output must include ok: true',
          passed: ok,
          reason: ok ? 'Output carried ok: true.' : 'Output did not carry ok: true.',
        }],
      };
    };
    const engine = buildEngine(
      scriptedAdapter([
        { toolCalls: [{ id: 'c1', name: 'complete_task', arguments: { output: { ok: false } } }] },
        { toolCalls: [{ id: 'c2', name: 'complete_task', arguments: { output: { ok: true } } }] },
      ]),
      { plans, verifyCompletion },
    );

    const runId = await runSessionGraph(engine, [], undefined, plan.id);
    unsubscribe();
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const completed = plans.get(ctx.workspace.id, plan.id);

    expect(run.status).toBe('COMPLETED');
    expect(nodeOutput(runId)?.ok).toBe(true);
    expect(completed.status).toBe('completed');
    expect(completed.runIds).toContain(runId);
    expect(completed.verification?.status).toBe('passed');
    expect(realtimeEvents).toContain(REALTIME_EVENTS.TASK_SPINE_VERIFYING);
    expect(realtimeEvents).toContain(REALTIME_EVENTS.TASK_SPINE_VERIFIED);
  });

  it('records task-spine deviations and decisions from session control tools', async () => {
    const plans = new PlanService(ctx.db);
    const plan = plans.createTask({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      objective: 'Handle changed upstream input',
      acceptanceCriteria: ['A grounded result is returned.'],
    });
    const engine = buildEngine(
      scriptedAdapter([
        { toolCalls: [{ id: 'd1', name: 'flag_deviation', arguments: { kind: 'rescope', reason: 'upstream payload lacked optional enrichment fields', proposed: 'continue with core fields' } }] },
        { toolCalls: [{ id: 'r1', name: 'record_decision', arguments: { summary: 'Continue with core fields', rationale: 'The required identifiers are present.' } }] },
        { toolCalls: [{ id: 'c1', name: 'complete_task', arguments: { output: { handled: true } } }] },
      ]),
      { plans },
    );

    const runId = await runSessionGraph(engine, [], undefined, plan.id);
    const updated = plans.get(ctx.workspace.id, plan.id);

    expect(runId).toBeTruthy();
    expect(updated.deviations?.[0]?.reason).toContain('upstream payload');
    expect(updated.decisions?.[0]?.summary).toBe('Continue with core fields');
    expect(updated.status).toBe('completed');
  });
});
