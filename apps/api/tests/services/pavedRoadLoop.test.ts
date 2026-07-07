/**
 * PAVED-ROAD P0/P1 e2e over the real tool handlers:
 *  - one door: agentis.workflow.create runs the gated pipeline (not a raw insert);
 *    agentis.workflow.patch (at-rest) rejects a regression by name.
 *  - the loop is state: dry_run stamps evidence; loop_status reads it; editing
 *    the graph stales it.
 *  - every result carries the compass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
import { readBuildLoop } from '../../src/services/workflowCompass.js';
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

/** trigger → produce({greeting}) → consume(reads input.<field>) → return. */
function pipelineGraph(consumeField: string): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'P', type: 'transform', title: 'Produce', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ greeting: "hi " + (input.name || "world") })' } },
      { id: 'C', type: 'transform', title: 'Consume', position: { x: 400, y: 0 }, config: { kind: 'transform', expression: `({ out: input.${consumeField} || "" })` } },
      { id: 'R', type: 'return_output', title: 'Return', position: { x: 600, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [
      { id: 'e1', source: 'T', target: 'P' },
      { id: 'e2', source: 'P', target: 'C' },
      { id: 'e3', source: 'C', target: 'R' },
    ],
  };
}

function seedWorkflow(graph: WorkflowGraph): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'Pipeline', description: 'test pipeline', graph, settings: {},
  }).run();
  return id;
}

describe('one door (P0)', () => {
  it('agentis.workflow.create runs the FULL gated pipeline and returns a compass', async () => {
    const res = await registry.execute(
      { id: '', toolId: 'agentis.workflow.create', arguments: { name: 'Greeter', description: 'greets people', graph: pipelineGraph('greeting') } },
      toolCtx(),
    );
    expect(res.ok).toBe(true);
    const out = res.output as { workflowId: string; appId: string | null; compass?: { stage: string; next: Array<{ tool: string }> } };
    expect(out.workflowId).toBeTruthy();
    expect(out.appId).toBeTruthy(); // App-of-one anchoring survived the delegation
    expect(out.compass?.stage).toBe('authored');
    expect(out.compass?.next[0]?.tool).toBe('agentis.workflow.dry_run');
    // The gated pipeline stamped loop state — the raw-insert door never did.
    const row = ctx.db.select().from(schema.workflows).all().find((w) => w.id === out.workflowId)!;
    expect(readBuildLoop(row.settings).validatedAt).toBeTruthy();
    expect((row.settings as { intentManifest?: unknown }).intentManifest).toBeTruthy();
    // SWIFT AUTO-SCOPE (enforcement): a workflow is born VERIFIED-BY-DEFAULT —
    // it now carries an acceptance spec, so every run gets a verdict WITHOUT the
    // agent having to opt in via workflow.scope. This is what makes SWIFT
    // always-on instead of bypassable on the build→run→"done" path.
    const spec = (row.settings as { spec?: { acceptance?: unknown[]; verification?: string } }).spec;
    expect(spec).toBeTruthy();
    expect(Array.isArray(spec!.acceptance) && spec!.acceptance.length).toBeGreaterThan(0);
    expect(spec!.verification).toBe('probes_only'); // production cost bounded; debug runs still get full verdict
    // The build RESULT surfaces the acceptance so a weak agent sees it's on the hook.
    const built = res.output as { acceptance?: { checks: Array<{ verify: string }> }; message: string };
    expect(built.acceptance?.checks.length).toBeGreaterThan(0);
    expect(built.message).toMatch(/VERIFIED-BY-DEFAULT/);
  });

  it('SWIFT auto-scope respects an explicit prior scope (does not clobber it)', async () => {
    const wfId = seedWorkflow(pipelineGraph('greeting'));
    // Explicitly scope with a distinctive objective, then rebuild-in-place.
    await registry.execute(
      { id: '', toolId: 'agentis.workflow.scope', arguments: { workflowId: wfId, spec: { objective: 'OPERATOR SCOPED', acceptance: [{ id: 'x', claim: 'c', verify: 'expr', expr: 'output.out != null' }] } } },
      toolCtx(),
    );
    await registry.execute(
      { id: '', toolId: 'agentis.workflow.create', arguments: { workflowId: wfId, description: 'greets people', graph: pipelineGraph('greeting') } },
      toolCtx(),
    );
    const row = ctx.db.select().from(schema.workflows).all().find((w) => w.id === wfId)!;
    expect((row.settings as { spec: { objective: string } }).spec.objective).toBe('OPERATOR SCOPED');
  });

  it('agentis.workflow.patch (at-rest) REJECTS a replacement that introduces a coupling regression', async () => {
    const wfId = seedWorkflow(pipelineGraph('greeting'));
    const res = await registry.execute(
      { id: '', toolId: 'agentis.workflow.patch', arguments: { workflowId: wfId, graph: pipelineGraph('nonexistent_field') } },
      toolCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.errorMessage ?? '').toMatch(/REGRESS/i);
    // The workflow was NOT changed.
    const row = ctx.db.select().from(schema.workflows).all().find((w) => w.id === wfId)!;
    const graph = row.graph as WorkflowGraph;
    expect((graph.nodes.find((n) => n.id === 'C')!.config as { expression?: string }).expression).toContain('input.greeting');
  });

  it('agentis.workflow.patch (at-rest) accepts a clean replacement, stamps, and returns a compass', async () => {
    const wfId = seedWorkflow(pipelineGraph('greeting'));
    const res = await registry.execute(
      { id: '', toolId: 'agentis.workflow.patch', arguments: { workflowId: wfId, graph: pipelineGraph('greeting') } },
      toolCtx(),
    );
    expect(res.ok).toBe(true);
    const out = res.output as { patched: boolean; compass?: { stage: string } };
    expect(out.patched).toBe(true);
    expect(out.compass?.stage).toBe('authored');
    const row = ctx.db.select().from(schema.workflows).all().find((w) => w.id === wfId)!;
    expect(readBuildLoop(row.settings).validatedAt).toBeTruthy();
  });
});

