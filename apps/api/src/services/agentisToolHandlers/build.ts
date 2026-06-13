/**
 * Build tools — agent creates and patches workflows.
 *
 * Mutating; gated by the runtime policy engine in production deployments.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, layoutWorkflowGraph, isAgentRole } from '@agentis/core';
import type { AgentAdapter, ExtensionManifest, RealtimeEventName, WorkflowGraph, WorkflowGraphPatch, WorkflowNode } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { validateWorkflowGraph } from '../../engine/validateGraph.js';
import { PackagerService } from '../packager.js';
import { assembleCreationBrief, preflightAndEnrich, buildTeamRoster, planWorkflow, type CreationBrief, type WorkflowPlan } from '../creationPipeline.js';
import { AdapterStructuredCompleter, type StructuredCompleter } from '../structuredCompleter.js';
import { analyzeWorkflowReadiness } from '../workflowReadiness.js';
import { listIntegrationManifests } from '../integrationRegistry.js';
import { repairIntegrationOperations } from '../integrationOperationRepair.js';
import { scheduleFromNaturalLanguage } from '../scheduleFromNaturalLanguage.js';

/**
 * Conversation → last-built workflow id. A build conversation is bound to ONE
 * workflow: when the operator asks to refine it ("make it run hourly"), the
 * revision must UPDATE that graph, not spawn a twin. The orchestrator doesn't
 * always thread the id back, so we latch it server-side per conversation and
 * reuse it unless the caller explicitly asks for a new workflow. Bounded LRU so
 * a long-lived process doesn't grow unbounded.
 */
const lastWorkflowByConversation = new Map<string, string>();
const CONVERSATION_LATCH_LIMIT = 500;
function rememberConversationWorkflow(key: string, workflowId: string): void {
  lastWorkflowByConversation.delete(key);
  lastWorkflowByConversation.set(key, workflowId);
  if (lastWorkflowByConversation.size > CONVERSATION_LATCH_LIMIT) {
    const oldest = lastWorkflowByConversation.keys().next().value;
    if (oldest !== undefined) lastWorkflowByConversation.delete(oldest);
  }
}

function buildWorkflowLatchKey(ctx: { workspaceId: string; userId: string; agentId?: string; conversationId?: string | null }): string | null {
  if (ctx.conversationId) return `${ctx.workspaceId}:conversation:${ctx.conversationId}`;
  if (ctx.agentId) return `${ctx.workspaceId}:user:${ctx.userId}:agent:${ctx.agentId}`;
  return `${ctx.workspaceId}:user:${ctx.userId}:mcp`;
}

/**
 * Cross-caller duplicate-build guard. The per-conversation latch above stops a
 * twin within ONE conversation, but the SAME request can reach the build core
 * twice through DIFFERENT latch keys it can't span — a retried/duplicated chat
 * turn, or a chat build racing an mcp_native harness building over MCP. This
 * workspace-level, content-addressed window catches those: a repeat of the same
 * request within {@link RECENT_BUILD_WINDOW_MS} reuses the workflow it just made
 * (update in place) instead of inserting a near-identical twin. Keyed on the
 * normalized description, so genuinely different requests never collapse.
 */
const RECENT_BUILD_WINDOW_MS = 45_000;
const RECENT_BUILD_LIMIT = 500;
const recentBuildByRequest = new Map<string, { workflowId: string; at: number }>();

function recentBuildKey(workspaceId: string, description: string): string {
  return `${workspaceId}::${description.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 240)}`;
}

/** The id of a workflow built for the SAME request moments ago and still present,
 *  or null. Prunes the stale/missing entry so it can't resurrect a deleted id. */
function recentDuplicateWorkflowId(deps: ToolHandlerDeps, workspaceId: string, description: string): string | null {
  const key = recentBuildKey(workspaceId, description);
  const hit = recentBuildByRequest.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= RECENT_BUILD_WINDOW_MS) {
    recentBuildByRequest.delete(key);
    return null;
  }
  const exists = deps.db
    .select({ id: schema.workflows.id })
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, hit.workflowId), eq(schema.workflows.workspaceId, workspaceId)))
    .get();
  if (!exists) {
    recentBuildByRequest.delete(key);
    return null;
  }
  return hit.workflowId;
}

function rememberRecentBuild(workspaceId: string, description: string, workflowId: string): void {
  const key = recentBuildKey(workspaceId, description);
  recentBuildByRequest.delete(key);
  recentBuildByRequest.set(key, { workflowId, at: Date.now() });
  if (recentBuildByRequest.size > RECENT_BUILD_LIMIT) {
    const oldest = recentBuildByRequest.keys().next().value;
    if (oldest !== undefined) recentBuildByRequest.delete(oldest);
  }
}

/**
 * Build cost circuit breaker. Each `build_workflow` call fans out to several
 * model calls (synthesis ≤2 + reviewer 2 rounds), so an unbounded caller — a
 * client retry storm, the model double-calling the tool, or an mcp_native
 * orchestrator whose tool calls bypass the chat loop's per-turn cap — can drain
 * an account's model credits in seconds. This bounds spend at the tool boundary,
 * where EVERY caller (chat loop, MCP, direct fast-path) converges:
 *   • at most ONE build in flight per conversation — kills the duplicate
 *     concurrent rebuilds that retries cause (the most common runaway), and
 *   • at most N builds per workspace per rolling minute — a hard spend ceiling.
 * Tripping it throws FAST, before a single model call is made. Process-local
 * (same scope as the conversation latch above); a clustered deploy must front
 * builds with a shared limiter.
 */
const BUILD_WINDOW_MS = 60_000;
function buildBudgetPerWindow(): number {
  const max = Number(process.env.AGENTIS_BUILD_MAX_PER_MINUTE);
  return Number.isFinite(max) && max > 0 ? Math.floor(max) : 8;
}
const buildsInFlightByKey = new Map<string, number>();
const buildStartsByWorkspace = new Map<string, number[]>();

