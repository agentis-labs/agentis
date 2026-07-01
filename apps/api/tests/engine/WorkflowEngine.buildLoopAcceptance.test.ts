/**
 * BUILD-LOOP ACCEPTANCE (WORKFLOW-BUILD-LOOP).
 *
 * A faithful reproduction of the operator's "Fashion Store Factory" failure
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
import { REALTIME_EVENTS, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { preflightWorkflow } from '../../src/services/workflowPreflight.js';
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
function fashionStoreGraph(): WorkflowGraph {
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

describe('Build-loop acceptance — Fashion Store Factory shape', () => {
  it('runs E2E green: candidates reach the scorer and the gate routes on nodes["score"].scoredCount (the exact bug, fixed)', async () => {
    const graph = fashionStoreGraph();
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
    const graph = fashionStoreGraph();
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
    const graph = fashionStoreGraph();
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
    const graph = fashionStoreGraph();
    const score = graph.nodes.find((n) => n.id === 'score')!;
    (score.config as Record<string, unknown>).inputKeys = ['rawScoutCount'];
    const issues = analyzeInputReachability(graph);
    expect(issues.some((i) => i.identifier === 'input.candidates')).toBe(true);
  });
});

function makeEngine(): WorkflowEngine {
  return new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    extensions: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
  });
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
    title: 'Fashion Store Factory (acceptance)', graph, settings: {},
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