describe('the loop is state (P1)', () => {
  it('dry_run stamps evidence; loop_status reads it; a graph edit stales it', async () => {
    const wfId = seedWorkflow(pipelineGraph('greeting'));

    const dry = await registry.execute(
      { id: '', toolId: 'agentis.workflow.dry_run', arguments: { workflowId: wfId } },
      toolCtx(),
    );
    expect(dry.ok).toBe(true);
    const dryOut = dry.output as { ok: boolean; compass: { stage: string; next: Array<{ tool: string; args: Record<string, unknown> }> } };
    expect(dryOut.ok).toBe(true);
    expect(dryOut.compass.stage).toBe('dry_run_green');
    // SWIFT v2: the rail now points at the suite first, debug run as alternative.
    expect(dryOut.compass.next[0]?.tool).toBe('agentis.workflow.test');
    expect(dryOut.compass.next.map((s) => s.tool)).toContain('agentis.workflow.run');

    const status1 = await registry.execute(
      { id: '', toolId: 'agentis.workflow.loop_status', arguments: { workflowId: wfId } },
      toolCtx(),
    );
    expect(status1.ok).toBe(true);
    const s1 = status1.output as { stage: string; evidence: { dryRun: { stale: boolean } | null } };
    expect(s1.stage).toBe('dry_run_green');
    expect(s1.evidence.dryRun?.stale).toBe(false);

    // Edit the graph out-of-band — the evidence must go stale by hash.
    const changed = { ...pipelineGraph('greeting') };
    changed.nodes = changed.nodes.map((n) => (n.id === 'P' ? { ...n, config: { kind: 'transform', expression: '({ greeting: "changed " + (input.name || "") })' } } : n));
    const { eq } = await import('drizzle-orm');
    ctx.db.update(schema.workflows).set({ graph: changed }).where(eq(schema.workflows.id, wfId)).run();

    const status2 = await registry.execute(
      { id: '', toolId: 'agentis.workflow.loop_status', arguments: { workflowId: wfId } },
      toolCtx(),
    );
    const s2 = status2.output as { stage: string; evidence: { dryRun: { stale: boolean } | null }; compass: { next: Array<{ tool: string }> } };
    expect(s2.stage).toBe('authored'); // evidence stale → back to the start of the loop
    expect(s2.evidence.dryRun?.stale).toBe(true);
    expect(s2.compass.next[0]?.tool).toBe('agentis.workflow.dry_run');
  });

  it('a RED dry_run stamps dry_run_red and the compass says fix-then-dry-run', async () => {
    const wfId = seedWorkflow(pipelineGraph('missing_field'));
    const dry = await registry.execute(
      { id: '', toolId: 'agentis.workflow.dry_run', arguments: { workflowId: wfId } },
      toolCtx(),
    );
    expect(dry.ok).toBe(true); // the CALL succeeds; the report is red
    const out = dry.output as { ok: boolean; compass: { stage: string } };
    expect(out.ok).toBe(false);
    expect(out.compass.stage).toBe('dry_run_red');
  });
});