function acquireBuildSlot(workspaceId: string, latchKey: string | null): () => void {
  const key = latchKey ?? `${workspaceId}:anon`;
  // 1) One concurrent build per conversation — blocks duplicate rebuilds.
  if ((buildsInFlightByKey.get(key) ?? 0) >= 1) {
    throw new AgentisError(
      'OPERATION_RATE_LIMITED',
      'A workflow build for this conversation is already running. I won’t start a duplicate build — that would spend model credits twice. Wait for the current one to finish, then refine it.',
      { details: { reason: 'build_in_flight' }, remediation: 'Wait for the in-flight build to complete, then ask again.' },
    );
  }
  // 2) Rolling per-workspace ceiling — a hard cap on build spend.
  const now = Date.now();
  const recent = (buildStartsByWorkspace.get(workspaceId) ?? []).filter((t) => now - t < BUILD_WINDOW_MS);
  const limit = buildBudgetPerWindow();
  if (recent.length >= limit) {
    throw new AgentisError(
      'OPERATION_RATE_LIMITED',
      `Too many workflow builds in a short time (${recent.length} in the last minute). Pausing to protect your model credits — try again in a moment.`,
      { details: { reason: 'build_rate_limited', limit, windowMs: BUILD_WINDOW_MS }, remediation: `Wait up to a minute, then build again. Raise AGENTIS_BUILD_MAX_PER_MINUTE (currently ${limit}) for legitimate batches.` },
    );
  }
  // Reserve synchronously — no await between check and reserve — so two parallel
  // tool calls in a single batch can't both pass the concurrency gate.
  recent.push(now);
  buildStartsByWorkspace.set(workspaceId, recent);
  buildsInFlightByKey.set(key, (buildsInFlightByKey.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (buildsInFlightByKey.get(key) ?? 1) - 1;
    if (remaining <= 0) buildsInFlightByKey.delete(key);
    else buildsInFlightByKey.set(key, remaining);
  };
}

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
        mcpExposed: true,
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
            description: args.description ? String(args.description) : null,
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
        mcpExposed: true,
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
        description:
          'Generate or REVISE a workflow from natural language and stream canvas build events. '
          + 'To refine the workflow you just built in this conversation, call again WITHOUT a workflowId — '
          + 'it updates that same workflow in place. Pass workflowId to target a specific one, or set '
          + 'newWorkflow=true to deliberately create a separate workflow. '
          + 'The result includes `readiness`: if `readiness.ready` is false, tell the operator in plain, '
          + 'natural language what to connect/configure (from `readiness.requirements`) before it can run — '
          + 'never ask them for rigid formats; ask like a helpful assistant.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            title: { type: 'string' },
            workflowId: { type: 'string' },
            newWorkflow: { type: 'boolean' },
          },
          required: ['description'],
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const description = String(args.description ?? '').trim();
        if (!description) throw new Error('build_workflow requires description');
        // Resolve the target workflow: explicit id › conversation latch (revise
        // in place) › new. A latched id that no longer exists falls back to new.
        const latchKey = buildWorkflowLatchKey(ctx);
        // Cost circuit breaker — reserve a build slot BEFORE any model spend.
        // Throws fast (no LLM call) on a duplicate concurrent build or a workspace
        // that has blown past its per-minute build budget.
        const releaseBuildSlot = acquireBuildSlot(ctx.workspaceId, latchKey);
        try {
          let targetWorkflowId: string | null = args.workflowId ? String(args.workflowId) : null;
          if (!targetWorkflowId && args.newWorkflow !== true && latchKey) {
            const latched = lastWorkflowByConversation.get(latchKey);
            if (latched) {
              const exists = deps.db
                .select({ id: schema.workflows.id })
                .from(schema.workflows)
                .where(and(eq(schema.workflows.id, latched), eq(schema.workflows.workspaceId, ctx.workspaceId)))
                .get();
              if (exists) targetWorkflowId = latched;
              else lastWorkflowByConversation.delete(latchKey);
            }
          }
          const result = await createWorkflowFromDescription(deps, {
            workspaceId: ctx.workspaceId,
            ambientId: ctx.ambientId ?? null,
            userId: ctx.userId,
            agentId: ctx.agentId,
            runId: ctx.runId,
            description,
            title: args.title ? String(args.title) : undefined,
            workflowId: targetWorkflowId,
            stream: true,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (latchKey && result?.workflowId) rememberConversationWorkflow(latchKey, result.workflowId);
          // Surface, in plain language, any setup the workflow still needs before
          // it can actually run (connect an account, etc.) — connector-agnostic and
          // advisory, so the orchestrator can ask the operator intelligently rather
          // than letting a run dead-end. Never fail the build over this.
          try {
            const builtGraph = (result as { graph?: WorkflowGraph }).graph;
            if (builtGraph) {
              const readiness = analyzeWorkflowReadiness(deps.db, ctx.workspaceId, builtGraph);
              return { ...result, readiness };
            }
          } catch {
            /* readiness is advisory */
          }
          return result;
        } finally {
          releaseBuildSlot();
        }
      },
    },
    {
      definition: {
        id: 'agentis.plan_workflow',
        family: 'inspect',
        description: 'Decompose a workflow request into named, cost-estimated phases (Phase Cards) before building. Use for complex/enterprise requests so the operator can approve the plan first.',
        inputSchema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
        mutating: false,
        mcpExposed: true,
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
        mcpExposed: true,
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
  /** Cancellation signal from the calling chat turn. Aborts model spend mid-build
   *  when the operator disconnects or the turn deadline fires. */
  signal?: AbortSignal;
}

/**
 * Shared workflow-creation core (ORCHESTRATOR-CREATION-10X). Used by the
 * `build_workflow` chat tool AND the `POST /v1/workflows/build` Builder Session
 * route: assemble the brief, synthesize (LLM → deterministic fallback), pre-flight
 * enrich, persist, and stream the live canvas build events.
 */
export async function createWorkflowFromDescription(deps: ToolHandlerDeps, args: CreateWorkflowArgs) {
  const description = args.description.trim();
  // Resolve the target workflow. An explicit id (or the conversation latch, which
  // the chat handler resolves before calling us) wins. Otherwise, GUARD against
  // duplicate creation: the SAME request can reach this core twice via different
  // latch keys the per-conversation latch can't span — a retried/duplicated chat
  // turn, or a chat build racing an mcp_native harness building over MCP. A
  // workspace-level, content-addressed window catches all of them, so one request
  // can't yield two near-identical workflows. (Distinct requests have distinct
  // text → distinct key → never wrongly merged.)
  let existingWorkflowId = args.workflowId ?? null;
  let deduplicatedRequest = false;
  const recentSameRequestId = recentDuplicateWorkflowId(deps, args.workspaceId, description);
  if (!existingWorkflowId) {
    if (recentSameRequestId) {
      existingWorkflowId = recentSameRequestId;
      deduplicatedRequest = true;
      deps.logger.info('createWorkflow.dedup_reuse', { workspaceId: args.workspaceId, workflowId: recentSameRequestId, agentId: args.agentId ?? null });
    }
  } else if (recentSameRequestId === existingWorkflowId) {
    // The target (from an explicit id or the conversation latch) is a workflow we
    // JUST built from this EXACT request — a byte-identical repeat, not a
    // refinement. Dedup it (return the current graph) so a re-issue of the same
    // request never demands a synthesis model merely to reproduce itself. A
    // genuinely different description has a different content key, so real
    // refinements still take the revise path below.
    deduplicatedRequest = true;
    deps.logger.info('createWorkflow.dedup_reuse', { workspaceId: args.workspaceId, workflowId: existingWorkflowId, agentId: args.agentId ?? null, viaLatch: true });
  }
  const existingWorkflow = existingWorkflowId
    ? deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, existingWorkflowId)).get()
    : null;
  if (existingWorkflowId && (!existingWorkflow || existingWorkflow.workspaceId !== args.workspaceId)) {
    throw new Error(`workflow ${existingWorkflowId} not found`);
  }
  const title = String(args.title ?? existingWorkflow?.title ?? titleFromDescription(description));
  const persistedDescription = existingWorkflow?.description ?? description;
  const workflowId = existingWorkflowId ?? randomUUID();
  if (deduplicatedRequest && existingWorkflow) {
    const graph = existingWorkflow.graph as WorkflowGraph;
    return {
      workflowId,
      runId: args.runId ?? `build_${workflowId}`,
      title,
      description: persistedDescription,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      graph,
      deduplicated: true,
      message: `Workflow "${title}" already reflects this request.`,
    };
  }
  const streamRunId = args.runId ?? `build_${workflowId}`;
  const pubCtx = { workspaceId: args.workspaceId, agentId: args.agentId, runId: streamRunId };
  // Inspectable phase narration — every stage is broadcast so the chat can show
  // a live, fully-inspectable build timeline (no silent steps). (§6.)
  const phase = (name: string, detail?: string) =>
    publishCanvas(deps, pubCtx, REALTIME_EVENTS.WORKFLOW_BUILD_PHASE, {
      workflowId, runId: streamRunId, agentId: args.agentId ?? null, phase: name, ...(detail ? { detail } : {}),
    });

  // Cancellation: when the chat turn that started this build is aborted (operator
  // disconnected / turn deadline), stop BEFORE each model-spending stage instead
  // of running the full ~6-call pipeline into the void. Cheap stage-boundary checks
  // here + in-flight HTTP abort in the runtimes together stop the orphaned spend.
  const throwIfCanceled = () => {
    if (args.signal?.aborted) {
      throw new AgentisError('OPERATION_CANCELED', 'Build canceled — the chat turn ended before it finished.');
    }
  };

  phase('analyzing', 'Reading your request and workspace inventory');
  const briefInput = existingWorkflow
    ? `${existingWorkflow.description ?? existingWorkflow.title}\nRequested change: ${description}`
    : description;
  const brief = await assembleCreationBrief(deps, args.workspaceId, args.agentId, briefInput);
  throwIfCanceled();

  // ── Stage 1: draft the graph (plan → LLM synthesis) ──
  phase('drafting');
  const synthCompleter = resolveSynthesisCompleter(deps, args.workspaceId, args.agentId);
  const synthModelAvailable = Boolean(synthCompleter);
  let rawGraphBase: WorkflowGraph;
  let synthesis: 'plan' | 'llm' | 'deterministic';
  const deterministic = args.plan || existingWorkflow ? null : tryCompileDeterministicWorkflow(description);
  if (args.plan && args.plan.phases.length > 0) {
    rawGraphBase = assembleGraphFromPlan(args.plan, description);
    synthesis = 'plan';
  } else if (deterministic) {
    rawGraphBase = deterministic.graph;
    synthesis = 'deterministic';
    phase('drafting', deterministic.detail);
  } else if (!synthCompleter) {
    // Agentis is an agentic platform: workflow creation is AI-driven. There is
    // NO deterministic fallback — emitting a "dumb" template would be worse than
    // refusing. With no configured model AND no chat-capable agent, tell the
    // operator exactly how to enable it.
    deps.logger.warn('createWorkflow.no_model', { workspaceId: args.workspaceId, agentId: args.agentId ?? null });
    phase('blocked', 'No model is available to build with');
    throw new AgentisError(
      'WORKFLOW_SYNTHESIS_UNAVAILABLE',
      'Agentis builds workflows with AI. The building agent has no usable model — set one for it (the chat model picker), configure an Orchestrator model in Settings → Runtimes, or set AGENTIS_ORCHESTRATOR_MODEL, then ask me to build this again.',
    );
  } else {
    const outcome = await synthesizeWithLlm(
      description,
      deps,
      args.workspaceId,
      synthCompleter,
      brief,
      args.signal,
      existingWorkflow
        ? { title: existingWorkflow.title, graph: existingWorkflow.graph as WorkflowGraph }
        : undefined,
    );
    if (!outcome.graph) {
      // A model WAS available but couldn't produce a usable graph. Surface the
      // REAL reason (the backend's own error, or the validation failure) — not a
      // generic "couldn't build" — so the operator can act on it.
      const runtimeFailure = isSynthesisRuntimeFailure(outcome.error);
      const detail = runtimeFailure
        ? `Workflow synthesis runtime failed${outcome.error ? `: ${outcome.error}` : ''}`
        : outcome.error
          ? `The workflow draft failed validation: ${outcome.error}`
          : 'The model did not produce a workflow graph';
      phase('blocked', detail);
      throw new AgentisError(
        'WORKFLOW_SYNTHESIS_UNAVAILABLE',
        runtimeFailure
          ? `Workflow synthesis could not reach a healthy model runtime${outcome.error ? ` (${outcome.error})` : ''}. The selected model was not rejected for capability; Agentis exhausted the transient runtime retry. Check the runtime connection and retry.`
          : `The model returned a workflow that Agentis could not validate${outcome.error ? ` (${outcome.error})` : ''}. Retry the request or inspect the validation detail.`,
      );
    }
    rawGraphBase = outcome.graph;
    synthesis = 'llm';
  }
  const draftDetail = synthesis === 'llm'
    ? 'Synthesized with the orchestrator model'
    : synthesis === 'deterministic'
      ? 'Compiled with the fast deterministic graph builder'
      : 'Assembled from your approved plan';
  phase('drafting', draftDetail);

  // ── Stage 2: deterministic structural repair (Iron Rules) ──
  const repaired = repairGraph(rawGraphBase, brief.classification, brief.inventory);
  let workingGraph = repaired.graph;
  const repairs: RepairAction[] = [...repaired.repairs];
  if (repaired.repairs.length > 0) {
    phase('repairing', `${repaired.repairs.length} structural fix(es)`);
    for (const r of repaired.repairs) {
      publishCanvas(deps, pubCtx, REALTIME_EVENTS.WORKFLOW_BUILD_REPAIR, { workflowId, runId: streamRunId, repair: r });
    }
  }

  // ── Stage 3: LLM reviewer/critic loop (audits vs the Iron Rules, repairs) ──
  // Skipped when the ONLY available model is a slow per-call CLI harness: the
  // reviewer is a second set of round-trips, and the deterministic repairGraph
  // above already enforces the Iron Rules structurally. This keeps a CLI-only
  // setup fast (seconds) instead of doubling an already-slow build.
  const critiques: BuildCritique[] = [];
  let reviewRounds = 0;
  const reviewer = synthesis === 'llm' && !buildOnlyHasSlowPath(deps, args.workspaceId, args.agentId)
    ? resolveReviewerCompleter(deps, args.workspaceId, args.agentId)
    : undefined;
  if (reviewer) {
    phase('reviewing', 'Auditing the graph against the workflow grammar');
    for (let round = 0; round < 2; round += 1) {
      throwIfCanceled();
      let review;
      try {
        review = await reviewWorkflowGraph(reviewer, { graph: workingGraph, description, brief }, args.signal);
      } catch (err) {
        deps.logger.warn('reviewWorkflowGraph.failed', { err: (err as Error).message });
        break;
      }
      reviewRounds += 1;
      for (const c of review.critiques) {
        critiques.push(c);
        publishCanvas(deps, pubCtx, REALTIME_EVENTS.WORKFLOW_BUILD_CRITIQUE, { workflowId, runId: streamRunId, critique: c });
      }
      if (!review.repairedGraph) break;
      // Re-apply deterministic repair to the reviewer's graph + adopt if valid.
      const reRepaired = repairGraph(review.repairedGraph, brief.classification, brief.inventory);
      try {
        validateWorkflowGraph(reRepaired.graph);
        if (existingWorkflow) {
          assertMutationPreservesGraph(
            existingWorkflow.graph as WorkflowGraph,
            reRepaired.graph,
            description,
          );
        }
        workingGraph = reRepaired.graph;
        repairs.push(...reRepaired.repairs);
      } catch {
        break; // reviewer produced an invalid graph — keep the prior one
      }
      if (review.critiques.every((c) => c.severity !== 'error')) break;
    }
  }

  throwIfCanceled();
  // F7 — materialize the cast: commission a real specialist agent per role and
  // pin it to its node, so the team is real and visible right after the build.
  const casting = materializeCast(workingGraph, deps, args.workspaceId, args.userId);
  workingGraph = casting.graph;
  if (casting.cast.length > 0) {
    const created = casting.cast.filter((c) => c.created).length;
    phase('building', created > 0
      ? `Commissioned ${created} specialist${created === 1 ? '' : 's'} for the cast`
      : `Cast ${casting.cast.length} specialist${casting.cast.length === 1 ? '' : 's'}`);
  }

  // F5 — "email me" should need zero setup: fill the operator's own address into
  // a self-directed email delivery node that has no recipient.
  const selfDelivery = fillSelfDeliveryRecipient(workingGraph, deps, args.userId, description);
  workingGraph = selfDelivery.graph;
  if (selfDelivery.filled) phase('repairing', 'Set the email recipient to your account');

  const preflight = preflightAndEnrich(workingGraph, brief.inventory);
  // Normalize integration operation names to each connector's REAL catalog so
  // synthesized nodes actually run (e.g. agentmail `send_email` → `send_message`)
  // — for EVERY integration, never one connector at a time. Otherwise the run
  // dies at execute() with "operation 'X' is not supported by Y".
  const operationCatalog = Object.fromEntries(
    listIntegrationManifests(deps.db, args.workspaceId).map((m) => [m.service.toLowerCase(), m.operations]),
  );
  const opFix = repairIntegrationOperations(preflight.graph, operationCatalog);
  for (const r of opFix.repairs) {
    repairs.push({ rule: 14, kind: 'integration_operation_normalized', nodeId: r.nodeId, message: `Corrected ${r.integration} operation "${r.from}" → "${r.to}".` });
    if (args.stream) phase('repairing', `Corrected ${r.integration} operation → ${r.to}`);
  }
  // Tidy the graph with the shared layered layout so it's readable and framable
  // the instant it lands on the canvas — AI models place nodes arbitrarily.
  const graph = ensureNodeDisplayFields(layoutWorkflowGraph(opFix.graph));
  const teamRoster = buildTeamRoster(graph, brief.inventory);
  const deliveryPreview = buildDeliveryPreview(graph);
  const approvalRequired = hasManualApprovalBeforeDelivery(graph);
  validateWorkflowGraph(graph, { strict: false });

  // Translate a natural-language schedule ("every day at 15:05 Brasília") into a
  // correct UTC cron on a REAL, linked trigger row — instead of leaving the cron
  // wrong and the trigger an inert visual. Created paused (no silent autonomous
  // spend); surfaced as a one-click "activate the schedule" readiness item.
  const scheduled = applyScheduleTrigger(deps, args, graph, workflowId);
  if (scheduled) {
    preflight.warnings.push({
      code: 'SCHEDULE_INACTIVE',
      nodeId: scheduled.nodeId,
      message: `Runs on a schedule (${scheduled.detail}). Activate the trigger to start automatic runs.`,
    });
    if (args.stream) phase('building', `Scheduled — ${scheduled.detail}`);
  }

  const trace = {
    synthesis,
    synthModelAvailable,
    reviewed: reviewRounds > 0,
    reviewRounds,
    repairs,
    critiques,
    archetype: brief.classification.archetype,
    warnings: preflight.warnings,
  };

  const now = new Date().toISOString();
  const emptyGraph: WorkflowGraph = { ...graph, nodes: [], edges: [] };
  // When streaming, persist an empty graph first so nodes animate in; otherwise
  // persist the full graph in one shot.
  const initialGraph = args.stream ? emptyGraph : graph;
  if (!existingWorkflow) {
    deps.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      userId: args.userId,
      title,
      description: persistedDescription,
      graph: initialGraph,
      settings: {},
      concurrencyOverflow: 'queue',
      createdAt: now,
      updatedAt: now,
    }).run();
  }
  // Persist the linked cron trigger row now that the workflow row exists (FK).
  // Idempotent on rebuild: update the existing row in place. Stored UTC, so the
  // trigger config timezone stays UTC (TriggerRuntime's default) — sourceTimezone
  // is informational only.
  if (scheduled) {
    const cronConfig = { expression: scheduled.cron, ...(scheduled.timezone ? { sourceTimezone: scheduled.timezone } : {}) };
    const existingTrigger = deps.db.select().from(schema.triggers).where(eq(schema.triggers.id, scheduled.triggerId)).get();
    if (existingTrigger) {
      deps.db.update(schema.triggers)
        .set({ triggerType: 'cron', config: cronConfig, updatedAt: now })
        .where(eq(schema.triggers.id, scheduled.triggerId))
        .run();
    } else {
      deps.db.insert(schema.triggers).values({
        id: scheduled.triggerId,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId ?? null,
        workflowId,
        userId: args.userId,
        triggerType: 'cron',
        config: cronConfig,
        status: 'paused',
      }).run();
    }
  }

  // Remember this build so an immediate repeat of the SAME request (any caller,
  // any conversation) updates this workflow instead of spawning a twin.
  rememberRecentBuild(args.workspaceId, description, workflowId);

  phase('building', `Placing ${graph.nodes.length} node(s)`);
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

  if (args.stream || existingWorkflow) {
    deps.db.update(schema.workflows)
      .set({
        title,
        description: persistedDescription,
        graph,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflows.id, workflowId))
      .run();
  }
  phase('complete', `${graph.nodes.length} node(s), ${repairs.length} repair(s), ${critiques.length} critique(s)`);
  publishCanvas(deps, pubCtx, REALTIME_EVENTS.CANVAS_BUILD_COMPLETE, {
    workflowId, runId: streamRunId, agentId: args.agentId ?? null,
    nodeCount: graph.nodes.length, edgeCount: graph.edges.length,
    warnings: preflight.warnings, estimatedCostCents: preflight.estimatedCostCents,
    archetype: brief.classification.archetype, trace,
  });
  const warnSummary = preflight.warnings.length > 0
    ? ` ${preflight.warnings.length} item(s) need attention: ${preflight.warnings.slice(0, 3).map((w) => w.message).join(' ')}`
    : '';
  return {
    workflowId,
    runId: streamRunId,
    title,
    description: persistedDescription,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    archetype: brief.classification.archetype,
    warnings: preflight.warnings,
    estimatedCostCents: preflight.estimatedCostCents,
    // F8 — pre-run trust signals: how long it'll take and what it will deliver.
    estimatedDurationMs: estimateDurationMs(graph),
    deliveryPreview,
    approvalRequired,
    cast: casting.cast,
    teamRoster,
    plan: brief.classification.archetype === 'enterprise' ? planWorkflow(description, brief.classification) : undefined,
    graph,
    trace,
    message: `Workflow "${title}" built with ${graph.nodes.length} nodes (${brief.classification.archetype}).`
      + ` Est. ~${Math.max(1, Math.round(estimateDurationMs(graph) / 1000))}s/run`
      + (preflight.estimatedCostCents > 0 ? ` · ~$${(preflight.estimatedCostCents / 100).toFixed(2)}/run.` : '.')
      + (casting.cast.length > 0 ? ` Cast: ${casting.cast.map((c) => c.role).join(', ')}.` : '')
      + (repairs.length > 0 ? ` Applied ${repairs.length} structural repair(s).` : '')
      + (critiques.length > 0 ? ` Reviewer raised ${critiques.length} note(s).` : '')
      + (deliveryPreview.length > 0 ? ` Delivers to: ${deliveryPreview.map((d) => d.summary).join('; ')}.` : '')
      + (approvalRequired ? ' Requires approval before delivery.' : '')
      + warnSummary,
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

const DELIVERY_SLUGS = new Set([
  'agentmail', 'gmail', 'slack', 'discord', 'telegram', 'google_sheets', 'sheets', 'notion', 'airtable', 'github', 'jira', 'linear',
]);

/** One inspectable structural repair the pipeline applied (10X-CREATION §7 M1). */
export interface RepairAction {
  rule: number;
  kind: 'delivery_node_added' | 'recurring_state_added' | 'terminal_added' | 'cycle_broken' | 'dangling_edge_removed' | 'integration_operation_normalized' | 'cron_schedule_defaulted';
  nodeId?: string;
  message: string;
}

const isTerminalNode = (n: WorkflowNode) => {
  const c = n.config as { kind?: string; isOutput?: boolean };
  return c.kind === 'return_output' || c.kind === 'artifact_save' || c.isOutput === true;
};
const nodeKind = (n: WorkflowNode) => (n.config as { kind?: string }).kind;

/**
 * Deterministic structural repair (10X-CREATION-SWARM-PLAN Milestone 1) — turns
 * the most common Iron-Rule violations from warnings into actual graph fixes,
 * each returned as an inspectable RepairAction (never silent). Conservative:
 * skips when the graph shape is ambiguous and leaves the warning in place.
 */
export function repairGraph(
  graph: WorkflowGraph,
  classification: { requiredIntegrations: string[]; triggerType?: string },
  inventory: { configuredCredentials: Array<{ id: string; integrationSlug: string }> },
): { graph: WorkflowGraph; repairs: RepairAction[] } {
  const repairs: RepairAction[] = [];
  let g = graph;

  // Structural integrity FIRST — the later repairs (delivery/state) assume a
  // clean DAG. Weak models routinely emit edges to non-existent nodes or a
  // back-edge that closes a loop; both make `validateWorkflowGraph` throw. We
  // prune/break them deterministically so a small model's draft still ships.
  const pruned = pruneDanglingEdges(g);
  if (pruned.removed.length > 0) {
    g = pruned.graph;
    for (const r of pruned.removed) {
      repairs.push({
        rule: 0,
        kind: 'dangling_edge_removed',
        message: `Removed edge ${r.edgeId} (${r.from}→${r.to}) — it referenced a node that does not exist.`,
      });
    }
  }
  const decycled = breakCycles(g);
  if (decycled.removed.length > 0) {
    g = decycled.graph;
    for (const r of decycled.removed) {
      repairs.push({
        rule: 0,
        kind: 'cycle_broken',
        message: `Removed edge ${r.edgeId} (${r.from}→${r.to}) — it closed a cycle; workflows must be acyclic.`,
      });
    }
  }

  // Rule 3 + Rule 10 — delivery node.
  const delivery = ensureDeliveryNode(g, classification, inventory);
  if (delivery.addedSlug) {
    g = delivery.graph;
    repairs.push({
      rule: 3,
      kind: 'delivery_node_added',
      nodeId: `deliver_${delivery.addedSlug}`,
      message: `Added a ${delivery.addedSlug} delivery node — the request asks to deliver results but the graph had no integration node for it (Rule 3/10).`,
    });
  }

  // Rule 13 — recurring workflows remember (dedup / cursor state).
  if (classification.triggerType === 'cron' || classification.triggerType === 'persistent_listener') {
    const state = ensureRecurringState(g);
    if (state.added.length > 0) {
      g = state.graph;
      for (const a of state.added) repairs.push({ rule: 13, kind: 'recurring_state_added', nodeId: a.id, message: a.message });
    }
  }

  // Rule 14 — a cron trigger with no schedule fails strict validation and can
  // never run. Weak models routinely emit `triggerType: 'cron'` while omitting
  // the cron expression. Default it to a sensible daily run (09:00 UTC) so the
  // workflow is immediately valid/runnable; the schedule stays one click to edit.
  const cronDefault = ensureCronSchedule(g);
  if (cronDefault.changed) {
    g = cronDefault.graph;
    repairs.push({
      rule: 14,
      kind: 'cron_schedule_defaulted',
      nodeId: cronDefault.nodeId,
      message: 'Added a default daily schedule (09:00 UTC) to the cron trigger — it had none, which would block the workflow from running (Rule 14).',
    });
  }

  return { graph: g, repairs };
}

/**
 * Rule 14 — give a cron trigger a runnable default schedule when it has none.
 * Returns the (possibly) patched graph; `changed` is false when no cron trigger
 * needs a default, so the caller records a repair only on a real fix.
 */
function ensureCronSchedule(graph: WorkflowGraph): { graph: WorkflowGraph; changed: boolean; nodeId?: string } {
  const DEFAULT_CRON = '0 9 * * *';
  const idx = graph.nodes.findIndex((n) => {
    const c = n.config as { kind?: string; triggerType?: string; schedule?: string };
    return c.kind === 'trigger' && c.triggerType === 'cron' && !c.schedule?.trim();
  });
  if (idx === -1) return { graph, changed: false };
  const target = graph.nodes[idx]!;
  const patched: WorkflowNode = {
    ...target,
    config: { ...(target.config as object), schedule: DEFAULT_CRON } as WorkflowNode['config'],
  };
  const nodes = [...graph.nodes];
  nodes[idx] = patched;
  return { graph: { ...graph, nodes }, changed: true, nodeId: target.id };
}

/** Node kinds that run on a specialist agent and can therefore be cast. */
const AGENT_NODE_KINDS = new Set(['agent_task', 'agent_session', 'agent_swarm', 'dynamic_swarm', 'planner']);

export interface CastMember { role: string; agentId: string; created: boolean }

/**
 * Materialize the cast (F7): for every distinct `agentRole` referenced by the
 * graph, commission a REAL specialist agent (idempotent per workspace+role) and
 * pin its id onto the node. The team becomes real and visible in the workspace
 * the instant a workflow is built — no more "the orchestrator runs everything
 * itself". Reuses {@link SpecialistAgentService}, so specialists are shared and
 * reusable across workflows. No-ops when the service isn't wired or a node is
 * already pinned to a specific agent.
 */
function materializeCast(
  graph: WorkflowGraph,
  deps: ToolHandlerDeps,
  workspaceId: string,
  userId: string | undefined,
): { graph: WorkflowGraph; cast: CastMember[] } {
  if (!deps.specialists || !userId) return { graph, cast: [] };
  const cast: CastMember[] = [];
  const byRole = new Map<string, string>();
  const nodes = graph.nodes.map((n) => {
    const cfg = n.config as { kind?: string; agentRole?: string; agentId?: string };
    if (!AGENT_NODE_KINDS.has(cfg.kind ?? '')) return n;
    if (cfg.agentId) return n; // operator pinned a specific agent — respect it
    const role = cfg.agentRole;
    if (!role || !isAgentRole(role)) return n;
    let agentId = byRole.get(role);
    if (!agentId) {
      const existed = deps.specialists!.resolveRole(workspaceId, role) !== null;
      agentId = deps.specialists!.ensureRole(workspaceId, userId, role);
      byRole.set(role, agentId);
      cast.push({ role, agentId, created: !existed });
    }
    return { ...n, config: { ...cfg, agentId } } as WorkflowNode;
  });
  return { graph: { ...graph, nodes }, cast };
}

/**
 * Guarantee every node carries the DISPLAY fields the edit-time API schema and
 * the canvas expect: a non-empty `title` (≤255), a `type`, and a numeric
 * `position`. The engine never requires these, so a model/repair can persist a
 * node without them — which then makes the canvas autosave fail with
 * VALIDATION_FAILED on a graph the build just produced. Backfilled from the kind.
 */
function ensureNodeDisplayFields(graph: WorkflowGraph): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const kind = (n.config as { kind?: string }).kind ?? n.type ?? 'task';
      const title = (typeof n.title === 'string' && n.title.trim() ? n.title.trim() : humanizeNodeKind(kind)).slice(0, 255);
      const type = typeof n.type === 'string' && n.type.trim() ? n.type : kind;
      const position = n.position && typeof n.position.x === 'number' && typeof n.position.y === 'number'
        ? n.position
        : { x: 0, y: 0 };
      return { ...n, title, type, position } as WorkflowNode;
    }),
  };
}

