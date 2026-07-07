/**
 * Capability plane meta-tools (RADICAL-EFFICIENCY §2 / COMMAND-MODEL Layer A).
 *
 * Three stable tools replace the unbounded per-workflow tool explosion and give
 * chat/agent loops codex-class REACH: know-of-everything, hold almost nothing,
 * invoke anything down to a single node — including apps, specialists, and MCP
 * tools as live chat tools (not fixed workflow nodes).
 *
 *   agentis.capability.search(intent)      → ranked URN atoms (find by meaning)
 *   agentis.capability.load(urns)          → page in the full typed contract
 *   agentis.capability.invoke(urn, input)  → run it (delegates to the real tool)
 *
 * invoke resolves the URN via CapabilityRouter and DELEGATES through the same
 * registry every other transport uses — one door, no duplicated execution logic.
 */

import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolContext, WorkflowGraph } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { CapabilityRouter } from '../capabilityRouter.js';
import { parseCapabilityUrn } from '../capabilityUrn.js';
import type { CapabilityKind } from '../capabilityUrn.js';
import { resolveCommandScope } from '../commandScope.js';

const CAPABILITY_KINDS: CapabilityKind[] = ['app', 'workflow', 'node', 'phase', 'agent', 'skill', 'mcp_tool', 'collection'];

export function registerCapabilityPlaneTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const router = new CapabilityRouter({ db: deps.db, logger: deps.logger });

  registry.registerMany(
    [
      {
        definition: {
          id: 'agentis.capability.search',
          family: 'inspect',
          mcpExposed: true,
          description:
            'Find the exact capability to use by MEANING — apps, workflows, individual nodes/phases, specialist agents, skills, and MCP tools — without holding the whole workspace in context. Returns ranked URNs you pass to agentis.capability.load / agentis.capability.invoke. Use this FIRST whenever the operator refers to something you do not already have in hand.',
          inputSchema: {
            type: 'object',
            properties: {
              intent: { type: 'string', description: 'What you are trying to find or do, in plain language.' },
              kind: { type: 'string', description: 'Optional filter.', enum: CAPABILITY_KINDS },
              limit: { type: 'number', description: 'Max results (default 8, max 25).' },
            },
            required: ['intent'],
          },
          mutating: false,
        },
        handler: async (args, ctx) => {
          if (!deps.capabilityIndex) return { results: [], note: 'capability index unavailable' };
          const intent = String(args.intent ?? '');
          const kind = typeof args.kind === 'string' && CAPABILITY_KINDS.includes(args.kind as CapabilityKind)
            ? (args.kind as CapabilityKind) : undefined;
          const limit = typeof args.limit === 'number' ? args.limit : undefined;
          // Rank the caller's own domain first (soft boost) when it manages one.
          let scope: { appIds?: string[]; workflowIds?: string[] } | undefined;
          if (ctx.agentId) {
            try {
              const s = resolveCommandScope(deps.db, ctx.workspaceId, ctx.agentId);
              if (s.kind !== 'workspace' && (s.appIds.length > 0 || s.workflowIds.length > 0)) {
                scope = { appIds: s.appIds, workflowIds: s.workflowIds };
              }
            } catch { /* best-effort — search still works globally */ }
          }
          const results = await deps.capabilityIndex.search(ctx.workspaceId, intent, {
            ...(kind ? { kind } : {}),
            ...(limit ? { limit } : {}),
            ...(scope ? { scope } : {}),
          });
          return {
            count: results.length,
            results: results.map((r) => ({ urn: r.urn, kind: r.kind, title: r.title, purpose: r.purpose, ...(r.inputDigest ? { inputDigest: r.inputDigest } : {}), score: r.score })),
            next: 'agentis.capability.invoke(urn, input) to run one — down to a single node:<id> or phase:<id>.',
          };
        },
      },
      {
        definition: {
          id: 'agentis.capability.load',
          family: 'inspect',
          mcpExposed: true,
          description:
            'Page in the FULL typed contract for capability URNs you selected from agentis.capability.search — input fields, node/phase structure, agent identity — so you can invoke them correctly. Load only what the immediate step needs; drop it after.',
          inputSchema: {
            type: 'object',
            properties: {
              urns: { type: 'array', items: { type: 'string' }, description: 'URNs from capability.search.' },
              urn: { type: 'string', description: 'A single URN (alternative to urns).' },
            },
            required: [],
          },
          mutating: false,
        },
        handler: async (args, ctx) => {
          const urns = Array.isArray(args.urns) ? (args.urns as unknown[]).map(String)
            : typeof args.urn === 'string' ? [args.urn] : [];
          if (urns.length === 0) return { loaded: [], note: 'pass urns[] or urn from capability.search.' };
          const loaded = urns.slice(0, 8).map((u) => hydrate(deps, ctx.workspaceId, u));
          return { loaded };
        },
      },
      {
        definition: {
          id: 'agentis.capability.invoke',
          family: 'run',
          mcpExposed: true,
          description:
            'Run a capability by URN — a whole workflow (wf:<id>), a single deep node (app:<id>/wf:<id>/node:<id>), an execution phase (.../phase:<id>), a specialist agent (agent:<id>, to hand off or converse), or an MCP tool (mcp:<slug>__<tool>). Pass input as the trigger/agent/tool payload; for a node/phase pass sourceRunId to pin which run to replay from. Returns the routed result, or grounded guidance when the target needs a prior run or disambiguation.',
          inputSchema: {
            type: 'object',
            properties: {
              urn: { type: 'string', description: 'Capability URN from capability.search.' },
              input: { type: 'object', description: 'Payload: workflow trigger inputs, agent { task }, or MCP tool arguments.' },
              sourceRunId: { type: 'string', description: 'For node/phase: the run to replay from (defaults to the latest run of the workflow).' },
            },
            required: ['urn'],
          },
          mutating: true,
        },
        handler: async (args, ctx) => {
          const urn = String(args.urn ?? '');
          const input: Record<string, unknown> = args.input && typeof args.input === 'object' && !Array.isArray(args.input)
            ? { ...(args.input as Record<string, unknown>) } : {};
          if (typeof args.sourceRunId === 'string' && args.sourceRunId.trim()) input.sourceRunId = args.sourceRunId.trim();
          const resolution = router.resolveInvoke(ctx.workspaceId, urn, input);
          if (!resolution.ok) {
            return { invoked: false, urn, guidance: resolution.guidance, ...(resolution.alternatives ? { alternatives: resolution.alternatives } : {}) };
          }
          const outcome = await registry.execute(
            { id: randomUUID(), toolId: resolution.plan.toolId, arguments: resolution.plan.arguments },
            ctx,
          );
          if (!outcome.ok) {
            return { invoked: false, urn, routedTo: resolution.plan.toolId, error: `${outcome.errorCode}: ${outcome.errorMessage}` };
          }
          return {
            invoked: true,
            urn,
            targetKind: resolution.targetKind,
            routedTo: resolution.plan.toolId,
            ...(resolution.note ? { note: resolution.note } : {}),
            result: outcome.output,
          };
        },
      },
    ],
    { defaultMcpExposed: true },
  );
}

