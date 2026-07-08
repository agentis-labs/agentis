/**
 * repairGraph — deterministic structural repair (10X-CREATION Milestone 1).
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { repairGraph } from '../../src/services/agentisToolHandlers/build.js';
import { validateWorkflowGraph } from '../../src/engine/validateGraph.js';

const N = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id, type: kind, title: id, position: { x: 0, y: 0 }, config: { kind, ...extra },
});
const E = (s: string, t: string) => ({ id: `e_${s}_${t}`, source: s, target: t });
const graph = (nodes: unknown[], edges: unknown[]): WorkflowGraph =>
  ({ version: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } } as unknown as WorkflowGraph);

const noInventory = { configuredCredentials: [] as Array<{ id: string; integrationSlug: string }> };

describe('repairGraph', () => {
  it('adds a delivery integration node (Rule 3/10) when delivery is requested but missing', () => {
    const g = graph(
      [N('t', 'trigger', { triggerType: 'manual' }), N('a', 'agent_task'), N('o', 'return_output')],
      [E('t', 'a'), E('a', 'o')],
    );
    const { graph: out, repairs } = repairGraph(g, { requiredIntegrations: ['gmail'] }, noInventory);
    const integration = out.nodes.find((n) => (n.config as { integrationId?: string }).integrationId === 'gmail');
    expect(integration).toBeTruthy();
    // Spliced before the terminal: agent → gmail → return_output.
    expect(out.edges.some((e) => e.source === integration!.id && e.target === 'o')).toBe(true);
    expect(repairs.some((r) => r.kind === 'delivery_node_added' && r.rule === 3)).toBe(true);
  });

  it('does not duplicate a delivery node that already exists', () => {
    const g = graph(
      [N('t', 'trigger'), N('i', 'integration', { integrationId: 'gmail' }), N('o', 'return_output')],
      [E('t', 'i'), E('i', 'o')],
    );
    const { repairs } = repairGraph(g, { requiredIntegrations: ['gmail'] }, noInventory);
    expect(repairs.some((r) => r.kind === 'delivery_node_added')).toBe(false);
  });

  it('adds workflow_store read+write for recurring (cron) workflows (Rule 13)', () => {
    const g = graph(
      [N('t', 'trigger', { triggerType: 'cron' }), N('a', 'agent_task', { prompt: 'Summarize', agentRole: 'researcher' }), N('o', 'return_output')],
      [E('t', 'a'), E('a', 'o')],
    );
    const { graph: out, repairs } = repairGraph(g, { requiredIntegrations: [], triggerType: 'cron' }, noInventory);
    const stores = out.nodes.filter((n) => (n.config as { kind?: string }).kind === 'workflow_store');
    expect(stores).toHaveLength(2); // read after trigger + write before terminal
    expect(repairs.filter((r) => r.kind === 'recurring_state_added')).toHaveLength(2);
    // Read is wired off the trigger; write feeds the terminal.
    expect(out.edges.some((e) => e.source === 't' && e.target === 'state_read')).toBe(true);
    expect(out.edges.some((e) => e.source === 'state_write' && e.target === 'o')).toBe(true);
    // Every injected op MUST be one the engine actually executes — a `read`/`write`
    // op (the old bug) takes the whole recurring workflow down at run time with
    // "workflow_store: unknown op". Assert against the engine's supported set.
    const VALID_OPS = new Set(['get', 'set', 'delete', 'increment', 'append', 'get_all']);
    for (const store of stores) {
      for (const op of (store.config as { operations: Array<{ op: string }> }).operations) {
        expect(VALID_OPS.has(op.op)).toBe(true);
      }
    }
    // And the whole repaired graph must pass the strict boundary validator, which
    // now rejects unknown store ops. A `read`/`write` regression would throw here.
    expect(() => validateWorkflowGraph(out)).not.toThrow();
  });

  it('does not add state nodes for a one-shot (manual) workflow', () => {
    const g = graph([N('t', 'trigger', { triggerType: 'manual' }), N('o', 'return_output')], [E('t', 'o')]);
    const { repairs } = repairGraph(g, { requiredIntegrations: [], triggerType: 'manual' }, noInventory);
    expect(repairs.some((r) => r.kind === 'recurring_state_added')).toBe(false);
  });

  it('breaks a cycle by cutting the back-edge (weak-model graph becomes a valid DAG)', () => {
    // t → a → o, plus a back-edge o → a that closes a loop.
    const g = graph(
      [
        N('t', 'trigger', { triggerType: 'manual' }),
        N('a', 'agent_task', { agentRole: 'researcher', prompt: 'do the thing', inputKeys: ['t'], outputKeys: ['r'] }),
        N('o', 'return_output', { renderAs: 'json' }),
      ],
      [E('t', 'a'), E('a', 'o'), E('o', 'a')],
    );
    const { graph: out, repairs } = repairGraph(g, { requiredIntegrations: [] }, noInventory);
    expect(out.edges.some((e) => e.source === 'o' && e.target === 'a')).toBe(false);
    expect(out.edges.some((e) => e.source === 'a' && e.target === 'o')).toBe(true);
    expect(repairs.some((r) => r.kind === 'cycle_broken')).toBe(true);
    // The repaired graph validates (no cycle).
    expect(() => validateWorkflowGraph(out)).not.toThrow();
  });

  it('prunes edges that reference a non-existent node', () => {
    const g = graph(
      [N('t', 'trigger', { triggerType: 'manual' }), N('o', 'return_output')],
      [E('t', 'o'), E('t', 'ghost')],
    );
    const { graph: out, repairs } = repairGraph(g, { requiredIntegrations: [] }, noInventory);
    expect(out.edges.some((e) => e.target === 'ghost')).toBe(false);
    expect(repairs.some((r) => r.kind === 'dangling_edge_removed')).toBe(true);
    expect(() => validateWorkflowGraph(out)).not.toThrow();
  });
});