function humanizeNodeKind(kind: string): string {
  return kind.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Rough per-kind runtime estimate (ms). Conservative, for a pre-run "~Ns" hint. */
const NODE_DURATION_MS: Record<string, number> = {
  agent_task: 9000, agent_session: 12000, agent_swarm: 12000, dynamic_swarm: 14000,
  planner: 6000, evaluator: 4000, guardrails: 3000, knowledge: 1500, http_request: 1500,
  browser: 4000, integration: 1500, extension_task: 3000, transform: 200, filter: 200,
  merge: 200, router: 300, wait: 0, workflow_store: 100, workspace_store: 100,
};
/** F8 — estimated wall-clock for one run (sum of node estimates; conservative). */
function estimateDurationMs(graph: WorkflowGraph): number {
  return graph.nodes.reduce((sum, n) => sum + (NODE_DURATION_MS[(n.config as { kind?: string }).kind ?? ''] ?? 300), 0);
}

export interface DeliveryPreview { service: string; to?: string; summary: string }

/**
 * F8 — what a run will actually send, so the operator sees "this emails
 * you@acme.com" BEFORE the first live run instead of after. Derived from the
 * graph's delivery (integration) nodes.
 */
function buildDeliveryPreview(graph: WorkflowGraph): DeliveryPreview[] {
  const out: DeliveryPreview[] = [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const n of graph.nodes) {
    const cfg = n.config as { kind?: string; integrationId?: string; inputs?: Record<string, unknown> };
    if (cfg.kind !== 'integration' || !cfg.integrationId) continue;
    if (!DELIVERY_SLUGS.has(cfg.integrationId)) continue;
    const to = resolvePreviewInput(cfg.inputs?.to, nodeById);
    const service = capitalize(cfg.integrationId.replace(/_/g, ' '));
    out.push({ service: cfg.integrationId, ...(to ? { to } : {}), summary: to ? `${service} → ${to}` : `${service} (recipient not set)` });
  }
  return out;
}

function hasManualApprovalBeforeDelivery(graph: WorkflowGraph): boolean {
  const manualCheckpointIds = new Set(
    graph.nodes
      .filter((node) => {
        const cfg = node.config as { kind?: string; approvalMode?: string };
        return cfg.kind === 'checkpoint' && cfg.approvalMode === 'manual';
      })
      .map((node) => node.id),
  );
  if (manualCheckpointIds.size === 0) return false;
  const deliveryNodeIds = new Set(
    graph.nodes
      .filter((node) => {
        const cfg = node.config as { kind?: string; integrationId?: string };
        return cfg.kind === 'integration' && !!cfg.integrationId && DELIVERY_SLUGS.has(cfg.integrationId);
      })
      .map((node) => node.id),
  );
  return graph.edges.some((edge) => manualCheckpointIds.has(edge.source) && deliveryNodeIds.has(edge.target));
}

function resolvePreviewInput(value: unknown, nodeById: Map<string, WorkflowNode>): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const template = value.match(/^\{\{\s*nodes\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\s*\}\}$/);
  if (!template) return value;
  const source = nodeById.get(template[1]!);
  if (!source || (source.config as { kind?: string }).kind !== 'transform') return value;
  const expression = (source.config as { expression?: unknown }).expression;
  if (typeof expression !== 'string') return value;
  try {
    const parsed = JSON.parse(expression) as Record<string, unknown>;
    const resolved = parsed[template[2]!];
    return typeof resolved === 'string' && resolved.trim() ? resolved : value;
  } catch {
    return value;
  }
}

