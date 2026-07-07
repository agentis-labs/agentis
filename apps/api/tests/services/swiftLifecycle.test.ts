/**
 * SWIFT lifecycle e2e over the real tool handlers + arming gate:
 *  - workflow.scope derives/validates/persists the spec (worldly checks first);
 *  - workflow.test manages + runs the suite through the dry-run engine and
 *    stamps hash-keyed suite evidence (generated cases never gate);
 *  - workflow.harden refuses until EVERY predicate holds — including a debug
 *    run whose verdict is ACCOMPLISHED (completion is not accomplishment) —
 *    then freezes the YAML export and stamps hardened;
 *  - the trigger arming gate blocks an unattended trigger on an unhardened
 *    workflow (BLOCKED_LIFECYCLE_NOT_HARDENED), allows audited override, and
 *    passes once hardened.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerBuildTools } from '../../src/services/agentisToolHandlers/build.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { graphContentHash, readBuildLoop, stampBuildLoop } from '../../src/services/workflowCompass.js';
import { WorkflowTriggerDeploymentService } from '../../src/services/workflowTriggerDeployment.js';
import type { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;

beforeEach(async () => {
  ctx = await createTestContext();
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  const engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger, scratchpad, activity, approvals,
    skills: {} as unknown as ExtensionRuntime,
    adapters,
  });
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerBuildTools(registry, {
    db: ctx.db, logger: ctx.logger, bus: ctx.bus, engine, adapters,
    ledger, scratchpad, approvals, activity,
    replay: {} as ToolHandlerDeps['replay'],
  } as ToolHandlerDeps);
});

afterEach(() => ctx.close());

const toolCtx = () => ({
  workspaceId: ctx.workspace.id,
  userId: ctx.user.id,
  ambientId: ctx.ambient.id,
  caller: 'chat' as const,
});

function storeGraph(triggerType: 'manual' | 'cron' = 'manual'): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Start', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType, ...(triggerType === 'cron' ? { schedule: '0 9 * * *' } : {}) } },
      { id: 'P', type: 'transform', title: 'Produce store', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ deploymentUrl: "https://store.vercel.app", products: [1, 2, 3] })' } },
      { id: 'R', type: 'return_output', title: 'Return', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json', isOutput: true } },
    ],
    edges: [
      { id: 'e1', source: 'T', target: 'P' },
      { id: 'e2', source: 'P', target: 'R' },
    ],
  };
}

function seedWorkflow(graph: WorkflowGraph, title = 'Deploy the store with at least 3 products'): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title, description: 'build a store and deploy it live', graph, settings: {},
  }).run();
  return id;
}

const wfRow = (id: string) => ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get()!;

describe('agentis.workflow.scope', () => {
  it('derives a spec with worldly checks from the description and persists it reconciled', async () => {
    const wfId = seedWorkflow(storeGraph());
    const res = await registry.execute({ id: '', toolId: 'agentis.workflow.scope', arguments: { workflowId: wfId } }, toolCtx());
    expect(res.ok).toBe(true);
    const out = res.output as { ok: boolean; spec: { acceptance: Array<{ verify: string }>; reconciledHash?: string }; worldlyChecks: number };
    expect(out.ok).toBe(true);
    expect(out.worldlyChecks).toBeGreaterThan(0); // deploy → http_probe derived
    expect(out.spec.reconciledHash).toBe(graphContentHash(storeGraph()));
    const persisted = (wfRow(wfId).settings as { spec?: unknown }).spec;
    expect(persisted).toBeTruthy();
  });

  it('rejects an invalid explicit spec with named errors (nothing persisted)', async () => {
    const wfId = seedWorkflow(storeGraph());
    const res = await registry.execute({
      id: '', toolId: 'agentis.workflow.scope',
      arguments: { workflowId: wfId, spec: { objective: 'x', acceptance: [{ id: 'bad', claim: 'c', verify: 'expr', expr: 'output..??' }] } },
    }, toolCtx());
    const out = res.output as { ok: boolean; errors: string[] };
    expect(out.ok).toBe(false);
    expect(out.errors.join(' ')).toMatch(/does not parse/);
    expect((wfRow(wfId).settings as { spec?: unknown }).spec).toBeUndefined();
  });
});

describe('agentis.workflow.test (the suite)', () => {
  it('add + run: green suite stamps hash-keyed evidence; a failing case turns it red', async () => {
    const wfId = seedWorkflow(storeGraph());
    // Scope first so the suite also evaluates the spec's expr/floors.
    await registry.execute({
      id: '', toolId: 'agentis.workflow.scope',
      arguments: {
        workflowId: wfId,
        spec: {
          objective: 'store deployed',
          acceptance: [{ id: 'has_products', claim: '3+ products', verify: 'expr', expr: 'output.products.length >= 3' }],
          sufficiency: [{ key: 'products', minItems: 3 }],
        },
      },
    }, toolCtx());

    await registry.execute({
      id: '', toolId: 'agentis.workflow.test',
      arguments: { workflowId: wfId, action: 'add', case: { name: 'happy', kind: 'happy', inputs: {} } },
    }, toolCtx());
    const run1 = await registry.execute({ id: '', toolId: 'agentis.workflow.test', arguments: { workflowId: wfId, action: 'run' } }, toolCtx());
    const out1 = run1.output as { ok: boolean; passed: number; gating: number };
    expect(out1.ok).toBe(true);
    expect(out1.passed).toBe(out1.gating);
    const loop1 = readBuildLoop(wfRow(wfId).settings);
    expect(loop1.suite?.ok).toBe(true);
    expect(loop1.suite?.graphHash).toBe(graphContentHash(storeGraph()));

    // A case with a failing assertion turns the suite red.
    await registry.execute({
      id: '', toolId: 'agentis.workflow.test',
      arguments: { workflowId: wfId, action: 'add', case: { name: 'expects five products', kind: 'edge', inputs: {}, assertions: [{ nodeId: 'P', expr: 'output.products.length >= 5' }] } },
    }, toolCtx());
    const run2 = await registry.execute({ id: '', toolId: 'agentis.workflow.test', arguments: { workflowId: wfId, action: 'run' } }, toolCtx());
    const out2 = run2.output as { ok: boolean; results: Array<{ name: string; passed: boolean }> };
    expect(out2.ok).toBe(false);
    expect(out2.results.find((r) => r.name === 'expects five products')?.passed).toBe(false);
    expect(readBuildLoop(wfRow(wfId).settings).suite?.ok).toBe(false);
  });

  it('generated cases run but never gate until kept', async () => {
    const graph = storeGraph();
    (graph as unknown as { inputContract: unknown }).inputContract = { fields: [{ key: 'name', type: 'string', required: true }] };
    const wfId = seedWorkflow(graph);
    const gen = await registry.execute({ id: '', toolId: 'agentis.workflow.test', arguments: { workflowId: wfId, action: 'generate' } }, toolCtx());
    const genOut = gen.output as { ok: boolean; added: number };
    expect(genOut.ok).toBe(true);
    expect(genOut.added).toBeGreaterThan(1);
    const run = await registry.execute({ id: '', toolId: 'agentis.workflow.test', arguments: { workflowId: wfId, action: 'run' } }, toolCtx());
    const out = run.output as { ok: boolean; gating: number; total: number };
    expect(out.gating).toBe(0);        // all generated → none gate
    expect(out.total).toBeGreaterThan(1);
    expect(out.ok).toBe(false);        // a suite with zero KEPT cases is not green
  });
});

describe('agentis.workflow.harden (the gate)', () => {
  it('refuses with named predicates — and COMPLETED-but-unverified is NOT hardenable', async () => {
    const wfId = seedWorkflow(storeGraph());
    const hash = graphContentHash(storeGraph());
    // Manufacture partial evidence: dry-run green + debug COMPLETED **without a verdict**.
    stampBuildLoop(ctx.db, wfId, {
      dryRun: { at: 't', ok: true, issueCount: 0, graphHash: hash },
      debugRun: { at: 't', runId: 'r1', status: 'COMPLETED', graphHash: hash },
    });
    const res = await registry.execute({ id: '', toolId: 'agentis.workflow.harden', arguments: { workflowId: wfId } }, toolCtx());
    const out = res.output as { ok: boolean; unmet: Array<{ predicate: string; clearWith: { tool: string } }> };
    expect(out.ok).toBe(false);
    const predicates = out.unmet.map((u) => u.predicate).join(' | ');
    expect(predicates).toMatch(/No spec/);
    expect(predicates).toMatch(/suite/i);
    expect(predicates).toMatch(/never VERIFIED|verdict/i);
    expect(out.unmet.every((u) => u.clearWith.tool.startsWith('agentis.'))).toBe(true);
  });

  it('hardens when every predicate holds: stamps + frozen YAML artifact; a graph edit demotes', async () => {
    const wfId = seedWorkflow(storeGraph());
    const hash = graphContentHash(storeGraph());
    await registry.execute({
      id: '', toolId: 'agentis.workflow.scope',
      arguments: {
        workflowId: wfId,
        spec: {
          objective: 'store live',
          acceptance: [{ id: 'worldly', claim: 'products present', verify: 'expr', expr: 'output.products.length >= 3' }],
        },
      },
    }, toolCtx());
    // Suite: one happy + one non-happy kept case, then run it green.
    await registry.execute({ id: '', toolId: 'agentis.workflow.test', arguments: { workflowId: wfId, action: 'add', case: { name: 'happy', kind: 'happy', inputs: {} } } }, toolCtx());
    await registry.execute({ id: '', toolId: 'agentis.workflow.test', arguments: { workflowId: wfId, action: 'add', case: { name: 'edge empty input', kind: 'edge', inputs: { name: '' } } } }, toolCtx());
    const suite = await registry.execute({ id: '', toolId: 'agentis.workflow.test', arguments: { workflowId: wfId, action: 'run' } }, toolCtx());
    expect((suite.output as { ok: boolean }).ok).toBe(true);
    // Debug run ACCOMPLISHED (the engine stamps this in real runs; manufactured here).
    stampBuildLoop(ctx.db, wfId, {
      dryRun: { at: 't', ok: true, issueCount: 0, graphHash: hash },
      debugRun: { at: 't', runId: 'r1', status: 'COMPLETED', graphHash: hash, verdict: 'accomplished' },
    });

    const res = await registry.execute({ id: '', toolId: 'agentis.workflow.harden', arguments: { workflowId: wfId } }, toolCtx());
    const out = res.output as { ok: boolean; hardened: boolean; exportRef?: string; unmet?: unknown[] };
    expect(out.ok).toBe(true);
    expect(out.hardened).toBe(true);
    const loop = readBuildLoop(wfRow(wfId).settings);
    expect(loop.hardened?.graphHash).toBe(hash);
    // The frozen YAML export is a real artifact.
    expect(out.exportRef).toBeTruthy();
    const artifact = ctx.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, out.exportRef!)).get();
    expect(artifact?.content).toMatch(/kind: Workflow/);

    // Edit the graph → hardened evidence is stale by hash (honest demotion).
    const changed = storeGraph();
    changed.nodes = changed.nodes.map((n) => (n.id === 'P' ? { ...n, config: { kind: 'transform', expression: '({ deploymentUrl: "https://x.app", products: [] })' } } : n));
    ctx.db.update(schema.workflows).set({ graph: changed }).where(eq(schema.workflows.id, wfId)).run();
    const status = await registry.execute({ id: '', toolId: 'agentis.workflow.loop_status', arguments: { workflowId: wfId } }, toolCtx());
    expect((status.output as { stage: string }).stage).toBe('authored');
  });
});

describe('the arming gate (SWIFT-T)', () => {
  // Mirrors the real TriggerRuntime contract: activation flips the row active.
  const fakeRuntime = {
    activate: async (t: { triggerId: string }) => {
      ctx.db.update(schema.triggers).set({ status: 'active', updatedAt: new Date().toISOString() })
        .where(eq(schema.triggers.id, t.triggerId)).run();
    },
    deactivate: async () => {},
  } as unknown as TriggerRuntime;

  it('blocks an unattended (cron) trigger on an unhardened workflow; audited override arms it', async () => {
    const wfId = seedWorkflow(storeGraph('cron'));
    const deployments = new WorkflowTriggerDeploymentService(ctx.db, fakeRuntime);
    await expect(deployments.activate({
      workspaceId: ctx.workspace.id, workflowId: wfId, ambientId: ctx.ambient.id, userId: ctx.user.id,
    })).rejects.toThrow(/BLOCKED_LIFECYCLE_NOT_HARDENED/);

    // Explicit override arms it AND leaves an audit row — never silent.
    const deployment = await deployments.activate({
      workspaceId: ctx.workspace.id, workflowId: wfId, ambientId: ctx.ambient.id, userId: ctx.user.id,
      override: { ack: 'operator accepts unverified schedule for a demo' },
    });
    expect(deployment.status).toBe('active');
    const audit = ctx.db.select().from(schema.auditEntries).all()
      .find((row) => row.action === 'trigger.armed_unhardened');
    expect(audit?.outputSummary).toMatch(/operator accepts/);
  });

  it('arms cleanly once the workflow is hardened at the current graph', async () => {
    const wfId = seedWorkflow(storeGraph('cron'));
    const graph = wfRow(wfId).graph as WorkflowGraph;
    stampBuildLoop(ctx.db, wfId, { hardened: { at: 't', graphHash: graphContentHash(graph), specHash: 's1' } });
    const deployments = new WorkflowTriggerDeploymentService(ctx.db, fakeRuntime);
    const deployment = await deployments.activate({
      workspaceId: ctx.workspace.id, workflowId: wfId, ambientId: ctx.ambient.id, userId: ctx.user.id,
    });
    expect(deployment.status).toBe('active');
  });

  it('manual triggers stay ungated — ceremony only at the autonomy doors', async () => {
    const wfId = seedWorkflow(storeGraph('manual'));
    const deployments = new WorkflowTriggerDeploymentService(ctx.db, fakeRuntime);
    const deployment = await deployments.activate({
      workspaceId: ctx.workspace.id, workflowId: wfId, ambientId: ctx.ambient.id, userId: ctx.user.id,
    });
    expect(deployment.status).toBe('active');
  });
});
