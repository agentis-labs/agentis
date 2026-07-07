/**
 * Two operator-reported fixes:
 *
 * 1. POLICY-BLOCK class (Organ 4): a deliberate `BLOCKED_*` gate throw is the
 *    workflow working as intended — self-heal/retries must not touch it, and
 *    run.diagnose must explain the approval remedy, not "platform repair gap".
 *
 * 2. Brain write-policy: agentis.memory.write rejects unfindable/junk entries
 *    and dedups by title (a re-write UPDATES instead of piling uuid rows);
 *    results teach agents to cite memories by TITLE.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import { MemoryStore } from '../../src/services/memoryStore.js';
import { analyzeRunFailure } from '../../src/services/runFailureAnalysis.js';
import { recordWorkflowLesson } from '../../src/services/workflowPlaybook.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerRunTools } from '../../src/services/agentisToolHandlers/run.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function buildEngine(): WorkflowEngine {
  return new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
  });
}

describe('POLICY class — a deliberate BLOCKED_* gate throw', () => {
  it('fails fast with the raw gate message (no heal rewrite, no retry stall) and diagnoses as working-as-intended', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        {
          id: 'gate', type: 'transform', title: 'Seed approval gate', position: { x: 200, y: 0 },
          config: {
            kind: 'transform',
            expression: "(() => { const a = input.seedApproval || {}; if (a.approved != true) throw new Error('BLOCKED_SEED_NOT_APPROVED: provide approvals.seed.approved=true'); return a; })()",
          },
        },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'gate' }],
    } as WorkflowGraph;

    const wfId = randomUUID();
    const runId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      title: 'gate-wf', graph, settings: {},
    }).run();
    const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
    ctx.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId,
      userId: ctx.user.id, status: 'CREATED', runState: initialState,
    }).run();

    const engine = buildEngine();
    const terminal = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('run did not finish — a policy block must fail FAST, not retry')), 10_000);
      ctx.bus.subscribe((m) => {
        if (m.room !== `run:${runId}`) return;
        if (m.envelope.event === REALTIME_EVENTS.RUN_FAILED) { clearTimeout(timer); resolve('FAILED'); }
        if (m.envelope.event === REALTIME_EVENTS.RUN_COMPLETED) { clearTimeout(timer); resolve('COMPLETED'); }
      });
    });
    await engine.startRun({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id,
      triggerId: null, inputs: {}, initialState, graph,
    });
    expect(await terminal).toBe('FAILED');

    // The RAW gate message survived — no heal wrapped/replaced it, and the
    // graph itself was never patched by a "repair".
    const run = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    const state = run.runState as { nodeStates: Record<string, { error?: string }> };
    expect(state.nodeStates.gate?.error).toMatch(/BLOCKED_SEED_NOT_APPROVED/);
    const wf = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, wfId)).get()!;
    expect(JSON.stringify(wf.graph)).toContain('BLOCKED_SEED_NOT_APPROVED');

    // run.diagnose explains the remedy — approval, not "platform repair gap".
    const analysis = analyzeRunFailure(ctx.db, ctx.workspace.id, runId);
    expect(analysis?.recognized).toBe(true);
    expect(analysis?.explanation).toMatch(/working as intended/i);
    expect(analysis?.fixes[0]).toMatch(/approval/i);
  });
});

describe('Brain write-policy — agentis.memory.write', () => {
  function registryWithMemory(): AgentisToolRegistry {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerRunTools(registry, {
      db: ctx.db, logger: ctx.logger, bus: ctx.bus,
      engine: {} as ToolHandlerDeps['engine'],
      adapters: {} as ToolHandlerDeps['adapters'],
      ledger: { listForRun: async () => [] } as unknown as ToolHandlerDeps['ledger'],
      scratchpad: {} as ToolHandlerDeps['scratchpad'],
      approvals: { list: () => [] } as unknown as ToolHandlerDeps['approvals'],
      activity: {} as ToolHandlerDeps['activity'],
      replay: {} as ToolHandlerDeps['replay'],
      memory: new MemoryStore(ctx.db, ctx.logger),
    } as ToolHandlerDeps);
    return registry;
  }
  const toolCtx = () => ({ workspaceId: ctx.workspace.id, userId: ctx.user.id, ambientId: ctx.ambient.id, caller: 'chat' as const });

  it('rejects a one-word title (unfindable) with an instructive error', async () => {
    const res = await registryWithMemory().execute(
      { id: '', toolId: 'agentis.memory.write', arguments: { title: 'replay', content: 'Replay child runs must be inserted before startRun or they are ghosts.' } },
      toolCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/searchable phrase/i);
  });

  it('rejects an id-dump (transient work product, not a lesson)', async () => {
    const res = await registryWithMemory().execute(
      { id: '', toolId: 'agentis.memory.write', arguments: { title: 'Failed replay run ids', content: `runs ${randomUUID()} and ${randomUUID()}` } },
      toolCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/transient work product/i);
  });

  it('accepts a real lesson (message cites the TITLE) and dedups a same-titled re-write into an update', async () => {
    const registry = registryWithMemory();
    const first = await registry.execute(
      { id: '', toolId: 'agentis.memory.write', arguments: { title: 'Replay child runs need a persisted row', content: 'WHEN replaying a run, the child run row must exist in workflow_runs before startRun, or observers see found:false.' } },
      toolCtx(),
    );
    expect(first.ok).toBe(true);
    const a = first.output as { id: string; status: string; message: string };
    expect(a.status).toBe('created');
    expect(a.message).toMatch(/cite it by its title/i);

    const second = await registry.execute(
      { id: '', toolId: 'agentis.memory.write', arguments: { title: 'Replay child runs NEED a persisted row', content: 'UPDATED: fixed 2026-07-02 — the replay tool now inserts the row; keep the fence green.' } },
      toolCtx(),
    );
    expect(second.ok).toBe(true);
    const b = second.output as { id: string; status: string; deduplicated?: boolean };
    expect(b.status).toBe('updated');
    expect(b.deduplicated).toBe(true);
    expect(b.id).toBe(a.id); // same memory, refreshed — not a second uuid row
  });

  it('recordWorkflowLesson dedups by failure mode (re-learning updates in place)', () => {
    const memory = new MemoryStore(ctx.db, ctx.logger);
    const id1 = recordWorkflowLesson(memory, ctx.workspace.id, { failureMode: 'Instagram sidecar posts hide media', fix: 'Validate the raw payload first.' });
    const id2 = recordWorkflowLesson(memory, ctx.workspace.id, { failureMode: 'Instagram sidecar posts hide media', fix: 'Validate the raw payload first; fall back to screenshots.' });
    expect(id1).toBeTruthy();
    expect(id2).toBe(id1);
    const lessons = memory.list({ workspaceId: ctx.workspace.id, scopeId: null, kind: 'lesson', limit: 50 });
    expect(lessons.filter((l) => l.title.includes('Instagram sidecar'))).toHaveLength(1);
  });
});