/** Bounded, typed detail for one URN — the "page-in" payload. */
function hydrate(deps: ToolHandlerDeps, workspaceId: string, urnRaw: string): Record<string, unknown> {
  let urn;
  try {
    urn = parseCapabilityUrn(urnRaw);
  } catch (err) {
    return { urn: urnRaw, error: (err as Error).message };
  }
  const db = deps.db;
  switch (urn.kind) {
    case 'workflow':
    case 'node':
    case 'phase': {
      const wf = db
        .select({ id: schema.workflows.id, title: schema.workflows.title, description: schema.workflows.description, graph: schema.workflows.graph, appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, urn.workflowId!), eq(schema.workflows.workspaceId, workspaceId)))
        .get();
      if (!wf) return { urn: urnRaw, error: 'workflow not found' };
      const graph = (wf.graph ?? null) as WorkflowGraph | null;
      if (urn.kind === 'node') {
        const node = graph?.nodes?.find((n) => n.id === urn.nodeId);
        if (!node) return { urn: urnRaw, error: 'node not found' };
        const feeders = (graph?.edges ?? []).filter((e) => e.target === node.id).map((e) => e.source);
        return { urn: urnRaw, kind: 'node', workflow: wf.title, node: { id: node.id, type: node.type, title: node.title, feeders }, invokeHint: 'capability.invoke(urn, input) — replays from this node using the workflow\'s latest run.' };
      }
      if (urn.kind === 'phase') {
        const phase = graph?.phases?.find((p) => p.id === urn.phaseId);
        if (!phase) return { urn: urnRaw, error: 'phase not found' };
        return { urn: urnRaw, kind: 'phase', workflow: wf.title, phase: { id: phase.id, name: phase.name, description: phase.description ?? null, nodeIds: phase.nodeIds } };
      }
      return {
        urn: urnRaw,
        kind: 'workflow',
        title: wf.title,
        description: wf.description ?? null,
        inputContract: graph?.inputContract?.fields ?? [],
        nodes: (graph?.nodes ?? []).map((n) => ({ id: n.id, type: n.type, title: n.title })).slice(0, 60),
        phases: (graph?.phases ?? []).map((p) => ({ id: p.id, name: p.name })),
      };
    }
    case 'agent': {
      const a = db
        .select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, status: schema.agents.status, adapterType: schema.agents.adapterType, instructions: schema.agents.instructions, capabilityTags: schema.agents.capabilityTags })
        .from(schema.agents)
        .where(and(eq(schema.agents.id, urn.agentId!), eq(schema.agents.workspaceId, workspaceId)))
        .get();
      if (!a) return { urn: urnRaw, error: 'agent not found' };
      return { urn: urnRaw, kind: 'agent', name: a.name, role: a.role, status: a.status, adapterType: a.adapterType, capabilityTags: a.capabilityTags, instructions: (a.instructions ?? '').slice(0, 400), invokeHint: 'capability.invoke(urn, { task }) to hand off / converse.' };
    }
    case 'app': {
      const app = db.select({ id: schema.apps.id, name: schema.apps.name, description: schema.apps.description }).from(schema.apps)
        .where(and(eq(schema.apps.id, urn.appId!), eq(schema.apps.workspaceId, workspaceId))).get();
      if (!app) return { urn: urnRaw, error: 'app not found' };
      const wfs = db.select({ id: schema.workflows.id, title: schema.workflows.title }).from(schema.workflows)
        .where(and(eq(schema.workflows.appId, urn.appId!), eq(schema.workflows.workspaceId, workspaceId))).all();
      return { urn: urnRaw, kind: 'app', name: app.name, description: app.description ?? null, workflows: wfs };
    }
    default:
      return { urn: urnRaw, kind: urn.kind, note: 'no extended detail for this kind.' };
  }
}

export type { AgentisToolContext };