const SELF_DELIVERY_EMAIL_SLUGS = new Set(['agentmail', 'gmail', 'email', 'smtp', 'outlook', 'sendgrid', 'mailgun', 'ses', 'notify']);

/**
 * True when the operator asked to be the recipient ("email me", "notify me")
 * and named no other address. We must NOT treat "email john@acme.com" as
 * self-directed, so an explicit address anywhere in the request disqualifies it.
 */
function isSelfDirectedDelivery(description: string): boolean {
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(description)) return false;
  const d = description.toLowerCase();
  return /\b(me|myself|my)\b/.test(d)
    && /\b(email|e-?mail|mail|notify|send|dm|message|digest|alert|report)\b/.test(d);
}

/**
 * Zero-config self delivery (F5): when the request is self-directed, fill the
 * operator's own verified email into an email delivery node that has no
 * recipient — so "email me" Just Works instead of asking "which address?".
 * Only fills an EMPTY recipient; never overrides an explicit one.
 */
function fillSelfDeliveryRecipient(
  graph: WorkflowGraph,
  deps: ToolHandlerDeps,
  userId: string | undefined,
  description: string,
): { graph: WorkflowGraph; filled: boolean } {
  if (!userId || !isSelfDirectedDelivery(description)) return { graph, filled: false };
  const user = deps.db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).get();
  const email = user?.email?.trim();
  if (!email) return { graph, filled: false };
  let filled = false;
  const nodes = graph.nodes.map((n) => {
    const cfg = n.config as { kind?: string; integrationId?: string; inputs?: Record<string, unknown> };
    if (cfg.kind !== 'integration') return n;
    if (!SELF_DELIVERY_EMAIL_SLUGS.has(String(cfg.integrationId ?? '').toLowerCase())) return n;
    const inputs = { ...(cfg.inputs ?? {}) };
    const to = typeof inputs.to === 'string' ? inputs.to.trim() : '';
    if (to) return n;
    inputs.to = email;
    filled = true;
    return { ...n, config: { ...cfg, inputs } } as WorkflowNode;
  });
  return filled ? { graph: { ...graph, nodes }, filled: true } : { graph, filled: false };
}

/**
 * Drop edges whose source or target is not a real node. A common weak-model
 * mistake (hallucinated ids, leftover edges after renaming a node) that would
 * otherwise fail validation with "references missing node".
 */
function pruneDanglingEdges(graph: WorkflowGraph): {
  graph: WorkflowGraph;
  removed: Array<{ edgeId: string; from: string; to: string }>;
} {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const removed: Array<{ edgeId: string; from: string; to: string }> = [];
  const kept = graph.edges.filter((e) => {
    if (ids.has(e.source) && ids.has(e.target)) return true;
    removed.push({ edgeId: e.id, from: e.source, to: e.target });
    return false;
  });
  return removed.length > 0 ? { graph: { ...graph, edges: kept }, removed } : { graph, removed: [] };
}

