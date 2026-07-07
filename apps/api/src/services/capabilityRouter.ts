/**
 * CapabilityRouter — resolves a Capability URN into a concrete execution plan
 * (RADICAL-EFFICIENCY-CHAT-CAPABILITY-PLANE §2, "Dynamic Tool & Node Routing").
 *
 * The router NEVER re-implements execution. It maps a URN onto an existing
 * registered platform tool + arguments, so `capability.invoke` delegates through
 * the exact same handlers chat/workflow/MCP already trust (one door):
 *
 *   workflow  → agentis.workflow.run
 *   node      → agentis.run.replay (replay-from-node from the workflow's latest run)
 *   phase     → agentis.run.replay (from the phase's entry node)
 *   agent     → agentis.agent.dispatch
 *   mcp_tool  → agentis.mcp.call
 *   app       → the app's sole workflow (or guidance to disambiguate)
 *
 * When a target cannot be executed as-is (a deep node with no prior run to seed
 * upstream state, an app with several workflows), the router returns structured
 * GUIDANCE with the concrete next URNs/tools — never a silent wrong action.
 */

import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import type { Logger } from '../logger.js';
import {
  parseCapabilityUrn,
  workflowUrn,
  mcpBridgeIdFromUrn,
  type CapabilityKind,
  type CapabilityUrn,
} from './capabilityUrn.js';

export interface InvokePlan {
  toolId: string;
  arguments: Record<string, unknown>;
}

export type InvokeResolution =
  | { ok: true; targetKind: CapabilityKind; plan: InvokePlan; note?: string }
  | { ok: false; guidance: string; alternatives?: Array<{ urn?: string; toolId?: string; why: string }> };

export interface CapabilityRouterDeps {
  db: AgentisSqliteDb;
  logger?: Logger;
}

export class CapabilityRouter {
  constructor(private readonly deps: CapabilityRouterDeps) {}

  /**
   * Resolve a URN + caller input into either a delegation plan or guidance.
   * `input` is the caller's payload (workflow/agent inputs, or `{ sourceRunId }`
   * to pin a specific run for a node/phase replay).
   */
  resolveInvoke(workspaceId: string, urnRaw: string, input: Record<string, unknown>): InvokeResolution {
    const urn = parseCapabilityUrn(urnRaw);
    switch (urn.kind) {
      case 'workflow':
        return this.#planWorkflow(workspaceId, urn, input);
      case 'app':
        return this.#planApp(workspaceId, urn, input);
      case 'node':
        return this.#planNode(workspaceId, urn, input);
      case 'phase':
        return this.#planPhase(workspaceId, urn, input);
      case 'agent':
        return this.#planAgent(workspaceId, urn, input);
      case 'mcp_tool':
        return { ok: true, targetKind: 'mcp_tool', plan: { toolId: 'agentis.mcp.call', arguments: { tool: mcpBridgeIdFromUrn(urn), arguments: input } } };
      case 'skill':
        return { ok: false, guidance: `skill:${urn.skillId} is a building block, not a standalone run. Wire it into a workflow (skill_task/extension_task) or inspect it with agentis.skill.inspect.` };
      case 'collection':
        return { ok: false, guidance: `coll:${urn.appId}/${urn.collection} is data, not an action. Read it with agentis.data.query or write with agentis.data.insert/update.` };
      default:
        return { ok: false, guidance: `capability urn kind '${urn.kind}' is not invocable.` };
    }
  }

  // ── planners ─────────────────────────────────────────────────────────────

