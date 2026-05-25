/**
 * Build tools — agent creates and patches workflows.
 *
 * Mutating; gated by the runtime policy engine in production deployments.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { RealtimeEventName, SkillManifest, WorkflowGraph, WorkflowGraphPatch, WorkflowNode } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { validateWorkflowGraph } from '../../engine/validateGraph.js';
import { PackagerService } from '../packager.js';
import { assembleCreationBrief, preflightAndEnrich, buildTeamRoster, planWorkflow, type CreationBrief, type WorkflowPlan } from '../creationPipeline.js';

export function registerBuildTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.workflow.create',
        family: 'build',
        description: 'Create a new workflow from a graph payload.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            graph: { type: 'object' },
          },
          required: ['name', 'graph'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: async (args, ctx) => {
        const id = randomUUID();
        const now = new Date().toISOString();
        const graph = args.graph as WorkflowGraph;
        deps.db
          .insert(schema.workflows)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            ambientId: ctx.ambientId ?? null,
            userId: ctx.userId,
            title: String(args.name),
            summary: args.description ? String(args.description) : null,
            graph,
            concurrencyOverflow: 'queue',
            createdAt: now,
            updatedAt: now,
          })
          .run();
        return { workflowId: id, title: String(args.name) };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.patch',
        family: 'build',
        description: 'Patch a workflow graph (replaces the graph atomically).',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            runId: { type: 'string' },
            patch: { type: 'object' },
            graph: { type: 'object' },
          },
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (args.runId && args.patch) {
          const run = deps.db
            .select()
            .from(schema.workflowRuns)
            .where(eq(schema.workflowRuns.id, String(args.runId)))
            .get();
          if (!run || run.workspaceId !== ctx.workspaceId) throw new Error(`run ${args.runId} not found`);
          const result = await deps.engine.applyGraphPatch({
            runId: run.id,
            patch: args.patch as WorkflowGraphPatch,
          });
          return { runId: run.id, patched: true, ...result };
        }

        if (!args.workflowId || !args.graph) {
          throw new Error('workflow.patch requires either runId+patch or workflowId+graph');
        }
        const wf = deps.db
          .select()
          .from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId)))
          .get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) {
          throw new Error(`workflow ${args.workflowId} not found`);
        }
        const graph = args.graph as WorkflowGraph;
        deps.db
          .update(schema.workflows)
          .set({ graph, updatedAt: new Date().toISOString() })
          .where(eq(schema.workflows.id, wf.id))
          .run();
        return { workflowId: wf.id, patched: true };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.cancel',
        family: 'run',
        description: 'Cancel a running workflow run.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const run = deps.db
          .select()
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, String(args.runId)))
          .get();
        if (!run || run.workspaceId !== ctx.workspaceId) throw new Error(`run ${args.runId} not found`);
        await deps.engine.cancelRun(run.id);
        return { runId: run.id, status: 'cancelled' };
      },
    },
    {
      definition: {
        id: 'agentis.build_workflow',
        family: 'build',
        description: 'Generate a workflow from natural language and stream canvas build events.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            title: { type: 'string' },
            workflowId: { type: 'string' },
          },
          required: ['description'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: async (args, ctx) => {
        const description = String(args.description ?? '').trim();
        if (!description) throw new Error('build_workflow requires description');
        return createWorkflowFromDescription(deps, {
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          userId: ctx.userId,
          agentId: ctx.agentId,
          runId: ctx.runId,
          description,
          title: args.title ? String(args.title) : undefined,
          workflowId: args.workflowId ? String(args.workflowId) : null,
          stream: true,
        });
      },
    },
    {
      definition: {
        id: 'agentis.plan_workflow',
        family: 'inspect',
        description: 'Decompose a workflow request into named, cost-estimated phases (Phase Cards) before building. Use for complex/enterprise requests so the operator can approve the plan first.',
        inputSchema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const description = String(args.description ?? '').trim();
        if (!description) throw new Error('plan_workflow requires description');
        const brief = await assembleCreationBrief(deps, ctx.workspaceId, ctx.agentId, description);
        const plan = planWorkflow(description, brief.classification);
        return {
          archetype: plan.archetype,
          phases: plan.phases,
          totalEstimatedCostCents: plan.totalEstimatedCostCents,
          missingDependencies: plan.missingDependencies,
          requiresConfirmation: plan.requiresConfirmation,
          question: plan.question,
          message: `Plan: ${plan.phases.length} phase(s), est. ${plan.totalEstimatedCostCents[0]}-${plan.totalEstimatedCostCents[1]}¢/run.`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.plan',
        family: 'inspect',
        description: 'Break a complex objective into executable steps.',
        inputSchema: { type: 'object', properties: { goal: { type: 'string' }, context: { type: 'string' } }, required: ['goal'] },
        mutating: false,
      },
      handler: async (args) => {
        const goal = String(args.goal ?? '').trim();
        return { goal, steps: buildPlan(goal, String(args.context ?? '')) };
      },
    },
    {
      definition: {
        id: 'agentis.evaluate',
        family: 'inspect',
        description: 'Evaluate an artifact against criteria.',
        inputSchema: { type: 'object', properties: { artifact: { type: 'string' }, criteria: { type: 'string' } }, required: ['artifact', 'criteria'] },
        mutating: false,
      },
      handler: async (args) => {
        const artifact = String(args.artifact ?? '');
        const criteria = String(args.criteria ?? '');
        const missing = ['correctness', 'completeness', 'clarity'].filter((term) => criteria.toLowerCase().includes(term) && !artifact.toLowerCase().includes(term));
        const score = Math.max(0.35, Math.min(0.95, artifact.length > 120 ? 0.78 : 0.62));
        return { score, criteria, reasoning: missing.length ? `Review ${missing.join(', ')} before shipping.` : 'No obvious structural gaps detected.', recommendations: missing };
      },
    },
    {
      definition: {
        id: 'agentis.reflect',
        family: 'inspect',
        description: 'Self-critique the current approach and recommend the next action.',
        inputSchema: { type: 'object', properties: { situation: { type: 'string' }, goal: { type: 'string' } }, required: ['situation', 'goal'] },
        mutating: false,
      },
      handler: async (args) => ({
        goal: String(args.goal ?? ''),
        critique: `Current situation: ${String(args.situation ?? '').slice(0, 500)}`,
        nextAction: 'Use platform tools for real state, reduce assumptions, and proceed with the smallest reversible action.',
      }),
    },
    {
      definition: {
        id: 'agentis.workflow.validate',
        family: 'build',
        description: 'Validate a graph against the engine’s static checks (cycles, dangling refs).',
        inputSchema: { type: 'object', properties: { graph: { type: 'object' } }, required: ['graph'] },
        mutating: false,
      },
      handler: async (args, _ctx) => {
        // Delegate to the existing validator. Imported lazily to keep the handler
        // file independent of engine wiring.
        const { validateWorkflowGraph } = await import('../../engine/validateGraph.js');
        try {
          validateWorkflowGraph(args.graph as WorkflowGraph);
          return { valid: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'invalid graph';
          return { valid: false, errorMessage: message };
        }
      },
    },
  ]);
}

export interface CreateWorkflowArgs {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  agentId?: string;
  runId?: string;
  description: string;
  title?: string;
  workflowId?: string | null;
  /** When true, animate the build (per-node canvas events + small delays). */
  stream?: boolean;
  /**
   * An approved (possibly operator-edited) plan. When present the graph is
   * assembled deterministically from its phases — one node per Phase Card —
   * instead of LLM/regex synthesis. This is what makes inline per-phase edits
   * round-trip: edit a card → rebuild from the plan.
   */
  plan?: WorkflowPlan;
}

