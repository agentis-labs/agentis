/**
 * WorkflowSelfHealService — the anti-hallucination contract (AGENT-AUTONOMY §W7).
 * Verifies: W5.0 output recovery from the node's OWN output; no fabrication;
 * intent-preservation gate; validate-before-apply; escalate-on-uncertainty;
 * autonomous vs approve branching.
 */

import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { WorkflowSelfHealService, type IntentAnchor, type SelfHealInput } from '../../src/services/workflow/workflowSelfHeal.js';
import type { StructuredCompleter } from '../../src/services/structuredCompleter.js';
import { createLogger } from '../../src/logger.js';

const logger = createLogger({ level: 'silent' });
const svc = new WorkflowSelfHealService(logger);

function graph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    edges: [{ id: 'e1', source: 'trigger', target: 'qualify' }],
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Start', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } as never },
      { id: 'qualify', type: 'agent_task', title: 'Qualify and harvest', position: { x: 1, y: 0 },
        config: { kind: 'agent_task', prompt: 'Find the location of each lead.', agentId: 'a1', outputKeys: ['location'] } as never },
    ],
  };
}

const intent: IntentAnchor = {
  goal: 'Qualify leads and harvest their location',
  nodeObjective: 'Find the location of each lead',
  declaredOutputKeys: ['location'],
};

function baseInput(over: Partial<SelfHealInput> = {}): SelfHealInput {
  return {
    workspaceId: 'ws1',
    graph: graph(),
    node: graph().nodes[1]!,
    error: "agent node 'qualify' did not produce declared output key(s): location",
    rawOutput: { result: 'The lead is based in Paris, France.' },
    upstreamOutputs: {},
    intent,
    tier: 'minimal_patch',
    ...over,
  };
}

function stub(handlers: { recover?: unknown; diagnose?: unknown; propose?: unknown; certify?: unknown }): StructuredCompleter {
  return {
    label: 'stub',
    lastError: null,
    async completeStructured<T extends Record<string, unknown>>(args: { system: string }): Promise<T | null> {
      const s = args.system.toLowerCase();
      if (s.includes('recover declared output')) return (handlers.recover ?? null) as T | null;
      if (s.includes('failure diagnostician')) return (handlers.diagnose ?? { rootCause: 'upstream produced no address' }) as T | null;
      if (s.includes('repair a workflow graph')) return (handlers.propose ?? null) as T | null;
      if (s.includes('intent-preservation judge')) return (handlers.certify ?? null) as T | null;
      return null;
    },
  };
}