  #planWorkflow(workspaceId: string, urn: CapabilityUrn, input: Record<string, unknown>): InvokeResolution {
    const wf = this.#workflow(workspaceId, urn.workflowId!);
    if (!wf) return { ok: false, guidance: `workflow ${urn.workflowId} not found in this workspace.` };
    return { ok: true, targetKind: 'workflow', plan: { toolId: 'agentis.workflow.run', arguments: { workflowId: wf.id, inputs: input } } };
  }

  #planApp(workspaceId: string, urn: CapabilityUrn, input: Record<string, unknown>): InvokeResolution {
    const wfs = this.deps.db
      .select({ id: schema.workflows.id, title: schema.workflows.title })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.appId, urn.appId!), eq(schema.workflows.workspaceId, workspaceId)))
      .all();
    if (wfs.length === 0) return { ok: false, guidance: `app ${urn.appId} has no workflows to run.` };
    if (wfs.length === 1) {
      return { ok: true, targetKind: 'app', plan: { toolId: 'agentis.workflow.run', arguments: { workflowId: wfs[0]!.id, inputs: input } }, note: `app resolved to its sole workflow "${wfs[0]!.title}".` };
    }
    return {
      ok: false,
      guidance: `app ${urn.appId} owns ${wfs.length} workflows — target one explicitly.`,
      alternatives: wfs.map((w) => ({ urn: workflowUrn(w.id, urn.appId), why: `run "${w.title}"` })),
    };
  }

  #planNode(workspaceId: string, urn: CapabilityUrn, input: Record<string, unknown>): InvokeResolution {
    const wf = this.#workflow(workspaceId, urn.workflowId!);
    if (!wf) return { ok: false, guidance: `workflow ${urn.workflowId} not found in this workspace.` };
    const graph = wf.graph as WorkflowGraph | null;
    const node = graph?.nodes?.find((n) => n.id === urn.nodeId);
    if (!node) return { ok: false, guidance: `node ${urn.nodeId} is not in workflow ${urn.workflowId}.` };
    return this.#planReplayFrom(workspaceId, urn, input, urn.nodeId!, `node "${node.title || node.id}"`);
  }

  #planPhase(workspaceId: string, urn: CapabilityUrn, input: Record<string, unknown>): InvokeResolution {
    const wf = this.#workflow(workspaceId, urn.workflowId!);
    if (!wf) return { ok: false, guidance: `workflow ${urn.workflowId} not found in this workspace.` };
    const graph = wf.graph as WorkflowGraph | null;
    const phase = graph?.phases?.find((p) => p.id === urn.phaseId);
    if (!phase) return { ok: false, guidance: `phase ${urn.phaseId} is not in workflow ${urn.workflowId}.` };
    const entry = phaseEntryNode(graph!, phase.nodeIds);
    if (!entry) return { ok: false, guidance: `phase ${urn.phaseId} has no runnable nodes.` };
    return this.#planReplayFrom(workspaceId, urn, input, entry, `phase "${phase.name}" (from node ${entry})`);
  }

  /** Node/phase execution rides replay-from-node, which needs a run to seed upstream state. */
  #planReplayFrom(
    workspaceId: string,
    urn: CapabilityUrn,
    input: Record<string, unknown>,
    targetNodeId: string,
    label: string,
  ): InvokeResolution {
    const sourceRunId = typeof input.sourceRunId === 'string' && input.sourceRunId.trim()
      ? input.sourceRunId.trim()
      : this.#latestRunId(workspaceId, urn.workflowId!);
    if (!sourceRunId) {
      return {
        ok: false,
        guidance: `Cannot run ${label} in isolation: a mid-graph node needs the upstream outputs a full run produces. Run the whole workflow once first, then target this node.`,
        alternatives: [
          { urn: workflowUrn(urn.workflowId!, urn.appId), why: 'run the full workflow to produce upstream state' },
          { toolId: 'agentis.workflow.dry_run', why: 'zero-cost proof of the data flow before a real run' },
        ],
      };
    }
    return {
      ok: true,
      targetKind: urn.kind,
      plan: {
        toolId: 'agentis.run.replay',
        arguments: { sourceRunId, mode: 'replay-from-node', targetNodeId },
      },
      note: `replaying ${label} from run ${sourceRunId} (reuses healthy upstream work).`,
    };
  }

  #planAgent(workspaceId: string, urn: CapabilityUrn, input: Record<string, unknown>): InvokeResolution {
    const agent = this.deps.db
      .select({ id: schema.agents.id, name: schema.agents.name })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, urn.agentId!), eq(schema.agents.workspaceId, workspaceId)))
      .get();
    if (!agent) return { ok: false, guidance: `agent ${urn.agentId} not found in this workspace.` };
    const task = firstString(input.task, input.message, input.prompt);
    if (!task) {
      return { ok: false, guidance: `To converse with "${agent.name}", pass a task/message. Example: capability.invoke("${urn.raw}", { task: "..." }).` };
    }
    const args: Record<string, unknown> = { agentId: agent.id, task };
    if (input.input && typeof input.input === 'object') args.input = input.input;
    return { ok: true, targetKind: 'agent', plan: { toolId: 'agentis.agent.dispatch', arguments: args } };
  }

  // ── db helpers ───────────────────────────────────────────────────────────

  #workflow(workspaceId: string, workflowId: string) {
    return this.deps.db
      .select({ id: schema.workflows.id, graph: schema.workflows.graph, appId: schema.workflows.appId })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, workspaceId)))
      .get();
  }

  #latestRunId(workspaceId: string, workflowId: string): string | null {
    const run = this.deps.db
      .select({ id: schema.workflowRuns.id })
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workflowId, workflowId), eq(schema.workflowRuns.workspaceId, workspaceId)))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(1)
      .get();
    return run?.id ?? null;
  }
}

/**
 * The phase's entry node = a phase member with no incoming edge from another
 * member (i.e. the earliest to become ready). Replaying from it re-runs the
 * phase and everything downstream. Falls back to the first declared member.
 */
export function phaseEntryNode(graph: WorkflowGraph, nodeIds: string[]): string | null {
  if (nodeIds.length === 0) return null;
  const members = new Set(nodeIds);
  const hasInternalPredecessor = new Set<string>();
  for (const edge of graph.edges ?? []) {
    if (members.has(edge.source) && members.has(edge.target)) hasInternalPredecessor.add(edge.target);
  }
  for (const id of nodeIds) {
    if (!hasInternalPredecessor.has(id)) return id;
  }
  return nodeIds[0] ?? null;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
