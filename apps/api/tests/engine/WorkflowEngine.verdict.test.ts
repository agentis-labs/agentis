/**
 * SWIFT layer 3 in the REAL engine: a workflow with a spec gets a verdict at
 * settle (stamped into runState + the buildLoop), a hollow producer trips the
 * sufficiency tripwire mid-run, and spec constraints block out-of-scope
 * services at dispatch (POLICY-class — no heal, no retry).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { ConnectorRegistry, type ConnectorModule } from '@agentis/integrations';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { buildInitialRunState } from '../../src/engine/initialRunState.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { readBuildLoop, graphContentHash } from '../../src/services/workflow/workflowCompass.js';
import type { WorkflowSpec } from '../../src/services/workflow/workflowSpec.js';
import type { RunVerdict } from '../../src/services/workflow/workflowVerdict.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;

const acmeConnector: ConnectorModule = {
  service: 'acme_crm',
  operations: ['create_lead'],
  async execute() { return { ok: true }; },
};

beforeEach(async () => {
  ctx = await createTestContext();
  engine = new WorkflowEngine({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    skills: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
    connectors: new ConnectorRegistry([acmeConnector]),
    vault: ctx.vault,
  });
});

afterEach(() => ctx.close());

function graphProducing(expression: string): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'P', type: 'transform', title: 'Produce', position: { x: 200, y: 0 }, config: { kind: 'transform', expression } },
      { id: 'R', type: 'return_output', title: 'Return', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json', isOutput: true } },
    ],
    edges: [
      { id: 'e1', source: 'T', target: 'P' },
      { id: 'e2', source: 'P', target: 'R' },
    ],
  };
}

function seedWorkflow(graph: WorkflowGraph, spec?: Partial<WorkflowSpec>): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'verdict-wf', graph,
    settings: spec ? { spec: { version: 1, objective: 'produce a store', acceptance: [], createdAt: 't', ...spec } } : {},
  }).run();
  return id;
}

async function startAndWait(wfId: string, graph: WorkflowGraph): Promise<string> {
  const runId = randomUUID();
  const initialState = buildInitialRunState({ runId, workflowId: wfId, graph, inputs: {} });
  ctx.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId: wfId,
    userId: ctx.user.id,
    status: 'CREATED',
    runState: initialState,
  }).run();
  await engine.startRun({ runId, workflowId: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, graph, initialState });
  for (let i = 0; i < 200; i += 1) {
    const row = ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
    if (['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'].includes(row.status)) return runId;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('run did not settle');
}

const loadRun = (runId: string) => ctx.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;

describe('verdict at settle', () => {
  it('ACCOMPLISHED: expr checks pass against the terminal output; verdict stamped on run + buildLoop + health', async () => {
    const graph = graphProducing('({ deploymentUrl: "https://store.vercel.app", products: [1,2,3] })');
    const wfId = seedWorkflow(graph, {
      acceptance: [{ id: 'has_products', claim: '3+ products', verify: 'expr', expr: 'output.products.length >= 3' }],
      sufficiency: [{ key: 'products', minItems: 1 }],
    });
    const runId = await startAndWait(wfId, graph);
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED');
    const verdict = (row.runState as { verdict?: RunVerdict }).verdict;
    expect(verdict?.outcome).toBe('accomplished');
    expect(verdict?.checks[0]).toMatchObject({ checkId: 'has_products', passed: true });
    // Production stamp carries the verdict + rolls outcome health.
    const loop = readBuildLoop(ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, wfId)).get()!.settings);
    expect(loop.productionRun?.verdict).toBe('accomplished');
    expect(loop.outcomeHealth?.recent[0]).toBe(1);
  });

  it('FAILED_CHECKS: the run COMPLETES mechanically but the verdict says the outcome is missing (self-report ignored)', async () => {
    // The producer CLAIMS success in its own output — but the acceptance expr
    // sees only the real terminal data.
    const graph = graphProducing('({ status: "deployed successfully!", products: [1] })');
    const wfId = seedWorkflow(graph, {
      acceptance: [{ id: 'has_products', claim: '3+ products', verify: 'expr', expr: 'output.products.length >= 3' }],
      reworkBudget: 0, // isolate the verdict (no outcome heal in this fence)
    });
    const runId = await startAndWait(wfId, graph);
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED'); // mechanically green…
    const verdict = (row.runState as { verdict?: RunVerdict }).verdict;
    expect(verdict?.outcome).toBe('failed_checks'); // …but not accomplished
    expect(verdict?.deficiencies[0]?.producingNodeIds).toContain('P');
    const loop = readBuildLoop(ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, wfId)).get()!.settings);
    expect(loop.outcomeHealth?.recent[0]).toBe(0);
    expect(loop.outcomeHealth?.lastDeficientRunId).toBe(runId);
  });

  it('a workflow WITHOUT a spec settles exactly as before (no verdict, zero new behavior)', async () => {
    const graph = graphProducing('({ anything: "fine" })');
    const wfId = seedWorkflow(graph);
    const runId = await startAndWait(wfId, graph);
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED');
    expect((row.runState as { verdict?: RunVerdict }).verdict).toBeUndefined();
  });
});

describe('sufficiency tripwire (mid-run anti-hollow)', () => {
  it('a producer emitting a hollow floored key FAILS at that node with the named deficiency — not 20 nodes later', async () => {
    const graph = graphProducing('({ deploymentUrl: "https://x.app", products: [] })');
    const wfId = seedWorkflow(graph, {
      acceptance: [{ id: 'objective_met', claim: 'store built', verify: 'expr', expr: 'output.products.length >= 3' }],
      sufficiency: [{ key: 'products', minItems: 3 }],
      reworkBudget: 0,
    });
    const runId = await startAndWait(wfId, graph);
    const row = loadRun(runId);
    expect(row.status).toBe('FAILED');
    const state = row.runState as { nodeStates: Record<string, { error?: string }> };
    expect(state.nodeStates.P?.error).toMatch(/SUFFICIENCY_FLOOR/);
    expect(state.nodeStates.P?.error).toMatch(/requires ≥3/);
  });

  it('allowEmptyOutput opts a node out of the tripwire', async () => {
    const graph = graphProducing('({ products: [] })');
    graph.nodes = graph.nodes.map((n) => (n.id === 'P' ? { ...n, config: { ...n.config, allowEmptyOutput: true } } : n));
    const wfId = seedWorkflow(graph, {
      acceptance: [{ id: 'x', claim: 'c', verify: 'expr', expr: 'output.products.length >= 0' }],
      sufficiency: [{ key: 'products', minItems: 3 }],
      reworkBudget: 0,
    });
    const runId = await startAndWait(wfId, graph);
    // Node completes (opt-out); the VERDICT still counts the hollowness honestly.
    const row = loadRun(runId);
    expect(row.status).toBe('COMPLETED');
    expect((row.runState as { verdict?: RunVerdict }).verdict?.outcome).toBe('hollow');
  });
});

describe('spec constraints at dispatch (V8)', () => {
  it('an out-of-scope service is BLOCKED_POLICY_SERVICE at the integration node', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'I', type: 'integration', title: 'CRM', position: { x: 200, y: 0 }, config: { kind: 'integration', integrationId: 'acme_crm', operationId: 'create_lead', inputs: {} } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'I' }],
    };
    const wfId = seedWorkflow(graph, {
      acceptance: [{ id: 'x', claim: 'c', verify: 'expr', expr: 'output != null' }],
      constraints: { allowedServices: ['vercel'] }, // acme_crm is OUT of scope
      reworkBudget: 0,
    });
    const runId = await startAndWait(wfId, graph);
    const row = loadRun(runId);
    expect(row.status).toBe('FAILED');
    const state = row.runState as { nodeStates: Record<string, { error?: string }> };
    expect(state.nodeStates.I?.error).toMatch(/BLOCKED_POLICY_SERVICE/);
    expect(state.nodeStates.I?.error).toMatch(/agentis\.workflow\.scope/);
  });

  it('an in-scope service under budget runs normally', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'I', type: 'integration', title: 'CRM', position: { x: 200, y: 0 }, config: { kind: 'integration', integrationId: 'acme_crm', operationId: 'create_lead', inputs: {} } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'I' }],
    };
    const wfId = seedWorkflow(graph, {
      acceptance: [{ id: 'x', claim: 'c', verify: 'expr', expr: 'output.ok == true' }],
      constraints: { allowedServices: ['acme_crm'], maxMutatingCalls: 2 },
    });
    const runId = await startAndWait(wfId, graph);
    expect(loadRun(runId).status).toBe('COMPLETED');
  });
});
