import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { buildNodeProcessBriefing } from '../../src/engine/WorkflowEngine.js';

/**
 * The PROCESS BRIEFING is the architecture that lets an agent inside a workflow
 * node understand the process it is in — derived from the live graph, not prose.
 */
function graph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'fetch', type: 'agent_task', title: 'Fetch AI articles', position: { x: 0, y: 0 }, config: { kind: 'agent_task', capabilityTags: [], prompt: 'fetch', inputKeys: [], outputKeys: ['articles'] } },
      { id: 'rank', type: 'agent_task', title: 'Rank and write digest', position: { x: 1, y: 0 }, config: { kind: 'agent_task', capabilityTags: [], prompt: 'rank', inputKeys: ['articles'], outputKeys: ['passed', 'articleCount', 'body'] } },
      { id: 'send', type: 'integration', title: 'Send digest email', position: { x: 2, y: 0 }, config: { kind: 'integration', connectorId: 'agentmail', operationId: 'send', mapping: {}, outputKeys: [] } as never },
    ],
    edges: [
      { id: 'e1', source: 'fetch', target: 'rank' },
      { id: 'e2', source: 'rank', target: 'send', type: 'condition', condition: 'passed === true' },
    ],
  };
}

describe('buildNodeProcessBriefing', () => {
  it('tells the node where it sits — upstream feeders and downstream consumers', () => {
    const g = graph();
    const rank = g.nodes.find((n) => n.id === 'rank')!;
    const briefing = buildNodeProcessBriefing(g, rank, rank.config as { outputKeys?: string[] });

    expect(briefing).toContain('PROCESS BRIEFING');
    expect(briefing).toContain('YOUR STEP: "Rank and write digest"');
    // Upstream provenance: where the input came from and what it carried.
    expect(briefing).toContain('"Fetch AI articles" → articles');
    // Downstream consumer + the exact branch condition the run routes on.
    expect(briefing).toContain('"Send digest email" — runs only when: passed === true');
  });

  it('emits a typed output contract with a concrete JSON example and flags the branch key', () => {
    const g = graph();
    const rank = g.nodes.find((n) => n.id === 'rank')!;
    const briefing = buildNodeProcessBriefing(g, rank, rank.config as { outputKeys?: string[] });

    // Types are inferred from key names: boolean / number / string — with examples.
    expect(briefing).toContain('"passed": false');
    expect(briefing).toMatch(/"passed": false.*boolean/);
    expect(briefing).toContain('"articleCount": 0');
    expect(briefing).toMatch(/"articleCount": 0.*number/);
    expect(briefing).toContain('"body": "…"');
    // The key a downstream edge branches on is called out explicitly.
    expect(briefing).toMatch(/"passed".*BRANCHES on this/);
    // Flow rules that keep the run alive.
    expect(briefing).toContain('Return EVERY key above on EVERY run');
    expect(briefing).toContain('emitting the empty-but-complete contract IS success');
  });

  it('surfaces the workflow end-goal from the declared output contract', () => {
    const g = graph();
    g.outputContract = { fields: [{ key: 'sent', type: 'boolean', description: 'whether the digest email went out' }] };
    const rank = g.nodes.find((n) => n.id === 'rank')!;
    const briefing = buildNodeProcessBriefing(g, rank, rank.config as { outputKeys?: string[] });
    expect(briefing).toContain("THE WORKFLOW'S GOAL: produce → sent (whether the digest email went out)");
  });

  it('infers array types for collection-shaped keys', () => {
    const g = graph();
    const fetch = g.nodes.find((n) => n.id === 'fetch')!;
    const briefing = buildNodeProcessBriefing(g, fetch, fetch.config as { outputKeys?: string[] });
    expect(briefing).toContain('"articles": []');
    expect(briefing).toMatch(/"articles": \[\].*array/);
    // No upstream → it's fed by the trigger.
    expect(briefing).toContain('FEEDS INTO YOU: the workflow trigger input.');
  });
});