/**
 * Break any cycles by removing the back-edges that close them (DFS gray-edge
 * detection — the same algorithm `validateWorkflowGraph` uses to *detect* a
 * cycle, here used to *fix* one). Removing back-edges preserves the forward
 * topology, so the workflow's main path survives. Only the looping edge is cut.
 */
function breakCycles(graph: WorkflowGraph): {
  graph: WorkflowGraph;
  removed: Array<{ edgeId: string; from: string; to: string }>;
} {
  const adj = new Map<string, Array<{ target: string; edgeId: string }>>();
  for (const e of graph.edges) {
    const list = adj.get(e.source) ?? [];
    list.push({ target: e.target, edgeId: e.id });
    adj.set(e.source, list);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of graph.nodes) color.set(n.id, WHITE);
  const removedIds = new Set<string>();

  const visit = (id: string): void => {
    color.set(id, GRAY);
    for (const { target, edgeId } of adj.get(id) ?? []) {
      if (removedIds.has(edgeId)) continue;
      const c = color.get(target) ?? WHITE;
      if (c === GRAY) {
        removedIds.add(edgeId); // back-edge → cut it
        continue;
      }
      if (c === WHITE) visit(target);
    }
    color.set(id, BLACK);
  };
  for (const n of graph.nodes) {
    if ((color.get(n.id) ?? WHITE) === WHITE) visit(n.id);
  }
  if (removedIds.size === 0) return { graph, removed: [] };
  const removed = graph.edges
    .filter((e) => removedIds.has(e.id))
    .map((e) => ({ edgeId: e.id, from: e.source, to: e.target }));
  return { graph: { ...graph, edges: graph.edges.filter((e) => !removedIds.has(e.id)) }, removed };
}

/**
 * Rule 3 + Rule 10 safety net. Splice a pending-config integration node before
 * the terminal when the request asks to deliver but no integration node exists.
 */
function ensureDeliveryNode(
  graph: WorkflowGraph,
  classification: { requiredIntegrations: string[] },
  inventory: { configuredCredentials: Array<{ id: string; integrationSlug: string }> },
): { graph: WorkflowGraph; addedSlug: string | null } {
  const deliverySlugs = classification.requiredIntegrations.filter((s) => DELIVERY_SLUGS.has(s));
  if (deliverySlugs.length === 0) return { graph, addedSlug: null };
  const has = (slug: string) =>
    graph.nodes.some((n) => nodeKind(n) === 'integration' && (n.config as { integrationId?: string }).integrationId === slug);
  const missing = deliverySlugs.filter((s) => !has(s));
  if (missing.length === 0) return { graph, addedSlug: null };
  const slug = missing[0]!;

  const nodes = graph.nodes.map((n) => ({ ...n, config: { ...(n.config as object) } })) as WorkflowNode[];
  const edges = graph.edges.map((e) => ({ ...e }));
  const terminal = nodes.find(isTerminalNode);
  let anchor: WorkflowNode | undefined;
  if (terminal) {
    const feeder = edges.find((e) => e.target === terminal.id);
    anchor = feeder ? nodes.find((n) => n.id === feeder.source) : undefined;
  }
  anchor ??= [...nodes].reverse().find((n) => !isTerminalNode(n)) ?? nodes[nodes.length - 1];
  if (!anchor) return { graph, addedSlug: null };

  const credId = inventory.configuredCredentials.find((c) => c.integrationSlug === slug)?.id;
  const intId = `deliver_${slug}`;
  nodes.push({
    id: intId,
    type: 'integration',
    title: `Send via ${capitalize(slug.replace(/_/g, ' '))}`,
    position: { x: anchor.position.x + 240, y: anchor.position.y },
    config: {
      kind: 'integration',
      integrationId: slug,
      operationId: defaultOperationForSlug(slug),
      inputs: {},
      ...(credId ? { credentialId: credId } : {}),
    },
  } as unknown as WorkflowNode);

  if (terminal) {
    const direct = edges.find((e) => e.source === anchor!.id && e.target === terminal.id);
    if (direct) direct.target = intId;
    else edges.push({ id: `edge_${anchor.id}_${intId}`, source: anchor.id, target: intId });
    edges.push({ id: `edge_${intId}_${terminal.id}`, source: intId, target: terminal.id });
    terminal.position = { x: anchor.position.x + 480, y: terminal.position.y };
  } else {
    edges.push({ id: `edge_${anchor.id}_${intId}`, source: anchor.id, target: intId });
  }
  return { graph: { ...graph, nodes, edges }, addedSlug: slug };
}

/**
 * Rule 13 — recurring workflows must read/write state so each run builds on the
 * last (dedup, cursor). Inserts a `workflow_store` read right after the trigger
 * and a `workflow_store` write right before the terminal, as passthroughs.
 * Conservative: requires exactly one trigger and one terminal, and no existing
 * workflow_store node; otherwise it no-ops.
 */
function ensureRecurringState(graph: WorkflowGraph): { graph: WorkflowGraph; added: Array<{ id: string; message: string }> } {
  if (graph.nodes.some((n) => nodeKind(n) === 'workflow_store')) return { graph, added: [] };
  const triggers = graph.nodes.filter((n) => nodeKind(n) === 'trigger');
  const terminals = graph.nodes.filter(isTerminalNode);
  if (triggers.length !== 1 || terminals.length !== 1) return { graph, added: [] };
  const trigger = triggers[0]!;
  const terminal = terminals[0]!;

  const nodes = graph.nodes.map((n) => ({ ...n, config: { ...(n.config as object) } })) as WorkflowNode[];
  const edges = graph.edges.map((e) => ({ ...e }));
  const added: Array<{ id: string; message: string }> = [];

  // Read node, spliced after the trigger.
  const triggerOut = edges.find((e) => e.source === trigger.id);
  if (triggerOut) {
    const readId = 'state_read';
    nodes.push({
      id: readId,
      type: 'workflow_store',
      title: 'Load Seen State',
      position: { x: trigger.position.x + 200, y: trigger.position.y + 120 },
      config: { kind: 'workflow_store', operations: [{ op: 'get', key: 'seen', outputKey: 'seen' }] },
    } as unknown as WorkflowNode);
    const target = triggerOut.target;
    triggerOut.target = readId;
    edges.push({ id: `edge_${readId}_${target}`, source: readId, target });
    added.push({ id: readId, message: 'Added a workflow_store read after the trigger so recurring runs remember prior state (Rule 13).' });
  }

  // Write node, spliced before the terminal.
  const terminalIn = edges.find((e) => e.target === terminal.id);
  if (terminalIn) {
    const writeId = 'state_write';
    nodes.push({
      id: writeId,
      type: 'workflow_store',
      title: 'Persist Seen State',
      position: { x: terminal.position.x - 200, y: terminal.position.y + 120 },
      // `set` persists the accumulated `seen` state for the next run. `{{seen}}`
      // is the conventional handle the dedup step downstream of the read should
      // produce; the operator wires the real value on the canvas. (Was `write`,
      // which is NOT a valid workflow_store op — the engine rejects it at run
      // time with "unknown op write", taking the whole recurring workflow down.)
      config: { kind: 'workflow_store', operations: [{ op: 'set', key: 'seen', value: '{{seen}}' }] },
    } as unknown as WorkflowNode);
    const source = terminalIn.source;
    terminalIn.source = writeId;
    edges.push({ id: `edge_${source}_${writeId}`, source, target: writeId });
    added.push({ id: writeId, message: 'Added a workflow_store write before the terminal so each run persists what it has seen (Rule 13).' });
  }

  return added.length > 0 ? { graph: { ...graph, nodes, edges }, added } : { graph, added: [] };
}

/** One reviewer critique against the workflow grammar (inspectable). */
export interface BuildCritique {
  rule: number;
  severity: 'info' | 'warn' | 'error';
  nodeId?: string;
  message: string;
}

/**
 * LLM reviewer/critic (10X-CREATION-SWARM-PLAN Milestone 2). Audits the
 * candidate graph against the Iron Rules and returns inspectable critiques plus
 * an optionally repaired graph. This is the "Reviewer specialist" that catches
 * what a small architect model misses (lazy agent chains, missing fetch/guard
 * nodes). Failure-tolerant: returns no critiques on any parse/transport error.
 */
async function reviewWorkflowGraph(
  runtime: StructuredCompleter,
  args: { graph: WorkflowGraph; description: string; brief?: CreationBrief },
  signal?: AbortSignal,
): Promise<{ critiques: BuildCritique[]; repairedGraph: WorkflowGraph | null }> {
  const system = [
    SYNTHESIS_ARCHITECT_PREAMBLE,
    'You are the REVIEWER. Audit the candidate WorkflowGraph against the IRON RULES above.',
    'Return ONLY a JSON object of shape:',
    '{ "critiques": [{ "rule": <1-13>, "severity": "info"|"warn"|"error", "nodeId"?: "<id>", "message": "<what is wrong and the fix>" }],',
    '  "repairedGraph"?: { "version": 1, "nodes": [...], "edges": [...], "viewport": { "x":0,"y":0,"zoom":1 } } }',
    'Rules: If the graph already obeys every rule, return "critiques": [] and OMIT repairedGraph.',
    'If you find violations you can fix (lazy agent_task doing fetch/delivery, missing http_request/integration/',
    'evaluator/terminal, serial work that should be parallel), return the FULL corrected graph in repairedGraph,',
    'preserving valid nodes and ids where possible. Never collapse the workflow into a single agent_task.',
  ].join('\n');
  const user = [
    args.brief ? renderCreationBrief(args.brief) : '',
    `DESCRIPTION:\n${args.description}`,
    `CANDIDATE GRAPH:\n${JSON.stringify(args.graph)}`,
  ].filter(Boolean).join('\n\n');

  const result = await runtime.completeStructured<{ critiques?: unknown; repairedGraph?: unknown }>({
    system,
    user,
    maxTokens: 3000,
    maxAttempts: 2,
    ...(signal ? { signal } : {}),
  });
  if (!result) return { critiques: [], repairedGraph: null };

  const critiques: BuildCritique[] = Array.isArray(result.critiques)
    ? result.critiques
        .map((c): BuildCritique | null => {
          if (!c || typeof c !== 'object') return null;
          const o = c as Record<string, unknown>;
          const rule = typeof o.rule === 'number' ? o.rule : Number(o.rule) || 0;
          const sev = o.severity === 'error' || o.severity === 'warn' || o.severity === 'info' ? o.severity : 'warn';
          const message = typeof o.message === 'string' ? o.message : '';
          if (!message) return null;
          return { rule, severity: sev, message, ...(typeof o.nodeId === 'string' ? { nodeId: o.nodeId } : {}) };
        })
        .filter((c): c is BuildCritique => c !== null)
        .slice(0, 12)
    : [];

  // Accept either { repairedGraph: { nodes,... } } or { repairedGraph: { graph: {...} } }.
  let repairedGraph: WorkflowGraph | null = null;
  const rg = result.repairedGraph as { graph?: unknown; nodes?: unknown } | undefined;
  const candidate = (rg && typeof rg === 'object' && 'graph' in rg ? (rg as { graph?: unknown }).graph : rg) as
    | { nodes?: unknown; edges?: unknown; viewport?: unknown }
    | undefined;
  if (candidate && Array.isArray(candidate.nodes) && candidate.nodes.length > 0) {
    const normalized: WorkflowGraph = {
      version: 1,
      nodes: candidate.nodes as WorkflowGraph['nodes'],
      edges: Array.isArray(candidate.edges) ? (candidate.edges as WorkflowGraph['edges']) : [],
      viewport: (candidate.viewport as WorkflowGraph['viewport']) ?? { x: 0, y: 0, zoom: 1 },
    };
    try {
      validateWorkflowGraph(normalized);
      repairedGraph = normalized;
    } catch {
      repairedGraph = null;
    }
  }
  return { critiques, repairedGraph };
}