/**
 * Shared workflow-creation core (ORCHESTRATOR-CREATION-10X). Used by the
 * `build_workflow` chat tool AND the `POST /v1/workflows/build` Builder Session
 * route: assemble the brief, synthesize (LLM → deterministic fallback), pre-flight
 * enrich, persist, and stream the live canvas build events.
 */
export async function createWorkflowFromDescription(deps: ToolHandlerDeps, args: CreateWorkflowArgs) {
  const description = args.description.trim();
  const title = String(args.title ?? titleFromDescription(description));
  const brief = await assembleCreationBrief(deps, args.workspaceId, args.agentId, description);
  // Plan-driven build: when the operator approved/edited a plan, assemble the
  // graph from its phases (deterministic, 1 node per Phase Card). Otherwise
  // synthesize (LLM → regex fallback).
  const rawGraph = args.plan && args.plan.phases.length > 0
    ? assembleGraphFromPlan(args.plan, description)
    : (await synthesizeWithLlm(description, deps, args.workspaceId, brief))
      ?? buildWorkflowDraft(description, deps, args.workspaceId);
  const preflight = preflightAndEnrich(rawGraph, brief.inventory);
  const graph = preflight.graph;
  const teamRoster = buildTeamRoster(graph, brief.inventory);
  validateWorkflowGraph(graph);

  const now = new Date().toISOString();
  const existingWorkflowId = args.workflowId ?? null;
  const workflowId = existingWorkflowId ?? randomUUID();
  const emptyGraph: WorkflowGraph = { ...graph, nodes: [], edges: [] };
  // When streaming, persist an empty graph first so nodes animate in; otherwise
  // persist the full graph in one shot.
  const initialGraph = args.stream ? emptyGraph : graph;
  if (existingWorkflowId) {
    const existing = deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, existingWorkflowId)).get();
    if (!existing || existing.workspaceId !== args.workspaceId) throw new Error(`workflow ${existingWorkflowId} not found`);
    deps.db.update(schema.workflows)
      .set({ title, summary: description, graph: initialGraph, updatedAt: now })
      .where(eq(schema.workflows.id, existing.id))
      .run();
  } else {
    deps.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      userId: args.userId,
      title,
      summary: description,
      graph: initialGraph,
      settings: {},
      concurrencyOverflow: 'queue',
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  const streamRunId = args.runId ?? `build_${workflowId}`;
  const pubCtx = { workspaceId: args.workspaceId, agentId: args.agentId, runId: streamRunId };
  publishCanvas(deps, pubCtx, REALTIME_EVENTS.AGENT_WORK_STEP, {
    workflowId, runId: streamRunId, agentId: args.agentId ?? null,
    description: `Building "${title}"`, step: 'build_start',
  });
  // §3/§9 — announce the cast specialist team before any node appears, so the
  // operator sees who's building (and who's offline) before the graph streams.
  if (teamRoster.length > 0) {
    publishCanvas(deps, pubCtx, REALTIME_EVENTS.WORKFLOW_TEAM_ROSTER, {
      workflowId, runId: streamRunId, agentId: args.agentId ?? null, roster: teamRoster,
    });
  }

  for (const node of graph.nodes) {
    if (args.stream) await sleep(120);
    publishCanvas(deps, pubCtx, REALTIME_EVENTS.CANVAS_NODE_PLACED, {
      workflowId, runId: streamRunId, agentId: args.agentId ?? null,
      node: { id: node.id, type: 'default', position: node.position, data: { label: node.title, kind: node.config.kind } },
      nodeLabel: node.title, reason: nodeReason(node),
    });
    publishCanvas(deps, pubCtx, REALTIME_EVENTS.AGENT_WORK_STEP, {
      workflowId, runId: streamRunId, agentId: args.agentId ?? null,
      description: `Added ${node.title}`, step: 'node_placed',
    });
  }

  for (const edge of graph.edges) {
    if (args.stream) await sleep(60);
    publishCanvas(deps, pubCtx, REALTIME_EVENTS.CANVAS_EDGE_CONNECTED, {
      workflowId, runId: streamRunId, agentId: args.agentId ?? null,
      edge: { id: edge.id, source: edge.source, target: edge.target },
      from: graph.nodes.find((n) => n.id === edge.source)?.title ?? edge.source,
      to: graph.nodes.find((n) => n.id === edge.target)?.title ?? edge.target,
    });
  }

  if (args.stream) {
    deps.db.update(schema.workflows)
      .set({ graph, updatedAt: new Date().toISOString() })
      .where(eq(schema.workflows.id, workflowId))
      .run();
  }
  publishCanvas(deps, pubCtx, REALTIME_EVENTS.CANVAS_BUILD_COMPLETE, {
    workflowId, runId: streamRunId, agentId: args.agentId ?? null,
    nodeCount: graph.nodes.length, edgeCount: graph.edges.length,
    warnings: preflight.warnings, estimatedCostCents: preflight.estimatedCostCents,
    archetype: brief.classification.archetype,
  });
  const warnSummary = preflight.warnings.length > 0
    ? ` ${preflight.warnings.length} item(s) need attention: ${preflight.warnings.slice(0, 3).map((w) => w.message).join(' ')}`
    : '';
  return {
    workflowId,
    runId: streamRunId,
    title,
    summary: description,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    archetype: brief.classification.archetype,
    warnings: preflight.warnings,
    estimatedCostCents: preflight.estimatedCostCents,
    teamRoster,
    plan: brief.classification.archetype === 'enterprise' ? planWorkflow(description, brief.classification) : undefined,
    graph,
    message: `Workflow "${title}" built with ${graph.nodes.length} nodes (${brief.classification.archetype}).${warnSummary}`,
  };
}