describe('WorkflowSelfHealService', () => {
  it('W5.0: recovers a declared key from the node\'s own output (no dead run)', async () => {
    const res = await svc.heal(baseInput({ completer: stub({ recover: { values: { location: 'Paris, France' }, missing: [] } }) }));
    expect(res.outcome).toBe('output_fixed');
    if (res.outcome === 'output_fixed') expect(res.output.location).toBe('Paris, France');
  });

  it('R3: never fabricates a missing value — escalates instead', async () => {
    const res = await svc.heal(baseInput({
      completer: stub({ recover: { values: {}, missing: ['location'] }, propose: null }),
    }));
    expect(res.outcome).toBe('escalate');
    if (res.outcome === 'escalate') expect(res.diagnosis).toBeTruthy();
  });

  it('R6: no model → escalate, never guess', async () => {
    const res = await svc.heal(baseInput({ completer: null }));
    expect(res.outcome).toBe('escalate');
  });

  it('R1: rejects a structural patch the intent judge will not certify', async () => {
    const patchNodes = graph().nodes;
    const res = await svc.heal(baseInput({
      completer: stub({
        recover: null,
        propose: { nodes: patchNodes, grounding: 'rerouted to a geocoder' },
        certify: { preservesIntent: false, grounded: true, reason: 'changes the goal' },
      }),
    }));
    expect(res.outcome).toBe('escalate');
  });

  it('R1: rejects a patch that drops/renames a node (shape change)', async () => {
    const fewer = [graph().nodes[1]!]; // dropped the trigger
    const res = await svc.heal(baseInput({
      completer: stub({ recover: null, propose: { nodes: fewer, grounding: 'x' }, certify: { preservesIntent: true, grounded: true } }),
    }));
    expect(res.outcome).toBe('escalate');
  });

  it('returns a certified repair plan; policy is intentionally outside the planner', async () => {
    const patched = graph().nodes.map((n) => n.id === 'qualify' ? { ...n, config: { ...n.config, prompt: 'Find the location; if absent, geocode from the company website.' } } : n);
    const res = await svc.heal(baseInput({
      completer: stub({ recover: null, propose: { nodes: patched, grounding: 'error shows missing address; added geocode fallback' }, certify: { preservesIntent: true, grounded: true } }),
    }));
    expect(res.outcome).toBe('graph_repair');
  });

  it('records the minimal tier and resume target on a certified repair plan', async () => {
    const patched = graph().nodes.map((n) => n.id === 'qualify' ? { ...n, config: { ...n.config, prompt: 'Find the location; if absent, geocode from the company website.' } } : n);
    const res = await svc.heal(baseInput({
      completer: stub({ recover: null, propose: { nodes: patched, grounding: 'added geocode fallback' }, certify: { preservesIntent: true, grounded: true } }),
    }));
    expect(res.outcome).toBe('graph_repair');
    if (res.outcome === 'graph_repair') {
      expect(res.tier).toBe('minimal_patch');
      expect(res.resumeNodeId).toBe('qualify');
    }
  });

  it('makes the orchestrator deep planner the PRIMARY repair — invoked first, any tier, can rearrange', async () => {
    const replanned = graph().nodes.map((n) => n.id === 'qualify' ? { ...n, config: { ...n.config, agentId: 'a2' } } : n);
    let deepCalled = false;
    const res = await svc.heal(baseInput({
      tier: 'minimal_patch', // even at the cheap tier, the orchestrator leads
      resources: { agents: [{ id: 'a2', role: 'researcher', status: 'connected' }] },
      // The single-shot structured planner is a FALLBACK and must not even be reached.
      completer: stub({ recover: null, propose: { cannotRepair: true }, certify: { preservesIntent: true, grounded: true } }),
      deepPlan: async () => {
        deepCalled = true;
        return {
          nodes: replanned,
          edges: graph().edges,
          resumeNodeId: 'qualify',
          grounding: 'rerouted to connected agent a2',
          preservesIntent: true,
          grounded: true,
        };
      },
    }));
    expect(deepCalled).toBe(true);
    expect(res.outcome).toBe('graph_repair');
    if (res.outcome === 'graph_repair') {
      expect(res.tier).toBe('rebuild'); // the orchestrator path resolves to rebuild
      expect(res.resumeNodeId).toBe('qualify');
    }
  });

  it('falls back to the single-shot structured patch only when no orchestrator is wired', async () => {
    const patched = graph().nodes.map((n) => n.id === 'qualify' ? { ...n, config: { ...n.config, prompt: 'Find the location; if absent, geocode.' } } : n);
    const res = await svc.heal(baseInput({
      tier: 'minimal_patch',
      completer: stub({ recover: null, propose: { nodes: patched, grounding: 'added geocode fallback' }, certify: { preservesIntent: true, grounded: true } }),
      // no deepPlan → structured fallback path
    }));
    expect(res.outcome).toBe('graph_repair');
  });

  it('still certifies a deep-planner graph — agency never bypasses the intent gate', async () => {
    const replanned = graph().nodes.map((n) => n.id === 'qualify' ? { ...n, config: { ...n.config, agentId: 'a2' } } : n);
    const res = await svc.heal(baseInput({
      tier: 'rebuild',
      completer: stub({ recover: null, propose: { cannotRepair: true }, certify: null }),
      deepPlan: async () => ({
        nodes: replanned,
        edges: graph().edges,
        resumeNodeId: 'qualify',
        grounding: 'rerouted the unresolved step to an available agent',
        preservesIntent: true,
        grounded: true,
      }),
    }));
    expect(res.outcome).toBe('graph_repair');
  });

  it('allows tier 3 to rebuild only the unresolved graph frontier', async () => {
    const replacement = { ...graph().nodes[1]!, id: 'qualify-v2', title: 'Rebuilt qualifier' };
    const res = await svc.heal(baseInput({
      tier: 'rebuild',
      immutableNodeIds: ['trigger'],
      completer: stub({
        recover: null,
        propose: {
          nodes: [graph().nodes[0]!, replacement],
          edges: [{ id: 'e2', source: 'trigger', target: 'qualify-v2' }],
          resumeNodeId: 'qualify-v2',
          grounding: 'the failed node has an invalid reference; it is replaced with an equivalent unresolved step',
        },
        certify: { preservesIntent: true, grounded: true },
      }),
    }));
    expect(res).toMatchObject({ outcome: 'graph_repair', tier: 'rebuild', resumeNodeId: 'qualify-v2' });
  });
});
