import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { normalizeGeneratedHalRequirements } from '../../src/services/agentisToolHandlers/build.js';

function graph(nodeConfig: Record<string, unknown>): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      {
        id: 'A',
        type: 'agent_task',
        title: 'Qualify Candidate',
        position: { x: 240, y: 0 },
        config: {
          kind: 'agent_task',
          prompt: 'Research the candidate and qualify whether the lead should proceed.',
          capabilityTags: [],
          inputKeys: [],
          outputKeys: ['result'],
          ...nodeConfig,
        },
      },
      { id: 'O', type: 'return_output', title: 'Return', position: { x: 480, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'O' }],
  } as WorkflowGraph;
}

function agentRequires(result: WorkflowGraph): Record<string, unknown> | undefined {
  return result.nodes.find((node) => node.id === 'A')?.config.requires as Record<string, unknown> | undefined;
}

describe('normalizeGeneratedHalRequirements', () => {
  it('removes accidental native-browser requirements from generic research tasks', () => {
    const result = normalizeGeneratedHalRequirements(graph({
      requires: { browser: true, terminal: true, unknown: true },
    }));

    expect(agentRequires(result)).toEqual({ terminal: true });
  });

  it('preserves explicit native browser control requirements', () => {
    const result = normalizeGeneratedHalRequirements(graph({
      prompt: 'Use a live browser runtime to click through the checkout flow and inspect the page state.',
      requires: { browser: true, computerUse: true },
    }));

    expect(agentRequires(result)).toEqual({ browser: true, computerUse: true });
  });

  it('strips browser from login/scrape intents — those belong to a Browser node', () => {
    const result = normalizeGeneratedHalRequirements(graph({
      prompt: 'Log into the careers website, fill in the search form, and scrape each candidate profile page.',
      requires: { browser: true },
    }));

    // No native-control phrasing → the requirement is dropped (use a browser node).
    expect(agentRequires(result)).toBeUndefined();
  });

  it('keeps an explicit "drive a browser" instruction', () => {
    const result = normalizeGeneratedHalRequirements(graph({
      prompt: 'Drive a browser to operate the legacy intranet that has no API.',
      requires: { browser: true },
    }));

    expect(agentRequires(result)).toEqual({ browser: true });
  });
});