/** A reasonable default connector operation per slug, so a plan-built integration node is graph-valid. */
function defaultOperationForSlug(slug: string): string {
  const map: Record<string, string> = {
    agentmail: 'send_message', gmail: 'send_email', slack: 'send_message', discord: 'send_message', telegram: 'send_message',
    google_sheets: 'append_row', sheets: 'append_row', notion: 'create_page', airtable: 'create_record',
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

/** Deterministic trigger inference from the prompt (Step 2 — intent extraction). */
function inferTriggerConfig(lower: string): {
  kind: 'trigger';
  triggerType: 'manual' | 'cron' | 'webhook' | 'persistent_listener';
  schedule?: string;
} {
  if (/\bwebhook\b|\bincoming (request|http|post)\b/.test(lower)) {
    return { kind: 'trigger', triggerType: 'webhook' };
  }
  const persistentListenerIntent =
    /\b(24\/7|constantly|continuously|always[- ]on|in real time|immediately|as soon as)\b/.test(lower)
    || /\b(watch|monitor|listen)\b[\s\S]{0,80}\b(new|changes?|updates?|posts?|events?|items?)\b/.test(lower)
    || /\bwhen(?:ever)?\b[\s\S]{0,80}\b(new|changes?|updates?|posts?|events?|items?)\b/.test(lower);
  const scheduledIntent = /\b(every|daily|weekly|hourly|monthly|schedule|cron)\b/.test(lower);
  if (persistentListenerIntent && !scheduledIntent) {
    return { kind: 'trigger', triggerType: 'persistent_listener' };
  }
  if (/\bevery (day|morning)\b|\bdaily\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * *' };
  if (/\bevery week\b|\bweekly\b|\bevery monday\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * MON' };
  if (/\bevery hour\b|\bhourly\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 * * * *' };
  if (/\bevery (\d+) ?min/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '*/15 * * * *' };
  if (/\bschedule\b|\bcron\b|\bon a schedule\b/.test(lower)) return { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * *' };
  return { kind: 'trigger', triggerType: 'manual' };
}

function triggerTitle(t: { triggerType: string }): string {
  return t.triggerType === 'cron'
    ? 'Schedule Trigger'
    : t.triggerType === 'webhook'
      ? 'Webhook Trigger'
      : t.triggerType === 'persistent_listener'
        ? 'Persistent Listener'
        : 'Manual Trigger';
}

/**
 * When the request states a recurring schedule, turn the workflow's trigger node
 * into a REAL cron trigger: mutate the node to `triggerType:'cron'` + a linked
 * `triggerId`, and return the parsed UTC cron so the caller can upsert the
 * (paused) trigger row. Idempotent on rebuild — reuses an existing cron row for
 * this workflow. Returns null when there's no schedule or no trigger node.
 */
function applyScheduleTrigger(
  deps: ToolHandlerDeps,
  args: CreateWorkflowArgs,
  graph: WorkflowGraph,
  workflowId: string,
): { nodeId: string; cron: string; timezone: string | null; triggerId: string; detail: string } | null {
  const parsed = scheduleFromNaturalLanguage(args.description);
  if (!parsed) return null;
  const triggerNode = graph.nodes.find((n) => nodeKind(n) === 'trigger');
  if (!triggerNode) return null;
  const cfg = triggerNode.config as { kind: 'trigger'; triggerType?: string; triggerId?: string };
  const existing = deps.db
    .select({ id: schema.triggers.id })
    .from(schema.triggers)
    .where(and(eq(schema.triggers.workflowId, workflowId), eq(schema.triggers.triggerType, 'cron')))
    .get();
  const triggerId = existing?.id ?? cfg.triggerId ?? randomUUID();
  cfg.triggerType = 'cron';
  cfg.triggerId = triggerId;
  triggerNode.title = 'Schedule Trigger';
  return { nodeId: triggerNode.id, cron: parsed.cron, timezone: parsed.timezone, triggerId, detail: parsed.detail };
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
 * A {@link StructuredCompleter} backed by the building agent's OWN live adapter,
 * or undefined when that agent isn't connected / can't chat. This is the
 * agentic default: with no dedicated synthesis model configured, the agent the
 * operator is talking to builds the workflow with its own model — the same one
 * already answering their chat. (Model-agnostic: any chat-capable runtime works.)
 */
function agentChatAdapter(deps: ToolHandlerDeps, agentId?: string): AgentAdapter | undefined {
  if (!agentId) return undefined;
  // Defensive: `adapters` may be a partial/mock in some call sites — only call
  // `.get` when it's actually a function (a truthy `{}` would throw otherwise).
  const reg = typeof deps.adapters?.get === 'function' ? deps.adapters.get(agentId) : undefined;
  if (!reg?.adapter?.chat) return undefined;
  if (reg.adapter.capabilities?.().interactiveChat === false) return undefined;
  return reg.adapter;
}

/** True when an adapter answers chat by RE-SPAWNING a CLI process per round
 *  (Codex / Claude Code). Fine for one chat reply, but murderous for the ~6
 *  sequential model calls a build makes — the cause of multi-minute builds. */
function isSlowPerCallHarness(adapter: AgentAdapter | undefined): boolean {
  const fwd = adapter?.capabilities?.().toolForwarding;
  return fwd === 'marker_protocol' || fwd === 'mcp_native';
}

/**
 * The "own model" completer for a build role. ZERO-CONFIG by design: the model the
 * operator already attached to their agent IS the synthesis model — there is no
 * separate "set a synthesis model" step. The only nuance is SPEED — if the agent
 * answers chat through a slow per-call CLI harness, we synthesize through a
 * streaming orchestrator model when one is configured (mirrors the chat loop's
 * fast-path) so builds stay seconds, not minutes. Falls back to the agent's own
 * adapter even when slow — a slow build still beats refusing to build.
 */
function ownModelCompleter(
  deps: ToolHandlerDeps,
  workspaceId: string,
  agentId: string | undefined,
  routerRole: 'synthesis' | 'evaluation',
): StructuredCompleter | undefined {
  const agent = agentChatAdapter(deps, agentId);
  if (agent && !isSlowPerCallHarness(agent)) return new AdapterStructuredCompleter(agent);
  const streaming = deps.modelRouter?.resolve(routerRole, workspaceId)
    ?? deps.modelRouter?.resolve('conversation', workspaceId);
  if (streaming) return new AdapterStructuredCompleter(streaming);
  if (agent) return new AdapterStructuredCompleter(agent);
  return undefined;
}

/**
 * The structured completer for the synthesis role, in precedence order:
 * per-workspace synthesis runtime → dedicated synthesis runtime → evaluator
 * runtime → the agent's own model (streaming fast-path preferred). Undefined only
 * when nothing at all can build (no configured model AND no chat-capable agent).
 */
function resolveSynthesisCompleter(deps: ToolHandlerDeps, workspaceId: string, agentId?: string): StructuredCompleter | undefined {
  return deps.resolveEvaluatorRuntime?.(workspaceId, 'synthesis')
    ?? deps.synthesisRuntime
    ?? deps.evaluatorRuntime
    ?? ownModelCompleter(deps, workspaceId, agentId, 'synthesis');
}

/** The completer for the reviewer/critic role — prefers an evaluation model. */
function resolveReviewerCompleter(deps: ToolHandlerDeps, workspaceId: string, agentId?: string): StructuredCompleter | undefined {
  return deps.resolveEvaluatorRuntime?.(workspaceId, 'evaluation')
    ?? deps.resolveEvaluatorRuntime?.(workspaceId, 'synthesis')
    ?? deps.synthesisRuntime
    ?? deps.evaluatorRuntime
    ?? ownModelCompleter(deps, workspaceId, agentId, 'evaluation');
}

/**
 * Whether this build can ONLY run through a slow per-call CLI harness — no
 * configured runtime, no streaming orchestrator model, and the agent re-spawns
 * per call. When true we skip the optional reviewer audit (a second set of model
 * round-trips) so a slow setup still returns a workflow quickly; the
 * deterministic `repairGraph` still enforces the Iron Rules structurally.
 */
function buildOnlyHasSlowPath(deps: ToolHandlerDeps, workspaceId: string, agentId?: string): boolean {
  const hasFastRuntime = Boolean(
    deps.resolveEvaluatorRuntime?.(workspaceId, 'synthesis')
    ?? deps.resolveEvaluatorRuntime?.(workspaceId, 'evaluation')
    ?? deps.synthesisRuntime
    ?? deps.evaluatorRuntime
    ?? deps.modelRouter?.resolve('synthesis', workspaceId)
    ?? deps.modelRouter?.resolve('conversation', workspaceId),
  );
  if (hasFastRuntime) return false;
  return isSlowPerCallHarness(agentChatAdapter(deps, agentId));
}

/** Why synthesis produced no graph — drives the inspectable `blocked` phase. */
export type SynthesisOutcome =
  | { graph: WorkflowGraph; reason: 'ok' }
  | { graph: null; reason: 'model_error' | 'invalid_graph'; error: string | null };

type WorkflowMutationPatchPayload = {
  addNodes?: unknown;
  updateNodes?: unknown;
  removeNodeIds?: unknown;
  addEdges?: unknown;
  removeEdgeIds?: unknown;
};

function applyWorkflowMutationPatch(base: WorkflowGraph, value: unknown): WorkflowGraph {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('the model did not return a workflow patch object');
  }
  const patch = value as WorkflowMutationPatchPayload;
  const addNodes = arrayOfObjects(patch.addNodes) as unknown as WorkflowGraph['nodes'];
  const updateNodes = arrayOfObjects(patch.updateNodes) as unknown as WorkflowGraph['nodes'];
  const removeNodeIds = arrayOfStrings(patch.removeNodeIds);
  const addEdges = arrayOfObjects(patch.addEdges) as unknown as WorkflowGraph['edges'];
  const removeEdgeIds = arrayOfStrings(patch.removeEdgeIds);
  const baseNodeIds = new Set(base.nodes.map((node) => node.id));
  const baseEdgeIds = new Set(base.edges.map((edge) => edge.id));

  for (const node of updateNodes) {
    if (!node.id || !baseNodeIds.has(node.id)) {
      throw new Error(`updateNodes references unknown node "${node.id ?? ''}"`);
    }
  }
  for (const node of addNodes) {
    if (!node.id || baseNodeIds.has(node.id)) {
      throw new Error(`addNodes must use a new node id (received "${node.id ?? ''}")`);
    }
  }
  for (const id of removeNodeIds) {
    if (!baseNodeIds.has(id)) throw new Error(`removeNodeIds references unknown node "${id}"`);
  }
  for (const id of removeEdgeIds) {
    if (!baseEdgeIds.has(id)) throw new Error(`removeEdgeIds references unknown edge "${id}"`);
  }

  const removedNodes = new Set(removeNodeIds);
  const updates = new Map(updateNodes.map((node) => [node.id, node]));
  const nodes = base.nodes
    .filter((node) => !removedNodes.has(node.id))
    .map((node) => updates.get(node.id) ?? node)
    .concat(addNodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const removedEdges = new Set(removeEdgeIds);
  const edges = base.edges
    .filter((edge) => !removedEdges.has(edge.id))
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .concat(addEdges);

  return { ...base, nodes, edges };
}

function arrayOfObjects(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('workflow patch object lists must be arrays');
  }
  return value as Record<string, unknown>[];
}

function arrayOfStrings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('workflow patch id lists must be string arrays');
  }
  return value;
}

function assertMutationPreservesGraph(
  base: WorkflowGraph,
  candidate: WorkflowGraph,
  instruction: string,
): void {
  if (allowsWholeWorkflowReplacement(instruction)) return;
  const candidateNodeIds = new Set(candidate.nodes.map((node) => node.id));
  const candidateEdgeIds = new Set(candidate.edges.map((edge) => edge.id));
  const retainedNodes = base.nodes.filter((node) => candidateNodeIds.has(node.id)).length;
  const retainedEdges = base.edges.filter((edge) => candidateEdgeIds.has(edge.id)).length;
  const minimumNodes = base.nodes.length < 4 ? 1 : Math.ceil(base.nodes.length * 0.6);
  const minimumEdges = base.edges.length < 3 ? 0 : Math.ceil(base.edges.length * 0.5);
  if (retainedNodes < minimumNodes || retainedEdges < minimumEdges) {
    throw new Error(
      `the proposed edit is destructive (${retainedNodes}/${base.nodes.length} nodes and `
      + `${retainedEdges}/${base.edges.length} edges retained)`,
    );
  }
}

function allowsWholeWorkflowReplacement(instruction: string): boolean {
  return /\b(?:replace|rebuild|redesign|start\s+over|from\s+scratch|rewrite\s+the\s+(?:entire|whole)|completely\s+rewrite)\b/i
    .test(instruction);
}

/**
 * LLM-based workflow synthesis.
 *
 * Asks the resolved completer (a configured model endpoint, or the building
 * agent's own model) to design a `WorkflowGraph` from a natural-language
 * description, then validates the result against the same `validateWorkflowGraph`
 * contract operators see in the canvas.
 *
 * Returns an inspectable outcome rather than a bare null so the caller can tell
 * the operator the REAL reason a build failed (e.g. the backend's own error
 * message) instead of a generic "couldn't build".
 */
async function synthesizeWithLlm(
  description: string,
  deps: ToolHandlerDeps,
  workspaceId: string,
  completer: StructuredCompleter,
  brief?: CreationBrief,
  signal?: AbortSignal,
  mutation?: { title: string; graph: WorkflowGraph },
): Promise<SynthesisOutcome> {
  const runtime = completer;
  const inv = brief?.inventory;
  // Surface the user's existing agents + extensions + knowledge bases so the model
  // can reference real IDs instead of placeholders.
  const agents = deps.db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      capabilityTags: schema.agents.capabilityTags,
      adapterType: schema.agents.adapterType,
      status: schema.agents.status,
    })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
  const knowledgeBases = deps.knowledgeBases
    ? deps.knowledgeBases.listKnowledgeBases(workspaceId).map((kb) => ({ id: kb.id, name: kb.name }))
    : [];
  const extensions = deps.db
    .select()
    .from(schema.extensions)
    .where(eq(schema.extensions.workspaceId, workspaceId))
    .all()
    .map((extension) => {
      const manifest = extension.manifest as Partial<ExtensionManifest>;
      return {
        id: extension.id,
        name: extension.name,
        slug: extension.slug,
        runtime: extension.runtime,
        entrypoint: typeof manifest.entrypoint === 'string' ? manifest.entrypoint : extension.slug,
        capabilityTags: Array.isArray(manifest.capabilityTags) ? manifest.capabilityTags.filter((tag): tag is string => typeof tag === 'string') : [],
        operations: Array.isArray(manifest.operations) ? manifest.operations : [],
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
      ? `\nBOUND AGENTS (pin only when you truly need a specific connected runtime; otherwise prefer agentRole):\n${agents.slice(0, 12).map((a) => `- ${a.id}: ${a.name} status=${a.status} adapter=${a.adapterType} tags=${(a.capabilityTags as string[] | undefined)?.join(', ') ?? 'none'}`).join('\n')}`
      : '',
    knowledgeBases.length > 0
      ? `\nAVAILABLE KNOWLEDGE BASES:\n${knowledgeBases.slice(0, 8).map((kb) => `- ${kb.id}: ${kb.name}`).join('\n')}`
      : '',
    inv && inv.knowledgeExcerpts.length > 0
      ? `\nBRAIN CONTEXT FOR THIS REQUEST (actual passages retrieved from the workspace Brain — use these to decide whether a knowledge node is warranted, which base to target, and a static query that will return content):\n${inv.knowledgeExcerpts.slice(0, 5).map((e) => `- [kb:${e.knowledgeBaseId}] ${e.content.replace(/\s+/g, ' ').trim().slice(0, 280)}`).join('\n')}`
      : '',
    extensions.length > 0
      ? `\nAVAILABLE EXTENSIONS (use real IDs; operations marked [listener-source] may power a persistent_listener trigger):\n${extensions.slice(0, 16).map((extension) => `- ${extension.id}: ${extension.name} slug=${extension.slug} runtime=${extension.runtime} operations=${extension.operations.map((op) => `${op.name}${op.isListenerSource ? '[listener-source]' : ''}`).join(', ') || 'execute'} tags=${extension.capabilityTags.join(', ') || 'none'}`).join('\n')}`
      : '',
    mutation
      ? `\nTHIS IS AN IN-PLACE EDIT OF "${mutation.title}", NOT A NEW WORKFLOW.\n`
        + 'Return {"patch":{"addNodes":[],"updateNodes":[],"removeNodeIds":[],"addEdges":[],"removeEdgeIds":[]}}. '
        + 'Each updateNodes entry is the complete revised node with the SAME id. Preserve every unrelated node, edge, trigger, credential reference, schedule, state step, and output. '
        + 'Use removals only when the request requires them. Never replace the workflow with a smaller generic example.\n'
        + `CURRENT WORKFLOW GRAPH:\n${JSON.stringify(mutation.graph)}`
      : '',
  ].filter(Boolean).join('\n');

  // Self-correcting synthesis loop. A weak model often gets the graph *almost*
  // right (a stray cycle, a dangling edge). We deterministically repair the
  // common structural mistakes and, if the draft is still invalid, feed the
  // EXACT validation error back so the model can fix it on the next pass —
  // model-agnostic, no per-family tuning. Bounded so a failing model can't loop.
  let attemptPrompt = userPrompt;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) return { graph: null, reason: 'model_error', error: 'canceled' };
    const result = await runtime.completeStructured<{ graph?: unknown; patch?: unknown }>({
      system: systemPrompt,
      user: attemptPrompt,
      maxTokens: 2500,
      timeoutMs: 30_000,
      // The outer self-correction loop already retries with validation feedback,
      // so keep inner JSON-parse retries low to bound worst-case latency.
      maxAttempts: 2,
      ...(signal ? { signal } : {}),
    });
    if (!result || (!result.graph && !result.patch)) {
      // A transport/parse failure (or no model) won't improve by re-asking for a
      // different graph — surface the real backend error and stop.
      lastError = runtime.lastError ?? 'the model did not return a workflow graph';
      deps.logger.warn('synthesizeWithLlm.no_graph', { workspaceId, error: lastError, attempt });
      return { graph: null, reason: 'model_error', error: lastError };
    }
    let graph: WorkflowGraph;
    try {
      graph = mutation && result.patch
        ? applyWorkflowMutationPatch(mutation.graph, result.patch)
        : result.graph as WorkflowGraph;
      if (mutation) assertMutationPreservesGraph(mutation.graph, graph, description);
    } catch (err) {
      lastError = (err as Error).message;
      deps.logger.warn('synthesizeWithLlm.invalid_mutation', { err: lastError, attempt });
      attemptPrompt = `${userPrompt}\n\nYOUR PREVIOUS PATCH WAS REJECTED: ${lastError}\n`
        + 'Return a minimal patch that preserves all unrelated nodes and edges.';
      continue;
    }
    // Defensive normalization — the model can omit version/viewport.
    const normalized: WorkflowGraph = {
      version: 1,
      nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
      edges: Array.isArray(graph.edges) ? graph.edges : [],
      viewport: graph.viewport ?? { x: 0, y: 0, zoom: 1 },
    };
    // Probe validity against a deterministically-repaired copy (cycles, dangling
    // edges, delivery/state). We return the UNREPAIRED graph on success so the
    // main pipeline's repairGraph performs — and records in the trace — the
    // actual fixes; here repair is only the "is this salvageable?" oracle.
    const probe = brief ? repairGraph(normalized, brief.classification, brief.inventory).graph : normalized;
    try {
      validateWorkflowGraph(probe);
      return { graph: normalized, reason: 'ok' };
    } catch (err) {
      lastError = (err as Error).message;
      deps.logger.warn('synthesizeWithLlm.invalid_graph', { err: lastError, attempt });
      attemptPrompt = `${userPrompt}\n\nYOUR PREVIOUS GRAPH WAS REJECTED: ${lastError}\n`
        + 'Return a corrected graph. The graph MUST be acyclic (no edge may point back to an earlier node), '
        + 'every edge must connect two real node ids, and the workflow must end in a return_output or artifact_save node.';
    }
  }
  return { graph: null, reason: 'invalid_graph', error: lastError };
}

function isSynthesisRuntimeFailure(error: string | null | undefined): boolean {
  return Boolean(error && /\b(timeout|timed out|aborted|canceled|transport|channel closed|request failed|connection|network|unavailable|process error)\b/i.test(error));
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

interface DeterministicCompileResult {
  graph: WorkflowGraph;
  detail: string;
}

function tryCompileDeterministicWorkflow(description: string): DeterministicCompileResult | null {
  // NOTE: there is intentionally NO connector-specific compiler here (e.g. a
  // hardcoded "email" graph). Real requests — email, Slack, HTTP, anything —
  // go through the general synthesis path so the platform stays domain-agnostic.
  // These two remain only as tiny, content-free fast-paths for genuinely
  // trivial shapes (a fixed output, a generic research report).
  return compileFixedOutputWorkflow(description)
    ?? compileResearchReportWorkflow(description);
}

function compileFixedOutputWorkflow(description: string): DeterministicCompileResult | null {
  const lower = description.toLowerCase();
  if (!/\b(return|returns|output|hello world|fixed)\b/.test(lower)) return null;
  const text = description.match(/\btext\s*:\s*["']([^"']+)["']/i)?.[1]
    ?? description.match(/\b(?:return|returns|output)\s+["']([^"']+)["']/i)?.[1]
    ?? (/hello world/i.test(description) ? 'Workflow is working' : null);
  if (!text) return null;
  const graph: WorkflowGraph = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Manual Trigger', position: { x: 0, y: 80 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'produce_output', type: 'transform', title: 'Produce Output', position: { x: 280, y: 80 }, config: { kind: 'transform', expression: JSON.stringify({ text }) } },
      { id: 'return_output', type: 'return_output', title: 'Return Output', position: { x: 560, y: 80 }, config: { kind: 'return_output', renderAs: 'text' } },
    ],
    edges: [
      { id: 'edge_trigger_produce_output', source: 'trigger', target: 'produce_output' },
      { id: 'edge_produce_output_return_output', source: 'produce_output', target: 'return_output' },
    ],
  };
  return { graph, detail: 'Compiled fixed-output workflow' };
}

function compileResearchReportWorkflow(description: string): DeterministicCompileResult | null {
  const lower = description.toLowerCase();
  if (!/\bresearch\b/.test(lower) || !/\b(report|brief|summar)/.test(lower)) return null;
  const trigger = inferTriggerConfig(lower);
  const graph: WorkflowGraph = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'trigger', type: 'trigger', title: triggerTitle(trigger), position: { x: 0, y: 80 }, config: trigger },
      {
        id: 'research',
        type: 'agent_task',
        title: 'Research Sources',
        position: { x: 280, y: 80 },
        config: {
          kind: 'agent_task',
          agentRole: 'researcher',
          prompt: `Research the source material for this request:\n${description}`,
          inputKeys: ['trigger'],
          outputKeys: ['findings'],
          capabilityTags: ['research'],
        },
      },
      {
        id: 'analyze',
        type: 'agent_task',
        title: 'Analyze Findings',
        position: { x: 560, y: 80 },
        config: {
          kind: 'agent_task',
          agentRole: 'analyst',
          prompt: 'Analyze the research findings and identify the most important moves, risks, and opportunities.',
          inputKeys: ['research'],
          outputKeys: ['analysis'],
          capabilityTags: ['analysis'],
          skills: ['aarrr-framework'],
        },
      },
      {
        id: 'write_report',
        type: 'agent_task',
        title: 'Write Report',
        position: { x: 840, y: 80 },
        config: {
          kind: 'agent_task',
          agentRole: 'writer',
          prompt: 'Write a concise report from the analysis with a summary, key points, and recommended next actions.',
          inputKeys: ['analyze'],
          outputKeys: ['report'],
          capabilityTags: ['writing'],
        },
      },
      { id: 'return_output', type: 'return_output', title: 'Return Report', position: { x: 1120, y: 80 }, config: { kind: 'return_output', renderAs: 'markdown' } },
    ],
    edges: [
      { id: 'edge_trigger_research', source: 'trigger', target: 'research' },
      { id: 'edge_research_analyze', source: 'research', target: 'analyze' },
      { id: 'edge_analyze_write_report', source: 'analyze', target: 'write_report' },
      { id: 'edge_write_report_return_output', source: 'write_report', target: 'return_output' },
    ],
  };
  return { graph, detail: 'Compiled specialist research-report workflow' };
}

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
  '  intel:   agent_task, agent_session, skill_task, agent_swarm, dynamic_swarm, planner, evaluator, guardrails',
  '  know:    knowledge, artifact_collect',
  '  output:  return_output, artifact_save',
  '  native:  browser',
  '  human:   checkpoint',
  '',
  'Required config fields per kind (anything else is optional):',
  '  trigger:        { kind: "trigger", triggerType: "manual" | "cron" | "webhook" | "persistent_listener" }',
  '                  cron also requires schedule (five-field cron) and optional timezone.',
  '                  persistent_listener also requires listenerConfig: { source, predicate?, firePolicy? }.',
  '                  When the operator asks to watch/listen continuously, 24/7, or react immediately to new items, use',
  '                  persistent_listener, not cron. If they requested a new extension, bind its real listener-source',
  '                  operation as listenerConfig.source = { kind:"extension", extensionId, operationName, config, pollIntervalMs }.',
  '  agent_task:     { kind: "agent_task", prompt, capabilityTags, inputKeys, outputKeys, agentId?, agentRole?, requires? }',
  '                  A REAL tool-using agent (not a single completion): it runs a bounded reason→act→observe loop and can',
  '                  search the web + knowledge base, recall/record memory, persist workflow state, run sandboxed compute,',
  '                  and call other workflows — so give it an ambitious mission, not a one-line instruction. agentRole picks',
  '                  a specialist: a built-in (planner|researcher|coder|reviewer|analyst|writer|monitor|architect|debugger|deployer)',
  '                  OR a custom slug (e.g. "frontend_architect", "tax_analyst") which is auto-created as an on-demand specialist.',
  '                  Prefer agentRole over a blank agentId so the task is runnable without manual binding. Set useRoleTools:false',
  '                  ONLY for a pure one-shot rewrite/format with no reasoning. requires = hard affordances e.g. { "browser": true }.',
  '  agent_session:  { kind: "agent_session", prompt, agentRole, inputKeys, outputKeys, capabilityTags, maxSteps? }',
  '                  A PERSISTENT autonomous agent for longer, multi-step missions: it keeps memory across steps, can DELEGATE',
  '                  sub-tasks to other specialists and await their results, wait for events, and pause for approval — sleeping',
  '                  at zero cost while it waits. Use this (not agent_task) when the work needs sub-agents, long research, or',
  '                  cross-step state. Heavier than agent_task; prefer agent_task for a single focused reasoning task.',
  '  dynamic_swarm:  { kind: "dynamic_swarm", goal, agentRole, maxTasks, maxParallel, mergeStrategy: "collect_all"|"first_success"|"majority_vote", outputKey, capabilityTags }',
  '                  A planner agent decides the task LIST at runtime from `goal`, then maxParallel workers (role=agentRole) run',
  '                  in parallel. Use for broad, parallelizable work whose item count is unknown up front (e.g. "research each',
  '                  competitor we discover"). The engine hard-caps maxTasks.',
  '  planner:        { kind: "planner", goal, agentRole?, workerRole?, inputKeys, outputKeys, maxNodes? }',
  '                  A planner agent decomposes `goal` and SPLICES the sub-steps into the live run as real agent nodes (they',
  '                  appear on the canvas and run through the engine). Use when the sub-structure is unknown until runtime.',
  '  skill_task:     { kind: "skill_task", skillId, inputMapping, outputMapping }',
  '  knowledge:      { kind: "knowledge", queryMode: "static" | "dynamic", topK, retrievalMode }',
  '  router:         { kind: "router", routingMode: "first_match" | "all_matching" | "llm_route", branches: [] }',
  '  merge:          { kind: "merge", requiredInputs: "all" | "any" }',
  '  checkpoint:     { kind: "checkpoint", approvalMode: "manual" | "auto_after_timeout" }',
  '  scratchpad:     { kind: "scratchpad", operation: "read"|"write"|"append"|"delete", key }',
  '  wait:           { kind: "wait", delayMs }',
  '  transform:      { kind: "transform", expression }',
  '                  Use this for ALL data shaping, projection, array filtering, dedupe, ranking, and object construction.',
  '                  Example: `({ articles: (nodes.fetch.results || []).filter(a => a.keep) })` belongs in transform.',
  '  filter:         { kind: "filter", condition }',
  '                  BOOLEAN ONLY. `condition` must evaluate to true/false. It is a gate, not a mapper. Do NOT return objects or arrays here.',
  '  integration:    { kind: "integration", integrationId, operationId, inputs }',
  '  http_request:   { kind: "http_request", method, url, headers?, body?, auth?, responseMapping? }',
  '                  responseMapping shape is EXACTLY `{ outputKey, bodyPath? }`. Example whole-body alias: `{ outputKey: "raw" }`.',
  '                  Example JSON extraction: `{ outputKey: "items", bodyPath: "data.items" }`. Never use `{ raw: "body" }` or `{ json: "body" }`.',
  '  workflow_store: { kind: "workflow_store", operations: [{ op, key, value?, outputKey? }] }',
  '                  op MUST be one of: get | set | delete | increment | append | get_all (NOT read/write).',
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
  'Router branch conditions are NOT template strings. Write safe conditions such as',
  '`inputs["fetch-feed"].count > 0` or `trigger.status == "ready"`.',
  'Never use `{{...}}`, `===`, or `!==` inside router branch conditions.',
  'For persistent_listener triggers, a single event arrives at the trigger/input root and also as',
  '`item`, with `events` and `count` convenience aliases. Do not assume a batched `posts[]` payload',
  'unless your listener fire policy or payloadTransform creates one explicitly.',
  '',
  'Edges: { id, source, target, type?: "default"|"error"|"condition" }. Wire an error edge',
  'when a node has a meaningful recovery path. Otherwise stick with default edges.',
  '',
  'Principles:',
  '- Every workflow starts with exactly one trigger node.',
  '- Prefer deterministic primitives (transform/filter/http_request/integration) over agent_task',
  '  whenever the step does NOT require reasoning. Saves cost and is more reliable.',
  '- If you need to FILTER an array and keep the filtered array for downstream nodes, that is still a `transform`, not a `filter` node.',
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
  '- Choosing the intelligence node: default to `agent_task` (a capable tool-using agent) for a focused reasoning task.',
  '  Use `agent_session` when the work must delegate to sub-specialists, run many steps, or keep memory across steps;',
  '  `dynamic_swarm` when an agent must fan out an unknown number of parallel sub-tasks; `planner` when the sub-structure',
  '  is unknown until runtime. Do NOT chain many agent_tasks when one agent_session that delegates would be cleaner.',
  '- Use `evaluator` after an `agent_task` whenever output quality matters; route its FAIL handle',
  '  back to the agent_task with the critique embedded via `{{nodes.<EVALID>.critique}}`.',
  '- Use `checkpoint` only when human review is genuinely needed (irreversible action, high spend).',
  '- Always give each node a stable string `id` (kebab-case) and a human-readable `title`.',
  '- Place nodes left-to-right: trigger at x ≈ 0, each downstream step at x += 260.',
].join('\n');
