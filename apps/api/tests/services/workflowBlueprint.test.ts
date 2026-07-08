/**
 * BRAIN-BLUEPRINT-10X — the blessed-graph law.
 *
 * Proves: runtime-class failures are classified (no graph edit can fix them);
 * the self-heal guard blocks structural surgery on runtime failures AND on
 * blessed graphs; the blessed bytes resolve from the blueprint stamp (or the
 * newest ACCOMPLISHED run); restore_blueprint rolls a mangled workflow back;
 * agent learnings pass the capture gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { classifyRuntimeFailure, selfHealGuardDecision, findBlessedGraph } from '../../src/services/workflow/workflowBlueprint.js';
import { graphContentHash, stampBuildLoop } from '../../src/services/workflow/workflowCompass.js';
import { extractAgentLearningSignal } from '../../src/services/chat/chatMemoryCapture.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerBlueprintTools } from '../../src/services/agentisToolHandlers/blueprint.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import type { WorkflowGraph } from '@agentis/core';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

const ws = () => ctx.workspace.id;

function makeGraph(title: string): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Start', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } as never },
      { id: 'work', type: 'agent_task', title, position: { x: 1, y: 0 }, config: { kind: 'agent_task' } as never },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'work' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function seedWorkflow(graph: WorkflowGraph): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({ id, workspaceId: ws(), userId: ctx.user.id, title: 'Prod Flow', graph }).run();
  return id;
}

function seedRun(workflowId: string, opts: { accomplished?: boolean; unverifiedCompleted?: boolean; graph?: WorkflowGraph | null; createdAt?: string }): string {
  const id = randomUUID();
  const status = opts.accomplished || opts.unverifiedCompleted ? 'COMPLETED' : 'FAILED';
  const runState = opts.unverifiedCompleted
    ? { nodeStates: {}, completedNodeIds: [] } // COMPLETED but no verdict ran — proven-in-practice only.
    : { nodeStates: {}, completedNodeIds: [], ...(opts.accomplished ? { verdict: { outcome: 'accomplished' } } : { verdict: { outcome: 'failed_checks' } }) };
  ctx.db.insert(schema.workflowRuns).values({
    id,
    workspaceId: ws(),
    workflowId,
    userId: ctx.user.id,
    status,
    runState,
    ...(opts.graph !== null ? { graphSnapshot: (opts.graph ?? makeGraph('snap')) as unknown as object } : {}),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  }).run();
  return id;
}

describe('classifyRuntimeFailure', () => {
  it('recognizes model/runtime/credential/quota failures', () => {
    expect(classifyRuntimeFailure('The model claude-opus-9 was not found')).toMatch(/model/);
    expect(classifyRuntimeFailure('529 overloaded_error: Overloaded')).toBeTruthy();
    expect(classifyRuntimeFailure('429 Too Many Requests')).toMatch(/rate limit/);
    expect(classifyRuntimeFailure('insufficient credit balance — check billing')).toMatch(/quota|billing/);
    expect(classifyRuntimeFailure('401 Unauthorized: invalid api key')).toMatch(/credential|auth/i);
    expect(classifyRuntimeFailure('spawn C:\\Users\\x\\claude.exe ENOENT')).toMatch(/spawn/);
    expect(classifyRuntimeFailure('request timed out after 90s')).toMatch(/timeout/);
    expect(classifyRuntimeFailure('The claude_code runtime is unavailable: health check failed')).toBeTruthy();
  });

  it('returns null for graph/data-class failures', () => {
    expect(classifyRuntimeFailure("node 'qualify' produced no value for declared key 'leads'")).toBeNull();
    expect(classifyRuntimeFailure('transform expression referenced input.foo which does not exist')).toBeNull();
  });
});

describe('selfHealGuardDecision', () => {
  const hash = 'abc123';
  it('blocks graph surgery on runtime-class failures regardless of blessing', () => {
    const d = selfHealGuardDecision({ error: '429 rate limit exceeded', currentGraphHash: hash, blueprintHash: null, hardenedHash: null });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.class).toBe('runtime');
  });
  it('blocks autonomous restructure of a BLESSED graph (blueprint or hardened)', () => {
    const viaBlueprint = selfHealGuardDecision({ error: 'output shape mismatch', currentGraphHash: hash, blueprintHash: hash, hardenedHash: null });
    expect(viaBlueprint.allow).toBe(false);
    if (!viaBlueprint.allow) {
      expect(viaBlueprint.class).toBe('blueprint_protected');
      expect(viaBlueprint.reason).toContain('restore_blueprint');
    }
    const viaHardened = selfHealGuardDecision({ error: 'output shape mismatch', currentGraphHash: hash, blueprintHash: null, hardenedHash: hash });
    expect(viaHardened.allow).toBe(false);
  });
  it('allows structural heal on an unblessed graph with a graph-class failure', () => {
    const d = selfHealGuardDecision({ error: 'declared key leads missing from output', currentGraphHash: hash, blueprintHash: 'other', hardenedHash: null });
    expect(d.allow).toBe(true);
  });
});

describe('findBlessedGraph + restore_blueprint', () => {
  it('resolves the blueprint-stamped run first, else the newest accomplished run', () => {
    const goodGraph = makeGraph('Proven');
    const wf = seedWorkflow(makeGraph('Mangled'));
    const oldIso = new Date(Date.now() - 3600_000).toISOString();
    const accomplished = seedRun(wf, { accomplished: true, graph: goodGraph, createdAt: oldIso });
    seedRun(wf, { accomplished: false }); // newer failure — must not win

    // Fallback path (no stamp yet): newest ACCOMPLISHED run.
    const viaFallback = findBlessedGraph(ctx.db, ws(), wf);
    expect(viaFallback?.source).toBe('latest_accomplished_run');
    expect(viaFallback?.runId).toBe(accomplished);
    expect(viaFallback?.graphHash).toBe(graphContentHash(goodGraph));

    // Stamp path: blueprint points at the run explicitly.
    stampBuildLoop(ctx.db, wf, { blueprint: { at: oldIso, runId: accomplished, graphHash: graphContentHash(goodGraph) } });
    const viaStamp = findBlessedGraph(ctx.db, ws(), wf);
    expect(viaStamp?.source).toBe('blueprint_stamp');
    expect(viaStamp?.runId).toBe(accomplished);
  });

  it('restore_blueprint replaces a mangled graph with the proven bytes', async () => {
    const goodGraph = makeGraph('Proven');
    // The mangled graph must differ STRUCTURALLY (canonical hashing ignores
    // cosmetic fields like titles) — a self-heal "repair" adds/rewires nodes.
    const mangled = makeGraph('Mangled by self-heal');
    mangled.nodes.push({ id: 'injected', type: 'transform', title: 'Injected by heal', position: { x: 2, y: 0 }, config: { kind: 'transform' } as never });
    mangled.edges.push({ id: 'e2', source: 'work', target: 'injected' });
    const wf = seedWorkflow(mangled);
    const run = seedRun(wf, { accomplished: true, graph: goodGraph });

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBlueprintTools(registry, { db: ctx.db, logger: ctx.logger } as unknown as ToolHandlerDeps);
    const res = await registry.execute(
      { id: 't1', toolId: 'agentis.workflow.restore_blueprint', arguments: { workflowId: wf } },
      { workspaceId: ws(), userId: ctx.user.id, caller: 'chat' },
    );
    expect(res.errorMessage ?? '').toBe('');
    expect(res.ok).toBe(true);
    const out = res.output as { restored: boolean; fromRunId: string; graphHash: string };
    expect(out.restored).toBe(true);
    expect(out.fromRunId).toBe(run);

    const saved = ctx.db.select().from(schema.workflows).all().find((w) => w.id === wf)!;
    expect(graphContentHash(saved.graph as WorkflowGraph)).toBe(graphContentHash(goodGraph));
    expect(saved.contentHash).toBe(graphContentHash(goodGraph));

    // Second call: already blessed → honest no-op naming the runtime-class hint.
    const again = await registry.execute(
      { id: 't2', toolId: 'agentis.workflow.restore_blueprint', arguments: { workflowId: wf } },
      { workspaceId: ws(), userId: ctx.user.id, caller: 'chat' },
    );
    expect((again.output as { restored: boolean; alreadyBlessed?: boolean }).alreadyBlessed).toBe(true);
  });

  it('reports restored:false honestly when nothing accomplished exists', async () => {
    const wf = seedWorkflow(makeGraph('Never proven'));
    seedRun(wf, { accomplished: false });
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBlueprintTools(registry, { db: ctx.db, logger: ctx.logger } as unknown as ToolHandlerDeps);
    const res = await registry.execute(
      { id: 't3', toolId: 'agentis.workflow.restore_blueprint', arguments: { workflowId: wf } },
      { workspaceId: ws(), userId: ctx.user.id, caller: 'chat' },
    );
    expect((res.output as { restored: boolean }).restored).toBe(false);
  });
});

describe('agentis.workflow.bless (operator-confirmed blueprint)', () => {
  function blessRegistry() {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBlueprintTools(registry, { db: ctx.db, logger: ctx.logger } as unknown as ToolHandlerDeps);
    return registry;
  }

  it('blesses the latest COMPLETED (even unverified) run by default; restore honors it', async () => {
    const goodGraph = makeGraph('Works in practice');
    // Structurally different current graph (canonical hashing ignores titles).
    const current = makeGraph('Current');
    current.nodes.push({ id: 'extra', type: 'transform', title: 'Extra', position: { x: 2, y: 0 }, config: { kind: 'transform' } as never });
    current.edges.push({ id: 'e2', source: 'work', target: 'extra' });
    const wf = seedWorkflow(current);
    seedRun(wf, { unverifiedCompleted: true, graph: makeGraph('older'), createdAt: new Date(Date.now() - 7200_000).toISOString() });
    const newest = seedRun(wf, { unverifiedCompleted: true, graph: goodGraph, createdAt: new Date(Date.now() - 3600_000).toISOString() });
    seedRun(wf, { accomplished: false, createdAt: new Date().toISOString() }); // newer FAILED must not win

    const registry = blessRegistry();
    const res = await registry.execute(
      { id: 'b1', toolId: 'agentis.workflow.bless', arguments: { workflowId: wf } },
      { workspaceId: ws(), userId: ctx.user.id, caller: 'chat' },
    );
    expect(res.errorMessage ?? '').toBe('');
    const out = res.output as { blessed: boolean; runId: string; graphHash: string; matchesCurrentGraph: boolean };
    expect(out.blessed).toBe(true);
    expect(out.runId).toBe(newest);
    expect(out.matchesCurrentGraph).toBe(false); // current "Current" graph ≠ blessed snapshot

    // The stamp is now the blueprint findBlessedGraph resolves first.
    const blessed = findBlessedGraph(ctx.db, ws(), wf);
    expect(blessed?.source).toBe('blueprint_stamp');
    expect(blessed?.runId).toBe(newest);
    expect(blessed?.graphHash).toBe(graphContentHash(goodGraph));
  });

  it('blesses an explicit runId and reports matchesCurrentGraph when hashes align', async () => {
    const goodGraph = makeGraph('Exact');
    const wf = seedWorkflow(goodGraph);
    const run = seedRun(wf, { unverifiedCompleted: true, graph: goodGraph });
    const res = await blessRegistry().execute(
      { id: 'b2', toolId: 'agentis.workflow.bless', arguments: { workflowId: wf, runId: run } },
      { workspaceId: ws(), userId: ctx.user.id, caller: 'chat' },
    );
    const out = res.output as { blessed: boolean; runId: string; matchesCurrentGraph: boolean };
    expect(out.blessed).toBe(true);
    expect(out.runId).toBe(run);
    expect(out.matchesCurrentGraph).toBe(true);
  });

  it('returns blessed:false honestly when no COMPLETED run exists', async () => {
    const wf = seedWorkflow(makeGraph('Never ran clean'));
    seedRun(wf, { accomplished: false });
    const res = await blessRegistry().execute(
      { id: 'b3', toolId: 'agentis.workflow.bless', arguments: { workflowId: wf } },
      { workspaceId: ws(), userId: ctx.user.id, caller: 'chat' },
    );
    expect((res.output as { blessed: boolean }).blessed).toBe(false);
  });
});

describe('extractAgentLearningSignal', () => {
  it('accepts substantive learning-shaped agent output', () => {
    const text = 'I finished the investigation. The root cause was that the Vercel deploy step used a project id that never existed, so every release validated against a mock. For future runs the validator now checks the real deployment URL before reporting success.';
    expect(extractAgentLearningSignal(text)).toBe(true);
  });
  it('rejects short or non-learning output', () => {
    expect(extractAgentLearningSignal('Done! The report was sent.')).toBe(false);
    expect(extractAgentLearningSignal('x'.repeat(200))).toBe(false);
  });
});
