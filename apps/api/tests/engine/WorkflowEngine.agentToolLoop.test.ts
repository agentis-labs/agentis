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
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
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
import type { SkillRuntime } from '../../src/services/skillRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

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

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-engine-loop-'));
  const volume = new WorkspaceVolumeService(dataDir);
  const evaluatorRuntime = new EvaluatorRuntime({
    baseUrl: 'http://stub/v1', model: 'stub', logger: ctx.logger,
    fetchImpl: scriptedFetch([
      { thought: 'write the result', action: 'tool', tool: 'write_file', args: { path: 'out/result.txt', content: 'hello from loop' } },
      { thought: 'done', action: 'final', output: 'Wrote out/result.txt' },
    ]),
  });
  engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    specialists: new SpecialistAgentService(ctx.db),
    agentTools: new AgentToolRuntime({ volume }),
    evaluatorRuntime,
    skills: {} as unknown as SkillRuntime,
    adapters: new AdapterManager(ctx.logger),
  });
});

afterEach(async () => {
  ctx.close();
  await rm(dataDir, { recursive: true, force: true });
});

function runGraph(graph: WorkflowGraph, events: string[]): Promise<string> {
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
        if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED || m.envelope.event === REALTIME_EVENTS.RUN_FAILED) {
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

describe('WorkflowEngine — agent_task useRoleTools', () => {
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
});