/**
 * Assemble a graph deterministically from an approved plan (ORCH §9 plan-driven
 * build). Each Phase Card becomes one node, grouped into a graph phase, wired
 * linearly: trigger → phase nodes → return_output. Credential binding + the
 * terminal-output guarantee are handled downstream by `preflightAndEnrich`.
 */
function assembleGraphFromPlan(plan: WorkflowPlan, description: string): WorkflowGraph {
  const lower = description.toLowerCase();
  const trigger = inferTriggerConfig(lower);
  const nodes: WorkflowNode[] = [
    { id: 'trigger', type: 'trigger', title: triggerTitle(trigger), position: { x: 0, y: 80 }, config: trigger },
  ];
  const edges: WorkflowGraph['edges'] = [];
  const phases: NonNullable<WorkflowGraph['phases']> = [];
  let prev = 'trigger';
  let x = 280;

  plan.phases.forEach((phase, i) => {
    const id = `phase_${i + 1}`;
    const prompt = phase.description?.trim() || description;
    let node: WorkflowNode;
    if (phase.agentRole) {
      node = {
        id, type: 'agent_task', title: phase.name, position: { x, y: 80 },
        config: {
          kind: 'agent_task', agentRole: phase.agentRole, capabilityTags: [],
          prompt, inputKeys: [prev], outputKeys: ['result'],
          castingReason: `Plan phase "${phase.name}" cast the ${phase.agentRole} specialist.`,
          ...(phase.model ? { modelOverride: phase.model } : {}),
        },
      };
    } else if (phase.requiredCredential || phase.nodeKinds.includes('integration')) {
      const slug = phase.requiredCredential ?? '';
      node = {
        id, type: 'integration', title: phase.name, position: { x, y: 80 },
        // `integrationId` is the connector slug; preflight binds credentialId.
        // A sensible default operation keeps the node graph-valid and meaningful;
        // the operator refines it (and wires the credential) on the canvas.
        config: { kind: 'integration', integrationId: slug, operationId: defaultOperationForSlug(slug), inputs: {} },
      };
    } else {
      // Deterministic passthrough — preserves the phase as a real, editable node.
      node = {
        id, type: 'transform', title: phase.name, position: { x, y: 80 },
        config: { kind: 'transform', expression: '({ ...input })' },
      };
    }
    nodes.push(node);
    edges.push({ id: `edge_${prev}_${id}`, source: prev, target: id });
    phases.push({ id: `grp_${i + 1}`, name: phase.name, color: PHASE_COLORS[i % PHASE_COLORS.length]!, nodeIds: [id] });
    prev = id;
    x += 280;
  });

  nodes.push({ id: 'return_output', type: 'return_output', title: 'Return Output', position: { x, y: 80 }, config: { kind: 'return_output', renderAs: 'markdown' } });
  edges.push({ id: `edge_${prev}_return_output`, source: prev, target: 'return_output' });

  return { version: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 }, phases };
}

const PHASE_COLORS = ['#8b5cf6', '#0ea5e9', '#22c55e', '#f59e0b', '#ec4899', '#14b8a6'] as const;

/** A reasonable default connector operation per slug, so a plan-built integration node is graph-valid. */
function defaultOperationForSlug(slug: string): string {
  const map: Record<string, string> = {
    gmail: 'send_message', slack: 'send_message', discord: 'send_message', telegram: 'send_message',
    sheets: 'append_row', notion: 'create_page', airtable: 'create_record',
    github: 'create_issue', jira: 'create_issue', linear: 'create_issue',
  };
  return map[slug] ?? 'send_message';
}

function titleFromDescription(description: string): string {
  const cleaned = description
    .replace(/^build\s+(me\s+)?(a|an|the)?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned.length > 0 ? cleaned : 'Generated Workflow';
  return base.length > 80 ? `${base.slice(0, 77)}...` : capitalize(base);
}

function appNameFromGoal(goal: string): string {
  const title = titleFromDescription(goal)
    .replace(/\s+workflow$/i, '')
    .replace(/\s+app$/i, '')
    .trim();
  return `${title || 'Agentis'} app`;
}

function createRequestedAgents(
  value: unknown,
  deps: ToolHandlerDeps,
  ctx: { workspaceId: string; ambientId?: string | null; userId: string },
  appId: string,
): string[] {
  if (!Array.isArray(value)) return [];
  const created: string[] = [];
  const now = new Date().toISOString();
  for (const item of value) {
    const record = recordFromUnknown(item);
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    const id = randomUUID();
    const capabilityTags = Array.isArray(record.capabilityTags)
      ? record.capabilityTags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    deps.db.insert(schema.agents).values({
      id,
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId ?? null,
      userId: ctx.userId,
      packageId: null,
      name,
      description: typeof record.description === 'string' ? record.description : null,
      adapterType: typeof record.adapterType === 'string' ? record.adapterType : 'http',
      capabilityTags,
      config: { ...recordFromUnknown(record.config), appId },
      status: 'offline',
      colorHex: typeof record.colorHex === 'string' ? record.colorHex : '#34d399',
      instructions: typeof record.instructions === 'string' ? record.instructions : null,
      avatarGlyph: typeof record.avatarGlyph === 'string' ? record.avatarGlyph : initials(name),
      role: typeof record.role === 'string' ? record.role : 'worker',
      createdAt: now,
      updatedAt: now,
    }).run();
    created.push(id);
    deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.AGENT_CREATED, {
      agent: { id, name, role: typeof record.role === 'string' ? record.role : 'worker', status: 'offline' },
      source: 'app.compose',
      appId,
    });
  }
  return created;
}

