/**
 * Plan-driven assembly with real control flow (WORKFLOW-DESIGN-10X Phase 3 finish)
 * — proves gate/validate Phase Cards materialize as branching graphs (PASS edge +
 * reject/rollback FAIL branch), and that the result is still an acyclic, valid graph.
 */
import { describe, expect, it } from 'vitest';
import { assembleGraphFromPlan } from '../../src/services/agentisToolHandlers/build.js';
import { classifyIntent, planWorkflow, type WorkspaceInventory } from '../../src/services/creationPipeline.js';
import { validateWorkflowGraph } from '../../src/engine/validateGraph.js';

const emptyInventory: WorkspaceInventory = {
  availableAgents: [], configuredCredentials: [], availableExtensions: [], knowledgeBases: [],
  knowledgeExcerpts: [], wireableIntegrations: [], specialistRoles: [], workspaceContext: '',
};

describe('assembleGraphFromPlan — real gate/rollback branches', () => {
  const desc =
    'Prospect Instagram clothing stores, qualify each candidate and reject the weak ones, then deploy the demo to Vercel only after I approve, and validate the live site returns 200';
  const plan = planWorkflow(desc, classifyIntent(desc, emptyInventory));
  const graph = assembleGraphFromPlan(plan, desc);

  it('emits a qualification gate with a reject terminal on the FAIL branch', () => {
    const reject = graph.nodes.find((n) => n.id.startsWith('reject_'));
    expect(reject).toBeTruthy();
    expect((reject!.config as { kind: string }).kind).toBe('return_output');
    const failEdge = graph.edges.find((e) => e.target === reject!.id);
    expect(failEdge?.condition).toBe('output.passed == false');
  });

  it('emits a validate gate with a rollback → terminal on the FAIL branch', () => {
    const rollback = graph.nodes.find((n) => n.id.startsWith('rollback_'));
    expect(rollback).toBeTruthy();
    expect((rollback!.config as { kind: string }).kind).toBe('integration');
    const rolled = graph.nodes.find((n) => n.id.startsWith('rolled_back_'));
    expect(rolled).toBeTruthy();
    // rollback flows into its own terminal
    expect(graph.edges.some((e) => e.source === rollback!.id && e.target === rolled!.id)).toBe(true);
  });

  it('makes each gate forward edge a PASS condition edge', () => {
    const evaluators = graph.nodes.filter((n) => (n.config as { kind: string }).kind === 'evaluator');
    expect(evaluators.length).toBeGreaterThanOrEqual(1);
    for (const ev of evaluators) {
      const forward = graph.edges.find((e) => e.source === ev.id && !e.condition);
      expect(forward?.type).toBe('condition'); // implicit pass-on-`passed`
      const fail = graph.edges.find((e) => e.source === ev.id && e.condition === 'output.passed == false');
      expect(fail).toBeTruthy();
    }
  });

  it('is still an acyclic, valid workflow graph (same non-strict contract the build uses)', () => {
    // The build validates with { strict: false } — pending-config integration nodes
    // are warnings, but a cycle would still throw. The branches must not introduce one.
    expect(() => validateWorkflowGraph(graph, { strict: false })).not.toThrow();
  });
});
