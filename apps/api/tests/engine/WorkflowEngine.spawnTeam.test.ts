/**
 * AGENT-AUTONOMY §W3 — spawn_team: an agent spawns a TEAM of specialists in
 * PARALLEL, awaits all, and synthesizes. Driven by a content-aware session
 * adapter (no real LLM): the parent yields spawn_team, two researcher children
 * run concurrently, and the parent resumes with the team payload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type SessionAdapter, type SessionStepResult, type WorkflowGraph } from '@agentis/core';
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
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dataDir: string;

const fin = (text: string): SessionStepResult => ({ text, toolCalls: [], finishReason: 'stop' });

/** Routes by message content so parent + concurrent children are deterministic. */
function teamAdapter(): SessionAdapter {
  return {
    id: 'team-stub',
    async executeStep({ messages }): Promise<SessionStepResult> {
      const text = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' || ');
      if (text.includes('"team"')) return fin('synthesized');            // parent, after the team payload is injected
      if (text.includes('RESEARCH_A')) return fin('A: found alpha');      // child A
      if (text.includes('RESEARCH_B')) return fin('B: found beta');       // child B
      return {                                                            // parent, first turn → spawn the team
        text: 'spawning a research team',
        toolCalls: [{ id: 'tc1', name: 'spawn_team', arguments: { tasks: [
          { role: 'researcher', task: 'RESEARCH_A market alpha', create_if_missing: true },
          { role: 'researcher', task: 'RESEARCH_B market beta', create_if_missing: true },
        ] } }],
        finishReason: 'tool_calls',
      };
    },
  };
}

function buildEngine(adapter: SessionAdapter): WorkflowEngine {
  const volume = new WorkspaceVolumeService(dataDir);
  const agentTools = new AgentToolRuntime({ volume });
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const sessions = new AgentSessionService(ctx.db, ctx.logger);
  const sessionRuntime = new AgentSessionRuntime({ sessions, adapter, scratchpad, bus: ctx.bus, logger: ctx.logger, agentTools });
  const evaluatorRuntime = new EvaluatorRuntime({
    baseUrl: 'http://stub/v1', model: 'stub', logger: ctx.logger,
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
  });
  return new WorkflowEngine({
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
}

function graph(): WorkflowGraph {
  return {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'S', type: 'agent_session', title: 'Lead', position: { x: 200, y: 0 }, config: { kind: 'agent_session', agentRole: 'orchestrator', prompt: 'Coordinate the research.', inputKeys: [], outputKeys: [], capabilityTags: [] } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'S' }],
  } as WorkflowGraph;
}

beforeEach(async () => { ctx = await createTestContext(); dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-team-')); });
afterEach(async () => { ctx.close(); await rm(dataDir, { recursive: true, force: true }); });

describe('WorkflowEngine — spawn_team (W3)', () => {
  it('spawns a parallel team, awaits all, and synthesizes', async () => {
    const engine = buildEngine(teamAdapter());
    const g = graph();
    const wfId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'team', graph: g, settings: {} }).run();
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
    const state = run.runState as { nodeStates: Record<string, { outputData?: { result?: string } }> };
    expect(state.nodeStates.S?.outputData?.result).toBe('synthesized');

    // Two specialists were spawned in parallel (one delegation record per member).
    const delegations = ctx.db.select().from(schema.activityEvents)
      .where(and(eq(schema.activityEvents.entityId, runId), eq(schema.activityEvents.eventType, 'agent.delegated'))).all();
    expect(delegations.length).toBe(2);
  });
});