function loadOrBuildEntryWorkflow(
  workflowId: string | null,
  goal: string,
  appName: string,
  deps: ToolHandlerDeps,
  workspaceId: string,
): { title: string; graph: WorkflowGraph; settings: Record<string, unknown> } {
  if (workflowId) {
    const existing = deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
    if (!existing || existing.workspaceId !== workspaceId) throw new Error(`workflow ${workflowId} not found`);
    return {
      title: existing.title,
      graph: existing.graph as WorkflowGraph,
      settings: recordFromUnknown(existing.settings),
    };
  }
  const graph = buildWorkflowDraft(goal, deps, workspaceId);
  validateWorkflowGraph(graph);
  return {
    title: `${appName.replace(/\s+app$/i, '')} workflow`,
    graph,
    settings: {},
  };
}

function inferAppCategory(goal: string): string {
  const lower = goal.toLowerCase();
  if (/lead|deal|sales|crm/.test(lower)) return 'Sales';
  if (/support|ticket|customer/.test(lower)) return 'Support';
  if (/research|analy[sz]e|competitor|market/.test(lower)) return 'Research';
  if (/ops|operation|schedule|coordinate/.test(lower)) return 'Operations';
  return 'Automation';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return (parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || 'A').slice(0, 2);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function buildWorkflowDraft(description: string, deps: ToolHandlerDeps, workspaceId: string): WorkflowGraph {
  const lower = description.toLowerCase();
  const htmlPageOutput = inferHtmlPageOutput(description);
  if (htmlPageOutput) {
    const wantsBrowser = /\b(browser|open|screenshot|render|preview)\b/i.test(lower);
    return buildStaticOutputGraph(htmlPageOutput, { browser: wantsBrowser });
  }
  const fixedOutput = inferFixedOutput(description);
  if (fixedOutput) {
    return buildStaticOutputGraph(fixedOutput);
  }

  // Step 3 — deterministic template matching (no LLM): instantiate a known
  // multi-specialist pattern before falling back to a generic single-agent chain.
  const templated = matchTemplate(description, lower);
  if (templated) return templated;

  const nodes: WorkflowNode[] = [
    {
      id: 'trigger_manual',
      type: 'trigger',
      title: 'Manual Trigger',
      position: { x: 0, y: 80 },
      config: { kind: 'trigger', triggerType: 'manual' },
    },
  ];

  if (/research|search|analy[sz]e|document|knowledge|competitor|url/.test(lower)) {
    nodes.push({
      id: 'knowledge_context',
      type: 'knowledge',
      title: 'Gather Context',
      position: { x: 260, y: 20 },
      config: {
        kind: 'knowledge',
        queryMode: 'dynamic',
        query: description,
        retrievalMode: 'contextual',
        topK: 6,
      },
    });
  }

  const agent = deps.db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all()
    .find((row) => row.status !== 'error');
  nodes.push({
    id: 'agent_execute',
    type: 'agent_task',
    title: /write|draft|compose|email|post|report/.test(lower) ? 'Draft Output' : 'Execute Task',
    position: { x: 520, y: 80 },
    config: {
      kind: 'agent_task',
      // Bind an explicit agent if one exists; otherwise reference a specialist
      // by role so the engine resolves it from the built-in library (Layer 2).
      ...(agent?.id ? { agentId: agent.id } : { agentRole: inferAgentRole(lower) }),
      capabilityTags: inferCapabilityTags(lower),
      prompt: description,
      inputKeys: ['trigger', 'knowledge_context'],
      outputKeys: ['result'],
    },
  });

  if (/approve|review|human|check|confirm/.test(lower)) {
    nodes.push({
      id: 'human_review',
      type: 'checkpoint',
      title: 'Human Review',
      position: { x: 780, y: 80 },
      config: { kind: 'checkpoint', approvalMode: 'manual' },
    });
  }

  nodes.push({
    id: 'store_result',
    type: 'scratchpad',
    title: 'Store Result',
    position: { x: nodes.some((node) => node.id === 'human_review') ? 1040 : 780, y: 80 },
    config: { kind: 'scratchpad', operation: 'write', key: 'final_result', valuePath: 'result' },
  });

  const ordered = nodes.map((node) => node.id);
  const edges = ordered.slice(0, -1).map((source, index) => ({
    id: `edge_${source}_${ordered[index + 1]}`,
    source,
    target: ordered[index + 1]!,
  }));

  return { version: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

/** Deterministic trigger inference from the prompt (Step 2 — intent extraction). */
function inferTriggerConfig(lower: string): { kind: 'trigger'; triggerType: 'manual' | 'cron' | 'webhook'; schedule?: string } {
  if (/\bwebhook\b|incoming (request|post)|when .* receives/.test(lower)) {
    return { kind: 'trigger', triggerType: 'webhook' };
  }
  if (/\bevery (day|morning)\b|\bdaily\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * *' };
  if (/\bevery week\b|\bweekly\b|\bevery monday\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * MON' };
  if (/\bevery hour\b|\bhourly\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 * * * *' };
  if (/\bevery (\d+) ?min/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '*/15 * * * *' };
  if (/\bschedule\b|\bcron\b|\bon a schedule\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * *' };
  return { kind: 'trigger', triggerType: 'manual' };
}

/**
 * Step 3 — template library. Recognizes common workflow shapes and instantiates
 * a multi-specialist graph using `agentRole` (resolved by the engine at dispatch).
 * Returns null when nothing matches, so the generic/LLM path takes over.
 */
function matchTemplate(description: string, lower: string): WorkflowGraph | null {
  const trigger = inferTriggerConfig(lower);
  const triggerNode: WorkflowNode = {
    id: 'trigger', type: 'trigger', title: triggerTitle(trigger),
    position: { x: 0, y: 80 }, config: trigger,
  };

  const wants = (re: RegExp) => re.test(lower);
  const researchy = wants(/research|competitor|market|investigate|gather|find out|landscape/);
  const reporty = wants(/report|brief|summary|summari[sz]e|digest|write[- ]?up/);
  const reviewy = wants(/review|audit|security|owasp|code quality|pull request|\bpr\b/);
  const distributy = wants(/post|email|slack|notify|send|publish|distribute/);

  // research → analyze → write a report
  if (researchy && reporty) {
    const chain: Array<{ id: string; title: string; role: string; skills?: string[] }> = [
      { id: 'research', title: 'Gather Intelligence', role: 'researcher' },
      { id: 'analyze', title: 'Analyze Findings', role: 'analyst', skills: ['aarrr-framework'] },
      { id: 'write', title: 'Write Report', role: 'writer' },
    ];
    return pipelineGraph(triggerNode, chain, description, 'markdown');
  }

  // code/PR review pipeline
  if (reviewy) {
    return pipelineGraph(triggerNode, [
      { id: 'review', title: 'Review', role: 'reviewer', skills: ['code-review-rubric', 'owasp-checklist'] },
    ], description, 'markdown');
  }

  // collect → summarize → (distribute)
  if (reporty && distributy) {
    return pipelineGraph(triggerNode, [
      { id: 'collect', title: 'Collect Source Material', role: 'researcher' },
      { id: 'summarize', title: 'Summarize', role: 'writer' },
    ], description, 'markdown');
  }

  return null;
}

function triggerTitle(t: { triggerType: string }): string {
  return t.triggerType === 'cron' ? 'Schedule Trigger' : t.triggerType === 'webhook' ? 'Webhook Trigger' : 'Manual Trigger';
}

/** Build a linear specialist pipeline: trigger → role nodes → return_output. */
function pipelineGraph(
  trigger: WorkflowNode,
  steps: Array<{ id: string; title: string; role: string; skills?: string[] }>,
  description: string,
  renderAs: 'markdown' | 'json' | 'text',
): WorkflowGraph {
  const nodes: WorkflowNode[] = [trigger];
  const edges: WorkflowGraph['edges'] = [];
  let prev = trigger.id;
  let x = 280;
  for (const step of steps) {
    nodes.push({
      id: step.id, type: 'agent_task', title: step.title,
      position: { x, y: 80 },
      config: {
        kind: 'agent_task', agentRole: step.role as never, capabilityTags: [],
        prompt: description, inputKeys: [prev], outputKeys: ['result'],
        ...(step.skills ? { skills: step.skills } : {}),
      },
    });
    edges.push({ id: `edge_${prev}_${step.id}`, source: prev, target: step.id });
    prev = step.id;
    x += 280;
  }
  nodes.push({
    id: 'return_output', type: 'return_output', title: 'Return Output',
    position: { x, y: 80 }, config: { kind: 'return_output', renderAs },
  });
  edges.push({ id: `edge_${prev}_return_output`, source: prev, target: 'return_output' });
  return { version: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

function inferAgentRole(description: string): 'researcher' | 'writer' | 'analyst' | 'reviewer' | 'coder' {
  if (/review|audit|security|owasp|quality/.test(description)) return 'reviewer';
  if (/code|implement|refactor|test|bug|fix/.test(description)) return 'coder';
  if (/analy[sz]e|metric|stat|chart|report|data/.test(description)) return 'analyst';
  if (/research|search|competitor|investigate|gather/.test(description)) return 'researcher';
  return 'writer';
}

function inferCapabilityTags(description: string): string[] {
  const tags = new Set<string>();
  if (/research|search|competitor|url/.test(description)) tags.add('research');
  if (/write|draft|compose|email|post|report/.test(description)) tags.add('writing');
  if (/analy[sz]e|score|evaluate|metric/.test(description)) tags.add('analysis');
  if (/send|slack|discord|telegram|email|post/.test(description)) tags.add('operations');
  return Array.from(tags);
}

function inferHtmlPageOutput(description: string): Record<string, unknown> | null {
  const normalized = description.replace(/[â€œâ€]/g, '"').replace(/[â€˜â€™]/g, "'");
  const lower = normalized.toLowerCase();
  const requestsPage =
    /\b(html|browser|web page|webpage|landing page)\b/.test(lower)
    || /\blp\b/.test(lower);
  const requestsHeading = /\bh1\b/.test(lower) || /<h1[\s>]/i.test(normalized);
  if (!requestsPage || !requestsHeading) return null;

  const heading = inferRequestedHeading(normalized);
  if (!heading) return null;

  return {
    type: 'html',
    title: heading,
    content: `<h1>${escapeHtml(heading)}</h1>`,
  };
}

function inferRequestedHeading(description: string): string | null {
  const inlineTag = description.match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/i)?.[1]?.trim();
  if (inlineTag) return inlineTag;

  if (/hello\s+world/i.test(description)) return 'Hello World';

  if (/\bh1\b/i.test(description)) {
    const quoted = description.match(/["']([^"']{1,120})["']/)?.[1]?.trim();
    if (quoted) return quoted;
  }

  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildStaticOutputGraph(output: Record<string, unknown>, opts: { browser?: boolean } = {}): WorkflowGraph {
  // Pick the viewer hint from the produced shape so the Output Surface renders
  // it correctly (Layer 6): html → sandboxed iframe, single-`text` → text card,
  // anything else → JSON viewer.
  const renderAs: 'html' | 'text' | 'json' =
    output.type === 'html' && typeof output.content === 'string'
      ? 'html'
      : Object.keys(output).length === 1 && typeof output.text === 'string'
        ? 'text'
        : 'json';

  const nodes: WorkflowNode[] = [
    {
      id: 'trigger_manual',
      type: 'trigger',
      title: 'Manual Trigger',
      position: { x: 0, y: 80 },
      config: { kind: 'trigger', triggerType: 'manual' },
    },
    {
      // Deterministic producer of the static payload (no LLM tax).
      id: 'produce_output',
      type: 'transform',
      title: 'Produce Output',
      position: { x: 280, y: 80 },
      config: { kind: 'transform', expression: JSON.stringify(output) },
    },
  ];
  const edges: WorkflowGraph['edges'] = [
    { id: 'edge_trigger_manual_produce_output', source: 'trigger_manual', target: 'produce_output' },
  ];

  // "open a browser and show ..." → render the HTML in real Chromium and capture
  // a screenshot artifact, then feed the live HTML to return_output.
  const useBrowser = Boolean(opts.browser) && renderAs === 'html';
  let returnSource = 'produce_output';
  let returnX = 560;
  if (useBrowser) {
    nodes.push({
      id: 'browser_render',
      type: 'browser',
      title: 'Open in Browser',
      position: { x: 560, y: 80 },
      config: { kind: 'browser', operation: 'serve_html', htmlPath: 'content', fullPage: true },
    });
    edges.push({ id: 'edge_produce_output_browser_render', source: 'produce_output', target: 'browser_render' });
    returnSource = 'browser_render';
    returnX = 840;
  }

  nodes.push({
    id: 'return_output',
    type: 'return_output',
    title: 'Return Output',
    position: { x: returnX, y: 80 },
    config: {
      kind: 'return_output',
      renderAs,
      ...(typeof output.title === 'string' ? { title: output.title } : {}),
    },
  });
  edges.push({ id: `edge_${returnSource}_return_output`, source: returnSource, target: 'return_output' });

  return { version: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

function inferFixedOutput(description: string): Record<string, unknown> | null {
  const normalized = description.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const objectMatch = normalized.match(/\{[\s\S]{1,500}\}/);
  if (objectMatch && /fixed|return|output|hello world/i.test(normalized)) {
    const parsed = parseSimpleObjectLiteral(objectMatch[0]);
    if (parsed) return parsed;
  }

  const quotedMessage = normalized.match(/(?:return|returns|respond|responds|output|outputs)\s+(?:a\s+)?(?:fixed\s+)?(?:message|text|string)?(?:\s+like|\s+with|:)?\s*["']([^"']+)["']/i);
  if (quotedMessage?.[1]) return { text: quotedMessage[1] };

  if (/hello\s+world/i.test(normalized)) {
    const message = normalized.match(/workflow is working/i)?.[0] ?? 'Workflow is working';
    return { text: message };
  }

  return null;
}

function parseSimpleObjectLiteral(source: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(source) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to a tiny object-literal parser for common `{ text: "..." }` requests.
  }

  const pairs = [...source.matchAll(/([A-Za-z_$][\w$]*|"[^"]+"|'[^']+')\s*:\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false|null)/g)];
  if (pairs.length === 0) return null;
  const output: Record<string, unknown> = {};
  for (const pair of pairs) {
    const key = String(pair[1] ?? '').replace(/^["']|["']$/g, '');
    const raw = String(pair[2] ?? '');
    if (!key) continue;
    if (raw === 'true') output[key] = true;
    else if (raw === 'false') output[key] = false;
    else if (raw === 'null') output[key] = null;
    else if (/^-?\d/.test(raw)) output[key] = Number(raw);
    else output[key] = raw.slice(1, -1);
  }
  return Object.keys(output).length > 0 ? output : null;
}

function nodeReason(node: WorkflowNode): string {
  const reasons: Record<string, string> = {
    trigger: 'Entry point: this starts the workflow.',
    knowledge: 'Retrieves relevant workspace knowledge before acting.',
    agent_task: 'Delegates the main work to a configured agent.',
    checkpoint: 'Adds a human decision gate before continuing.',
    scratchpad: 'Stores the final output for later steps or inspection.',
    skill_task: 'Runs a fast in-process skill.',
    router: 'Branches execution based on conditions.',
    merge: 'Collects branch results before continuing.',
    subflow: 'Calls another workflow as a reusable subflow.',
    transform: 'Shapes data deterministically — no LLM tokens.',
    return_output: 'Declares the rendered result the operator sees.',
    artifact_save: 'Saves a file artifact to the workspace.',
    browser: 'Renders HTML / captures a screenshot in real Chromium.',
  };
  return reasons[node.config.kind] ?? `${node.config.kind} node`;
}

function publishCanvas(
  deps: ToolHandlerDeps,
  ctx: { workspaceId: string; agentId?: string; runId?: string },
  event: RealtimeEventName,
  payload: Record<string, unknown>,
): void {
  const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : null;
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), event, payload);
  if (workflowId) deps.bus.publish(REALTIME_ROOMS.workflow(workflowId), event, payload);
  if (runId) deps.bus.publish(REALTIME_ROOMS.run(runId), event, payload);
  if (ctx.agentId) deps.bus.publish(REALTIME_ROOMS.conversation(ctx.agentId), event, payload);
}

function buildPlan(goal: string, context: string): Array<{ step: number; action: string }> {
  const prefix = context.trim() ? `Considering ${context.trim().slice(0, 120)}, ` : '';
  return [
    { step: 1, action: `${prefix}identify the concrete target state and required IDs.` },
    { step: 2, action: 'Inspect current Agentis state with read-only tools.' },
    { step: 3, action: `Apply the smallest action that advances: ${goal}.` },
    { step: 4, action: 'Verify the result and report the platform state back to the operator.' },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * LLM-based workflow synthesis.
 *
 * Asks the configured evaluator endpoint to design a `WorkflowGraph` from a
 * natural-language description, validates the result against the same
 * `validateWorkflowGraph` contract operators see in the canvas, and retries
 * up to 2 times with the validation error appended on parse failure.
 *
 * Returns `null` when no LLM endpoint is configured OR after all retries
 * exhausted. The caller falls back to the regex synthesizer in either case
 * so workflows can always be built, just less intelligently.
 */
async function synthesizeWithLlm(
  description: string,
  deps: ToolHandlerDeps,
  workspaceId: string,
  brief?: CreationBrief,
): Promise<WorkflowGraph | null> {
  // Prefer the dedicated synthesis runtime (§6); fall back to the evaluator
  // runtime. Only the regex path remains when neither is configured.
  const runtime = deps.synthesisRuntime ?? deps.evaluatorRuntime;
  if (!runtime) return null;
  const inv = brief?.inventory;
  // Surface the user's existing agents + skills + knowledge bases so the model
  // can reference real IDs instead of placeholders.
  const agents = deps.db
    .select({ id: schema.agents.id, name: schema.agents.name, capabilityTags: schema.agents.capabilityTags })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
  const knowledgeBases = deps.knowledgeBases
    ? deps.knowledgeBases.listKnowledgeBases(workspaceId).map((kb) => ({ id: kb.id, name: kb.name }))
    : [];
  const skills = deps.db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.workspaceId, workspaceId))
    .all()
    .map((skill) => {
      const manifest = skill.manifest as Partial<SkillManifest>;
      return {
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        runtime: skill.runtime,
        entrypoint: typeof manifest.entrypoint === 'string' ? manifest.entrypoint : skill.slug,
        capabilityTags: Array.isArray(manifest.capabilityTags) ? manifest.capabilityTags.filter((tag): tag is string => typeof tag === 'string') : [],
        inputSchema: manifest.inputSchema ?? {},
        outputSchema: manifest.outputSchema ?? {},
      };
    });

  const workspaceContext = inv?.workspaceContext ?? '';
  // The architecture protocol (12 iron rules) prevents one-node collapse + phantom
  // wiring; the creation brief tells the model what this workspace can actually wire.
  const systemPrompt = `${SYNTHESIS_ARCHITECT_PREAMBLE}\n\n${SYNTHESIS_SYSTEM_PROMPT}`;
  const userPrompt = [
    workspaceContext ? `${workspaceContext}\n` : '',
    brief ? renderCreationBrief(brief) : '',
    `DESCRIPTION:\n${description}`,
    inv && inv.wireableIntegrations.length > 0
      ? `\nWIREABLE INTEGRATIONS (a credential exists — use an integration node with integrationId set to one of these): ${inv.wireableIntegrations.join(', ')}`
      : '\nNO INTEGRATION CREDENTIALS ARE CONFIGURED. For any email/Slack/GitHub/etc. step, still emit the integration node (it will show as pending-config) — do NOT bury "send an email" inside an agent_task prompt.',
    inv && inv.specialistRoles.length > 0
      ? `\nSPECIALIST ROLES (set agent_task.agentRole to the minimum-sufficient role by tool need):\n${inv.specialistRoles.map((r) => `- ${r.role} [${r.tools.join(', ')}] model=${r.defaultModel}`).join('\n')}`
      : '',
    agents.length > 0
      ? `\nBOUND AGENTS (use the id verbatim only to pin a specific agent):\n${agents.slice(0, 12).map((a) => `- ${a.id}: ${a.name} (tags: ${(a.capabilityTags as string[] | undefined)?.join(', ') ?? 'none'})`).join('\n')}`
      : '',
    knowledgeBases.length > 0
      ? `\nAVAILABLE KNOWLEDGE BASES:\n${knowledgeBases.slice(0, 8).map((kb) => `- ${kb.id}: ${kb.name}`).join('\n')}`
      : '',
    inv && inv.knowledgeExcerpts.length > 0
      ? `\nBRAIN CONTEXT FOR THIS REQUEST (actual passages retrieved from the workspace Brain — use these to decide whether a knowledge node is warranted, which base to target, and a static query that will return content):\n${inv.knowledgeExcerpts.slice(0, 5).map((e) => `- [kb:${e.knowledgeBaseId}] ${e.content.replace(/\s+/g, ' ').trim().slice(0, 280)}`).join('\n')}`
      : '',
    skills.length > 0
      ? `\nAVAILABLE SKILLS (use the skill id verbatim for skill_task.skillId):\n${skills.slice(0, 16).map((skill) => `- ${skill.id}: ${skill.name} slug=${skill.slug} runtime=${skill.runtime} entrypoint=${skill.entrypoint} tags=${skill.capabilityTags.join(', ') || 'none'}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');

  const result = await runtime.completeStructured<{ graph?: unknown }>({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 2500,
    maxAttempts: 3,
  });
  if (!result || !result.graph) return null;
  const graph = result.graph as WorkflowGraph;
  // Defensive normalization — the model can omit version/viewport.
  const normalized: WorkflowGraph = {
    version: 1,
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph.edges) ? graph.edges : [],
    viewport: graph.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
  try {
    validateWorkflowGraph(normalized);
  } catch (err) {
    deps.logger.warn('synthesizeWithLlm.invalid_graph', { err: (err as Error).message });
    return null;
  }
  return normalized;
}

/** ORCHESTRATOR-CREATION-10X §5 — the 13 Iron Rules that produce architecturally
 *  correct workflows regardless of domain. Prepended to the node catalog. */
const SYNTHESIS_ARCHITECT_PREAMBLE = [
  'WORKFLOW ARCHITECTURE PROTOCOL',
  'You are a workflow architect. Translate the user intent into a perfectly structured',
  'Agentis graph using the workspace inventory provided. Obey these IRON RULES:',
  '1. Single Responsibility — each agent_task does ONE thing. "Fetch AND summarize AND send"',
  '   must become http_request → agent_task → integration. Never one giant agent_task.',
  '2. Determinism First — if output is fully determined by input, use transform/filter, not an agent.',
  '3. Native Integration — email/Slack/GitHub/Sheets actions use an `integration` node, never',
  '   an agent_task prompt that says "send an email".',
  '4. Source Fetching — fetching a URL uses an `http_request` (or `browser`) node, never an agent prompt.',
  '5. Knowledge Before Agent — wire a `knowledge` node before an agent_task that needs workspace facts.',
  '6. Guard Expensive/External Steps — put an `evaluator` or `checkpoint` before any delivery action.',
  '7. Scheduled = Autonomous — a cron trigger runs unattended; do NOT add a checkpoint unless the',
  '   user explicitly asked for human approval.',
  '8. Parallel When Independent — independent fetches go under a `parallel` node, joined by `merge`.',
  '9. Name nodes for their OUTPUT ("Fetch Hacker News Top Stories"), never "Agent Task 2".',
  '10. Terminal node is ALWAYS return_output or artifact_save. A workflow ending in an agent_task is incomplete.',
  '11. Scheduling is a trigger property (cron), never a leading wait node.',
  '12. Credentials drive integrations — only set credentialId when a credential exists; otherwise',
  '    emit the integration node WITHOUT credentialId (it renders as pending-config for the operator to wire).',
  '13. Recurring Workflows Remember — for `cron` or `persistent_listener` triggers that accumulate state',
  '    (deduplication, tracking a last-run cursor, appending to a running log), add a `workflow_store` read',
  '    node near the start and a `workflow_store` write node near the end so each run builds on the last.',
  'Set agent_task.agentRole to the minimum-sufficient specialist by tool need (see SPECIALIST ROLES).',
  'Add a one-sentence `castingReason` to each agent_task config explaining the role choice.',
  '',
].join('\n');

/** Render the creation brief (caller domain + classification) for the user prompt. */
function renderCreationBrief(brief: CreationBrief): string {
  const lines: string[] = [];
  if (brief.callerName || brief.callerRole) {
    lines.push(`BUILT BY: ${brief.callerName ?? 'an agent'}${brief.callerRole ? ` (role: ${brief.callerRole})` : ''}`);
  }
  if (brief.callerDomain) lines.push(`CALLER DOMAIN BRIEF (authoritative for this domain):\n${brief.callerDomain}`);
  const c = brief.classification;
  lines.push(`CLASSIFICATION: archetype=${c.archetype}, trigger=${c.triggerType}, est_nodes=${c.estimatedNodeCount}`);
  if (c.requiredIntegrations.length) lines.push(`MENTIONED INTEGRATIONS: ${c.requiredIntegrations.join(', ')}`);
  if (c.missingCredentials.length) lines.push(`MISSING CREDENTIALS (emit pending-config integration nodes, no credentialId): ${c.missingCredentials.join(', ')}`);
  return lines.join('\n');
}

const SYNTHESIS_SYSTEM_PROMPT = [
  'You are the Agentis workflow architect. Convert the user\'s description into a valid',
  '`WorkflowGraph` JSON object. Return ONLY a JSON object of shape',
  '{ "graph": { version: 1, nodes: [...], edges: [...], viewport: { x: 0, y: 0, zoom: 1 } } }',
  '— no prose, no markdown, no code fences.',
  '',
  'Node kinds available on `node.config.kind`:',
  '  control: trigger, router, merge, subflow, wait, loop, parallel',
  '  data:    transform, filter, integration, http_request, workflow_store, scratchpad',
  '  intel:   agent_task, skill_task, agent_swarm, evaluator, guardrails',
  '  know:    knowledge, artifact_collect',
  '  output:  return_output, artifact_save',
  '  native:  browser',
  '  human:   checkpoint',
  '',
  'Required config fields per kind (anything else is optional):',
  '  trigger:        { kind: "trigger", triggerType: "manual" | "cron" | "webhook" | "persistent_listener" }',
  '  agent_task:     { kind: "agent_task", prompt, capabilityTags, inputKeys, outputKeys, agentId?, agentRole? }',
  '                  agentRole resolves a built-in specialist: planner|researcher|coder|reviewer|analyst|writer|monitor|architect|debugger|deployer.',
  '                  Prefer agentRole over a blank agentId so the task is runnable without manual binding.',
  '  skill_task:     { kind: "skill_task", skillId, inputMapping, outputMapping }',
  '  knowledge:      { kind: "knowledge", queryMode: "static" | "dynamic", topK, retrievalMode }',
  '  router:         { kind: "router", routingMode: "first_match" | "all_matching" | "llm_route", branches: [] }',
  '  merge:          { kind: "merge", requiredInputs: "all" | "any" }',
  '  checkpoint:     { kind: "checkpoint", approvalMode: "manual" | "auto_after_timeout" }',
  '  scratchpad:     { kind: "scratchpad", operation: "read"|"write"|"append"|"delete", key }',
  '  wait:           { kind: "wait", delayMs }',
  '  transform:      { kind: "transform", expression }',
  '  filter:         { kind: "filter", condition }',
  '  integration:    { kind: "integration", integrationId, operationId, inputs }',
  '  http_request:   { kind: "http_request", method, url, headers?, body?, auth?, responseMapping? }',
  '  workflow_store: { kind: "workflow_store", operations: [{ op, key, value?, outputKey? }] }',
  '  evaluator:      { kind: "evaluator", targetPath, criteria, passThreshold? }',
  '  guardrails:     { kind: "guardrails", rules: [], onViolation: "block"|"flag" }',
  '  loop:           { kind: "loop", itemsExpression, maxConcurrency, bodyWorkflowId, outputArrayKey, onIterationError }',
  '  parallel:       { kind: "parallel", waitFor, onBranchError, mergeStrategy }',
  '  agent_swarm:    { kind: "agent_swarm", prompt, inputArrayPath, maxParallel, mergeStrategy, capabilityTags, outputKey }',
  '  artifact_collect: { kind: "artifact_collect", collectionName }',
  '  return_output:  { kind: "return_output", renderAs: "html"|"markdown"|"table"|"json"|"text", title?, valuePath? }',
  '  artifact_save:  { kind: "artifact_save", name, artifactType?, contentPath?, titlePath? }',
  '  browser:        { kind: "browser", operation: "serve_html"|"screenshot"|"pdf"|"navigate"|"extract_text", url?, html?, htmlPath?, selector? }',
  '',
  'Variable templates: any string field accepts `{{trigger.foo}}`, `{{nodes.<id>.path}}`,',
  '`{{scratchpad.key}}`, `{{store.key}}`, and inside loops `{{loop.item}}` / `{{loop.index}}`.',
  '',
  'Edges: { id, source, target, type?: "default"|"error"|"condition" }. Wire an error edge',
  'when a node has a meaningful recovery path. Otherwise stick with default edges.',
  '',
  'Principles:',
  '- Every workflow starts with exactly one trigger node.',
  '- Prefer deterministic primitives (transform/filter/http_request/integration) over agent_task',
  '  whenever the step does NOT require reasoning. Saves cost and is more reliable.',
  '- Every workflow ends in a `return_output` node — it declares the rendered result the operator sees.',
  '  Pick renderAs by the result type: html page → "html", report/prose → "markdown", row data → "table",',
  '  structured object → "json", short message → "text".',
  '- For fixed responses such as "Hello World", use trigger -> transform (produces the value) -> return_output.',
  '- For HTML page / landing page / browser-preview requests, use trigger -> transform that returns',
  '  { type: "html", title, content: "<h1>...</h1>" } -> return_output with renderAs: "html".',
  '- Use `artifact_save` to persist a file (report.html, data.csv) the operator can download.',
  '- For "open a browser" / "screenshot" / live page rendering, use a `browser` node:',
  '  produce HTML in a transform, then browser serve_html with htmlPath:"content", then return_output renderAs:"html".',
  '- Use skill_task only with a real skillId from AVAILABLE SKILLS. Never invent skill IDs.',
  '- Use `evaluator` after an `agent_task` whenever output quality matters; route its FAIL handle',
  '  back to the agent_task with the critique embedded via `{{nodes.<EVALID>.critique}}`.',
  '- Use `checkpoint` only when human review is genuinely needed (irreversible action, high spend).',
  '- Always give each node a stable string `id` (kebab-case) and a human-readable `title`.',
  '- Place nodes left-to-right: trigger at x ≈ 0, each downstream step at x += 260.',
].join('\n');
