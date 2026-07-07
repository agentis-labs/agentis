/**
 * PAVED-ROAD P1 — the Compass: durable loop-state + deterministic next-step
 * navigation. These are the semantics every tool result now leans on, so they
 * get their own fence.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import {
  compassForRun,
  compassForWorkflow,
  deriveLoopStage,
  detectProvenDivergence,
  graphContentHash,
  readBuildLoop,
  stampBuildLoop,
  type BuildLoopState,
} from '../../src/services/workflowCompass.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

function graph(expression = '({ out: input.value })'): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'X', type: 'transform', title: 'Do', position: { x: 200, y: 0 }, config: { kind: 'transform', expression } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'X' }],
  };
}

describe('graphContentHash', () => {
  it('is stable across node position changes (moving a node does not stale evidence)', () => {
    const a = graph();
    const b: WorkflowGraph = { ...a, nodes: a.nodes.map((n) => ({ ...n, position: { x: n.position.x + 500, y: 99 } })) };
    expect(graphContentHash(a)).toBe(graphContentHash(b));
  });

  it('changes when a node config changes (editing DOES stale evidence)', () => {
    expect(graphContentHash(graph('({ out: 1 })'))).not.toBe(graphContentHash(graph('({ out: 2 })')));
  });
});

describe('deriveLoopStage', () => {
  const hash = 'h1';
  it('walks the ladder: authored → dry_run → debug → production', () => {
    expect(deriveLoopStage({}, hash)).toBe('authored');
    expect(deriveLoopStage({ dryRun: { at: 't', ok: false, issueCount: 2, graphHash: hash } }, hash)).toBe('dry_run_red');
    expect(deriveLoopStage({ dryRun: { at: 't', ok: true, issueCount: 0, graphHash: hash } }, hash)).toBe('dry_run_green');
    const withDebug: BuildLoopState = {
      dryRun: { at: 't', ok: true, issueCount: 0, graphHash: hash },
      debugRun: { at: 't', runId: 'r1', status: 'FAILED', graphHash: hash },
    };
    expect(deriveLoopStage(withDebug, hash)).toBe('debug_failed');
    // SWIFT v2: COMPLETED without a verdict is NOT proof — completion ≠ accomplishment.
    expect(deriveLoopStage({ ...withDebug, debugRun: { ...withDebug.debugRun!, status: 'COMPLETED' } }, hash)).toBe('debug_completed_unverified');
    // A world-verified debug run is the real gate currency…
    expect(deriveLoopStage({ ...withDebug, debugRun: { ...withDebug.debugRun!, status: 'COMPLETED', verdict: 'accomplished' } }, hash)).toBe('debug_accomplished');
    // …and a deficient verdict outranks COMPLETED.
    expect(deriveLoopStage({ ...withDebug, debugRun: { ...withDebug.debugRun!, status: 'COMPLETED', verdict: 'hollow' } }, hash)).toBe('debug_failed');
    expect(deriveLoopStage({ hardened: { at: 't', graphHash: hash, specHash: 's1' } }, hash)).toBe('hardened');
    expect(deriveLoopStage({ productionRun: { at: 't', runId: 'r2', status: 'COMPLETED', graphHash: hash } }, hash)).toBe('production');
  });

  it('suite evidence sits between dry-run and debug', () => {
    const base: BuildLoopState = { dryRun: { at: 't', ok: true, issueCount: 0, graphHash: hash } };
    expect(deriveLoopStage({ ...base, suite: { at: 't', graphHash: hash, total: 3, passed: 1, ok: false } }, hash)).toBe('suite_red');
    expect(deriveLoopStage({ ...base, suite: { at: 't', graphHash: hash, total: 3, passed: 3, ok: true } }, hash)).toBe('suite_green');
  });

  it('evidence at a DIFFERENT graph hash is stale — stage falls back to authored', () => {
    const state: BuildLoopState = {
      dryRun: { at: 't', ok: true, issueCount: 0, graphHash: 'old' },
      debugRun: { at: 't', runId: 'r1', status: 'COMPLETED', graphHash: 'old' },
    };
    expect(deriveLoopStage(state, 'new')).toBe('authored');
  });
});

describe('compassForWorkflow', () => {
  const g = graph();
  const hash = graphContentHash(g);

  it('authored → next is dry_run with the real workflowId', () => {
    const compass = compassForWorkflow({ workflowId: 'wf1', graph: g, settings: {} });
    expect(compass.stage).toBe('authored');
    expect(compass.next[0]?.tool).toBe('agentis.workflow.dry_run');
    expect(compass.next[0]?.args).toEqual({ workflowId: 'wf1' });
  });

  it('dry_run_green → next is the SUITE (then debug as the alternative)', () => {
    const compass = compassForWorkflow({
      workflowId: 'wf1',
      graph: g,
      settings: { buildLoop: { dryRun: { at: 't', ok: true, issueCount: 0, graphHash: hash } } },
    });
    expect(compass.stage).toBe('dry_run_green');
    expect(compass.next[0]?.tool).toBe('agentis.workflow.test');
    expect(compass.next.map((s) => s.tool)).toContain('agentis.workflow.run');
  });

  it('suite_green → next is a DEBUG run (debugRun:true)', () => {
    const compass = compassForWorkflow({
      workflowId: 'wf1',
      graph: g,
      settings: { buildLoop: { suite: { at: 't', graphHash: hash, total: 2, passed: 2, ok: true } } },
    });
    expect(compass.stage).toBe('suite_green');
    expect(compass.next[0]?.tool).toBe('agentis.workflow.run');
    expect(compass.next[0]?.args).toEqual({ workflowId: 'wf1', debugRun: true });
  });

  it('debug COMPLETED without a verdict → next is SCOPE (completion is not accomplishment)', () => {
    const compass = compassForWorkflow({
      workflowId: 'wf1',
      graph: g,
      settings: { buildLoop: { debugRun: { at: 't', runId: 'r1', status: 'COMPLETED', graphHash: hash } } },
    });
    expect(compass.stage).toBe('debug_completed_unverified');
    expect(compass.next[0]?.tool).toBe('agentis.workflow.scope');
  });

  it('debug ACCOMPLISHED → next is HARDEN; hardened → production run', () => {
    const accomplished = compassForWorkflow({
      workflowId: 'wf1',
      graph: g,
      settings: { buildLoop: { debugRun: { at: 't', runId: 'r1', status: 'COMPLETED', graphHash: hash, verdict: 'accomplished' } } },
    });
    expect(accomplished.stage).toBe('debug_accomplished');
    expect(accomplished.next[0]?.tool).toBe('agentis.workflow.harden');

    const hardened = compassForWorkflow({
      workflowId: 'wf1',
      graph: g,
      settings: { buildLoop: { hardened: { at: 't', graphHash: hash, specHash: 's' } } },
    });
    expect(hardened.stage).toBe('hardened');
    expect(hardened.next[0]?.tool).toBe('agentis.workflow.run');
    expect(hardened.next[0]?.args).toEqual({ workflowId: 'wf1' });
  });
});

describe('detectProvenDivergence (SWIFT "warn previously")', () => {
  const cur = 'current-hash';

  it('is null when the workflow was never proven (nothing to diverge from)', () => {
    expect(detectProvenDivergence({}, cur, 'wf1')).toBeNull();
    expect(detectProvenDivergence({ dryRun: { at: 't', ok: true, issueCount: 0, graphHash: 'x' } }, cur, 'wf1')).toBeNull();
  });

  it('is null when the current graph still equals the proven hash', () => {
    expect(detectProvenDivergence({ blueprint: { at: 't', runId: 'r1', graphHash: cur } }, cur, 'wf1')).toBeNull();
    expect(detectProvenDivergence({ hardened: { at: 't', graphHash: cur, specHash: 's' } }, cur, 'wf1')).toBeNull();
  });

  it('flags a blueprint divergence with the deliver/restore next-steps and the accomplished runId', () => {
    const d = detectProvenDivergence({ blueprint: { at: 't', runId: 'run-abc-123', graphHash: 'proven-hash' } }, cur, 'wf1');
    expect(d).not.toBeNull();
    expect(d!.source).toBe('blueprint');
    expect(d!.provenHash).toBe('proven-hash');
    expect(d!.provenRunId).toBe('run-abc-123');
    expect(d!.currentHash).toBe(cur);
    expect(d!.warning).toMatch(/UNVERIFIED/);
    expect(d!.reverify.tool).toBe('agentis.workflow.deliver');
    expect(d!.reverify.args).toEqual({ workflowId: 'wf1' });
    expect(d!.restore.tool).toBe('agentis.workflow.restore_blueprint');
  });

  it('flags a hardened-only divergence (no runId) when there is no blueprint', () => {
    const d = detectProvenDivergence({ hardened: { at: 't', graphHash: 'hard-hash', specHash: 's' } }, cur, 'wf1');
    expect(d!.source).toBe('hardened');
    expect(d!.provenRunId).toBeUndefined();
    expect(d!.reverify.tool).toBe('agentis.workflow.deliver');
  });

  it('blueprint (world-accomplished) outranks hardened when both diverge', () => {
    const d = detectProvenDivergence(
      { blueprint: { at: 't', runId: 'r1', graphHash: 'bp' }, hardened: { at: 't', graphHash: 'hd', specHash: 's' } },
      cur,
      'wf1',
    );
    expect(d!.source).toBe('blueprint');
    expect(d!.provenHash).toBe('bp');
  });
});

describe('compassForWorkflow — diverged from proven leads with the warning', () => {
  const g = graph();
  const curHash = graphContentHash(g);

  it('prepends UNVERIFIED + deliver + restore ahead of the stage steps', () => {
    // Blueprint proven at a DIFFERENT hash → the current graph is an edited, unverified divergence.
    const compass = compassForWorkflow({
      workflowId: 'wf1',
      graph: g,
      settings: { buildLoop: { blueprint: { at: 't', runId: 'r-old', graphHash: 'proven-old' } } },
    });
    // The stage itself is still honestly derived (authored — no stamp matches this hash)…
    expect(compass.stage).toBe('authored');
    // …but the summary now LEADS with the proactive warning, and deliver is the first call.
    expect(compass.summary).toMatch(/UNVERIFIED/);
    expect(compass.next[0]?.tool).toBe('agentis.workflow.deliver');
    expect(compass.next[1]?.tool).toBe('agentis.workflow.restore_blueprint');
    // The stage's own granular step is still offered after the re-verify/restore.
    expect(compass.next.map((s) => s.tool)).toContain('agentis.workflow.dry_run');
  });

  it('does NOT warn when the current graph IS the proven blueprint', () => {
    const compass = compassForWorkflow({
      workflowId: 'wf1',
      graph: g,
      settings: { buildLoop: { blueprint: { at: 't', runId: 'r', graphHash: curHash } } },
    });
    expect(compass.summary).not.toMatch(/UNVERIFIED/);
    expect(compass.next[0]?.tool).not.toBe('agentis.workflow.deliver');
  });
});

describe('compassForRun', () => {
  it('in-flight → poll run.status with the real runId', () => {
    const compass = compassForRun({ runId: 'r9', workflowId: 'wf1', status: 'started' });
    expect(compass.next[0]?.tool).toBe('agentis.run.status');
    expect(compass.next[0]?.args).toEqual({ runId: 'r9' });
  });

  it('FAILED → diagnose first, then dry_run after the patch', () => {
    const compass = compassForRun({ runId: 'r9', workflowId: 'wf1', status: 'FAILED' });
    expect(compass.next[0]?.tool).toBe('agentis.run.diagnose');
    expect(compass.next.map((s) => s.tool)).toContain('agentis.workflow.dry_run');
  });

  it('COMPLETED debug run without a verdict → next is SCOPE; with accomplished verdict → HARDEN', () => {
    const unverified = compassForRun({ runId: 'r9', workflowId: 'wf1', status: 'COMPLETED', debugRun: true });
    expect(unverified.stage).toBe('debug_completed_unverified');
    expect(unverified.next[0]?.tool).toBe('agentis.workflow.scope');

    const accomplished = compassForRun({ runId: 'r9', workflowId: 'wf1', status: 'COMPLETED', debugRun: true, verdict: 'accomplished' });
    expect(accomplished.stage).toBe('debug_accomplished');
    expect(accomplished.next[0]?.tool).toBe('agentis.workflow.harden');
  });

  it('COMPLETED but verdict deficient → the world-check outranks the status', () => {
    const compass = compassForRun({ runId: 'r9', workflowId: 'wf1', status: 'COMPLETED', verdict: 'hollow' });
    expect(compass.stage).toBe('debug_failed');
    expect(compass.next[0]?.tool).toBe('agentis.run.diagnose');
    expect(compass.summary).toMatch(/HOLLOW/);
  });
});

describe('stampBuildLoop / readBuildLoop', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('merges stamps into settings without clobbering other settings keys', () => {
    const id = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      title: 'T', description: null, graph: graph(), settings: { intentManifest: { keep: true } },
    }).run();

    const first = stampBuildLoop(ctx.db, id, { graphHash: 'h1', validatedAt: 't1' });
    expect(first?.graphHash).toBe('h1');
    const second = stampBuildLoop(ctx.db, id, { dryRun: { at: 't2', ok: true, issueCount: 0, graphHash: 'h1' } });
    expect(second?.validatedAt).toBe('t1'); // prior stamp survives the merge

    const row = ctx.db.select().from(schema.workflows).all()[0]!;
    const settings = row.settings as Record<string, unknown>;
    expect(settings.intentManifest).toEqual({ keep: true }); // untouched
    expect(readBuildLoop(settings).dryRun?.ok).toBe(true);
  });

  it('returns null (never throws) for a missing workflow', () => {
    expect(stampBuildLoop(ctx.db, 'nope', { validatedAt: 't' })).toBeNull();
  });
});
