/**
 * Workflow Engine.
 *
 * Owns the run lifecycle. BullMQ (or in-process queue) is plumbing for
 * durability and delayed wake-ups; the engine owns:
 *   - run-state transitions
 *   - the deterministic ready queue
 *   - multi-input buffering (waitingInputs)
 *   - dispatch to skills/agents/subflows/routers
 *   - ledger writes
 *   - snapshot cadence
 *   - completion / failure / cancellation
 *
 * V1 scope: full happy path for skill_task and trigger nodes; agent_task
 * dispatches through AdapterManager but completion arrives async via
 * `notifyTaskCompleted()`/`notifyTaskFailed()`. Router/merge/checkpoint/
 * subflow/scratchpad nodes are scaffolded with their happy-path semantics
 * and are exercised by the dashboard. Replay paths are implemented at the
 * level the spec demands but not all branches have e2e tests yet
 * (DEBT in DECISIONS.md).
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  CONSTANTS,
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowRunState,
  type WorkflowRunStatus,
  type ReadyQueueItem,
  type SkillTaskNodeConfig,
  type AgentTaskNodeConfig,
  type KnowledgeNodeConfig,
  type RouterNodeConfig,
  type MergeNodeConfig,
  type CheckpointNodeConfig,
  type ScratchpadNodeConfig,
  type AgentSwarmNodeConfig,
  type ArtifactCollectNodeConfig,
  type WaitNodeConfig,
  type TransformNodeConfig,
  type FilterNodeConfig,
  type IntegrationNodeConfig,
  type HttpRequestNodeConfig,
  type WorkflowStoreNodeConfig,
  type WorkspaceStoreNodeConfig,
  type EvaluatorNodeConfig,
  type GuardrailsNodeConfig,
  type LoopNodeConfig,
  type ParallelNodeConfig,
  type ReturnOutputNodeConfig,
  type ArtifactSaveNodeConfig,
  type BrowserNodeConfig,
  type WorkflowEdge,
  type WorkflowGraphPatch,
  specialistForRole,
  isAgentRole,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { LedgerService } from '../services/ledger.js';
import type { ScratchpadService } from '../services/scratchpad.js';
import type { ActivityFeedService } from '../services/activityFeed.js';
import type { ApprovalInboxService } from '../services/approvalInbox.js';
import type { SkillRuntime } from '../services/skillRuntime.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { SubflowExecutor } from '../services/subflowExecutor.js';
import type { KnowledgeBaseService } from '../services/knowledgeBase.js';
import type { ConversationStore } from '../services/conversationStore.js';
import type { ConnectorRegistry } from '@agentis/integrations';
import type { WorkflowStoreService } from '../services/workflowStore.js';
import type { WorkspaceStoreService } from '../services/workspaceStore.js';
import type { EvaluatorRuntime } from '../services/evaluatorRuntime.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { WorkspaceIntelligenceService } from '../services/workspaceIntelligence.js';
import type { BrowserPool } from '../services/browserPool.js';
import type { SpecialistAgentService } from '../services/specialistAgents.js';
import type { AuditTrailService } from '../services/auditTrail.js';
import type { InstinctEngine } from '../services/instinctEngine.js';
import type { SkillLibraryService } from '../services/skillLibrary.js';
import type { AgentToolRuntime } from '../services/agentToolRuntime.js';
import { AgentToolLoop } from '../services/agentToolLoop.js';
import type { AgentMemoryService } from '../services/agentMemory.js';
import { evalCondition } from './SafeConditionParser.js';
import { validateWorkflowGraph } from './validateGraph.js';
import { noopTelemetry, type Telemetry } from '../telemetry/index.js';
import { buildTemplateContext, resolveTemplate, resolveTemplateDeep, readTemplatePath, type TemplateContext } from './templateResolver.js';
import { evaluateExpression, evaluateBooleanExpression } from './safeExpression.js';

export interface EngineDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  logger: Logger;
  ledger: LedgerService;
  scratchpad: ScratchpadService;
  activity: ActivityFeedService;
  approvals: ApprovalInboxService;
  skills: SkillRuntime;
  adapters: AdapterManager;
  subflows?: SubflowExecutor;
  knowledgeBases?: KnowledgeBaseService;
  /** Conversation bridge — lets chat-started runs report terminal state back to the thread. */
  conversations?: ConversationStore;
  /** Integration connector registry — required for `integration` and `http_request` nodes. */
  connectors?: ConnectorRegistry;
  /** Workflow-scoped KV — required for `workflow_store` nodes. */
  workflowStore?: WorkflowStoreService;
  /** Workspace-scoped KV (Tier 3) — required for `workspace_store` nodes + `{{workspace.kv.*}}`. */
  workspaceStore?: WorkspaceStoreService;
  /** LLM-as-judge runtime — required for `evaluator` nodes and the `router` llm_route mode. */
  evaluatorRuntime?: EvaluatorRuntime;
  /** Credential vault — required for `integration` nodes that need decrypted credentials. */
  vault?: CredentialVault;
  /** Workspace Intelligence — injects WORKSPACE.md/MEMORY.md context into agent_task prompts (Layer 1). */
  workspaceIntelligence?: WorkspaceIntelligenceService;
  /** Native Playwright runtime — required for `browser` nodes. */
  browserPool?: BrowserPool;
  /** Specialist agent library — resolves `agent_task.agentRole` → agentId (Layer 2). */
  specialists?: SpecialistAgentService;
  /** Full per-run audit trail (§5.4). Best-effort; never blocks a run. */
  audit?: AuditTrailService;
  /** Self-improvement: analyzes failed runs for repeat patterns (§7.2). */
  instincts?: InstinctEngine;
  /** Behavioral skill protocols injected into agent prompts (§2.5). */
  skillLibrary?: SkillLibraryService;
  /** Role-scoped tool execution (§2.2.1) — consumed by the agentic tool-use loop. */
  agentTools?: AgentToolRuntime;
  /** Agent-scoped personal memory (§G11) — injected into each dispatched agent's preamble. */
  agentMemory?: AgentMemoryService;
  /** Optional tracer; defaults to a no-op so tests stay free of OTel deps. */
  telemetry?: Telemetry;
}

export interface StartRunArgs {
  workspaceId: string;
  ambientId: string | null;
  conversationId?: string | null;
  workflowId: string;
  userId: string;
  triggerId: string | null;
  inputs: Record<string, unknown>;
  initialState: WorkflowRunState;
  graph: WorkflowGraph;
}

export interface RunHandle {
  runId: string;
  workflowId: string;
}

export class WorkflowEngine {
  /** In-flight run-state cache keyed by runId. */
  readonly #runs = new Map<string, RunningContext>();
  readonly #telemetry: Telemetry;

  constructor(private readonly deps: EngineDeps) {
    this.#telemetry = deps.telemetry ?? noopTelemetry;
  }

  // ────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────

  async startRun(args: StartRunArgs): Promise<RunHandle> {
    const ctx: RunningContext = {
      runId: args.initialState.runId,
      workflowId: args.workflowId,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      conversationId: args.conversationId ?? null,
      userId: args.userId,
      graph: args.graph,
      downstreamEdges: buildDownstreamEdges(args.graph),
      state: args.initialState,
      eventsSinceSnapshot: 0,
      inflightDispatches: 0,
      swarms: new Map(),
      selfHealAttempts: new Map(),
    };
    this.#runs.set(ctx.runId, ctx);

    await this.#transitionRunStatus(ctx, 'RUNNING');
    this.deps.activity.record({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      eventType: 'run.started',
      actorType: 'user',
      actorId: ctx.userId,
      entityType: 'workflow_run',
      entityId: ctx.runId,
      summary: `Workflow run started`,
      metadata: { workflowId: ctx.workflowId, triggerId: args.triggerId },
    });
    this.#audit(ctx, {
      action: 'run.started',
      actorType: args.triggerId ? 'scheduler' : 'user',
      actorId: ctx.userId,
      inputSummary: summarizeForAudit(args.inputs),
    });

    // Kick the dispatch loop. Don't await — runs are async.
    queueMicrotask(() => {
      void this.#tick(ctx).catch((err) => {
        this.deps.logger.error('engine.tick.unhandled', {
          runId: ctx.runId,
          err: (err as Error).message,
        });
      });
    });

    return { runId: ctx.runId, workflowId: ctx.workflowId };
  }

  /**
   * Recover runs interrupted by a process restart.
   *
   * Called once at boot. The in-memory `#runs` map is empty after a restart,
   * so any run left in `RUNNING` would hang forever. We split them:
   *
   *   - RESUMABLE: a run whose ONLY in-flight work is `wait` timers. The wait
   *     node's sole effect is the delay, and we persisted `wakeAt` + inputs,
   *     so we can rebuild the context, re-arm the timer for the remaining
   *     delay (firing immediately if it already elapsed), and re-enter the
   *     dispatch loop. This makes "wait an hour, then send" survive restarts.
   *
   *   - NON-RECOVERABLE: a run with an in-flight agent / skill / http /
   *     integration / subflow / evaluator execution. We can't know whether
   *     that external work completed, so re-dispatching risks double
   *     side-effects. These are failed loud with a clear reason.
   *
   * Returns a summary so bootstrap can log it.
   */
  async recoverInterruptedRuns(): Promise<{ resumed: number; failed: number }> {
    const running = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.status, 'RUNNING'))
      .all();
    let resumed = 0;
    let failed = 0;
    for (const run of running) {
      const state = run.runState as unknown as WorkflowRunState | null;
      const activeExecs = state?.activeExecutions ? Object.values(state.activeExecutions) : [];
      const allWaits = activeExecs.length > 0 && activeExecs.every((e) => e.executorType === 'wait');
      if (!allWaits || !run.workflowId || !state) {
        // Non-recoverable — fail loud.
        this.deps.db
          .update(schema.workflowRuns)
          .set({ status: 'FAILED', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
          .where(eq(schema.workflowRuns.id, run.id))
          .run();
        failed += 1;
        continue;
      }
      try {
        const graph = this.#loadWorkflowGraph(run.workflowId);
        const ctx: RunningContext = {
          runId: run.id,
          workflowId: run.workflowId,
          workspaceId: run.workspaceId,
          ambientId: run.ambientId,
          conversationId: run.conversationId ?? null,
          userId: run.userId,
          graph,
          downstreamEdges: buildDownstreamEdges(graph),
          state,
          eventsSinceSnapshot: 0,
          inflightDispatches: 0,
          swarms: new Map(),
          selfHealAttempts: new Map(),
        };
        this.#runs.set(ctx.runId, ctx);
        // Re-arm each wait timer for its remaining delay.
        for (const exec of activeExecs) {
          const wakeAt = (exec as unknown as { wakeAt?: string }).wakeAt;
          const inputData = ((exec as unknown as { inputData?: Record<string, unknown> }).inputData) ?? {};
          const remaining = wakeAt ? Math.max(0, new Date(wakeAt).getTime() - Date.now()) : 0;
          const fire = () => {
            delete ctx.state.activeExecutions[exec.nodeId];
            void (async () => {
              await this.#completeNode(ctx, exec.nodeId, inputData);
              void this.#tick(ctx);
            })();
          };
          if (remaining <= 0) {
            queueMicrotask(fire);
          } else {
            const timer = setTimeout(fire, remaining);
            timer.unref?.();
          }
        }
        this.deps.logger.info('engine.run_resumed', { runId: run.id, waits: activeExecs.length });
        resumed += 1;
      } catch (err) {
        this.deps.logger.warn('engine.run_resume_failed', { runId: run.id, err: (err as Error).message });
        this.deps.db
          .update(schema.workflowRuns)
          .set({ status: 'FAILED', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
          .where(eq(schema.workflowRuns.id, run.id))
          .run();
        failed += 1;
      }
    }
    return { resumed, failed };
  }

  /**
   * Dry-run a single node in isolation.
   *
   * Builds an ephemeral RunningContext that does NOT persist to the database
   * or fire ledger events, dispatches the node's handler against the provided
   * inputs, and returns either the output or a structured error. The node's
   * own side-effects (HTTP calls, integration writes, agent dispatches) still
   * happen — this is "run this one node now" with real credentials, not a mock.
   *
   * Used by the canvas Test tab.
   */
  async testNode(args: {
    workspaceId: string;
    ambientId: string | null;
    userId: string;
    workflowId: string;
    nodeId: string;
    inputs: Record<string, unknown>;
  }): Promise<{ ok: true; output: Record<string, unknown>; durationMs: number }
              | { ok: false; error: string; code?: string; durationMs: number }> {
    const startedAt = Date.now();
    const wf = this.deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, args.workflowId))
      .get();
    if (!wf || wf.workspaceId !== args.workspaceId) {
      return { ok: false, error: `workflow ${args.workflowId} not found`, code: 'RESOURCE_NOT_FOUND', durationMs: Date.now() - startedAt };
    }
    const graph = wf.graph as unknown as WorkflowGraph;
    const node = graph.nodes.find((n) => n.id === args.nodeId);
    if (!node) {
      return { ok: false, error: `node ${args.nodeId} not found in workflow`, code: 'RESOURCE_NOT_FOUND', durationMs: Date.now() - startedAt };
    }
    // Async node kinds (agent_task, subflow, agent_swarm, checkpoint) cannot
    // be dry-run synchronously through #dispatchNode without setting up the
    // full callback machinery. Reject them explicitly so the UI can surface
    // a friendly message instead of hanging.
    const asyncKinds: ReadonlyArray<string> = ['agent_task', 'agent_swarm', 'subflow', 'checkpoint', 'loop'];
    if (asyncKinds.includes(node.config.kind)) {
      return {
        ok: false,
        error: `'${node.config.kind}' is async — test it via a real run`,
        code: 'VALIDATION_FAILED',
        durationMs: Date.now() - startedAt,
      };
    }

    // Build a throwaway context. We use a fake runId so any ledger/bus calls
    // (none should fire in test mode) are clearly tagged.
    const testRunId = `test-${randomUUID()}`;
    const initialState: WorkflowRunState = {
      runId: testRunId,
      workflowId: args.workflowId,
      status: 'RUNNING',
      readyQueue: [],
      waitingInputs: {},
      nodeStates: {
        [args.nodeId]: {
          nodeId: args.nodeId,
          status: 'PENDING',
          inputData: args.inputs,
        },
      },
      activeExecutions: {},
      completedNodeIds: [],
      failedNodeIds: [],
      skippedNodeIds: [],
      graphRevision: 0,
      replanCount: 0,
      lastLedgerSequence: 0,
    };
    const ctx: RunningContext = {
      runId: testRunId,
      workflowId: args.workflowId,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      conversationId: null,
      userId: args.userId,
      graph,
      downstreamEdges: buildDownstreamEdges(graph),
      state: initialState,
      eventsSinceSnapshot: 0,
      inflightDispatches: 0,
      swarms: new Map(),
      selfHealAttempts: new Map(),
    };

    // Build the template context and resolve config templates the same way
    // the real dispatch path does.
    const item: ReadyQueueItem = {
      nodeId: args.nodeId,
      priority: 0,
      insertedAt: new Date().toISOString(),
      inputData: args.inputs,
    };
    const tctx = this.#buildTemplateContext(ctx, item);
    const resolvedConfig = resolveTemplateDeep(node.config, tctx);

    try {
      let output: Record<string, unknown> = {};
      switch (node.config.kind) {
        case 'trigger':
        case 'merge':
        case 'parallel':
          output = args.inputs;
          break;
        case 'scratchpad':
          output = await this.#executeScratchpadNode(ctx, resolvedConfig as ScratchpadNodeConfig, args.inputs);
          break;
        case 'router': {
          const cfg = resolvedConfig as RouterNodeConfig;
          const branchOutputs = cfg.routingMode === 'llm_route'
            ? await this.#executeRouterLlm(ctx, node, cfg, args.inputs)
            : this.#executeRouter(ctx, cfg, args.inputs);
          output = { branches: branchOutputs };
          break;
        }
        case 'skill_task':
          output = await this.#executeSkillTask(ctx, node, resolvedConfig as SkillTaskNodeConfig, args.inputs);
          break;
        case 'knowledge':
          output = await this.#executeKnowledgeNode(ctx, resolvedConfig as KnowledgeNodeConfig, args.inputs);
          break;
        case 'artifact_collect':
          output = await this.#executeArtifactCollect(ctx, node, resolvedConfig as ArtifactCollectNodeConfig, args.inputs);
          break;
        case 'wait':
          // No-op for tests — return inputs immediately.
          output = args.inputs;
          break;
        case 'transform':
          output = this.#executeTransform(node.config as TransformNodeConfig, args.inputs, tctx);
          break;
        case 'filter':
          output = this.#executeFilter(node.config as FilterNodeConfig, args.inputs, tctx);
          break;
        case 'return_output':
          output = this.#executeReturnOutput(node.config as ReturnOutputNodeConfig, args.inputs, tctx);
          break;
        case 'artifact_save':
          output = await this.#executeArtifactSave(ctx, node, resolvedConfig as ArtifactSaveNodeConfig, args.inputs);
          break;
        case 'browser':
          output = await this.#executeBrowser(ctx, node, resolvedConfig as BrowserNodeConfig, args.inputs);
          break;
        case 'integration':
          output = await this.#executeIntegration(ctx, node, resolvedConfig as IntegrationNodeConfig, args.inputs);
          break;
        case 'http_request':
          output = await this.#executeHttpRequest(ctx, node, resolvedConfig as HttpRequestNodeConfig);
          break;
        case 'workflow_store':
          output = await this.#executeWorkflowStore(ctx, node.config as WorkflowStoreNodeConfig, tctx);
          break;
        case 'workspace_store':
          output = await this.#executeWorkspaceStore(ctx, node.config as WorkspaceStoreNodeConfig, tctx);
          break;
        case 'evaluator':
          output = await this.#executeEvaluator(ctx, node, node.config as EvaluatorNodeConfig, args.inputs, tctx);
          break;
        case 'guardrails': {
          const result = this.#executeGuardrails(node.config as GuardrailsNodeConfig, args.inputs);
          if (result.shouldFail) {
            return { ok: false, error: result.message, code: 'VALIDATION_FAILED', durationMs: Date.now() - startedAt };
          }
          output = result.output;
          break;
        }
        default:
          return { ok: false, error: `node kind '${node.config.kind}' is not testable in isolation`, code: 'VALIDATION_FAILED', durationMs: Date.now() - startedAt };
      }
      return { ok: true, output, durationMs: Date.now() - startedAt };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return {
        ok: false,
        error: e.message ?? String(err),
        code: e.code,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const ctx = this.#runs.get(runId);
    if (!ctx) {
      await this.#cancelPersistedRun(runId);
      return;
    }
    await this.#transitionRunStatus(ctx, 'CANCELLED');
    this.#runs.delete(runId);
  }

  /**
   * Start every pending run buffered in `workflow_run_queue` for a workflow.
   * Drains the concurrency-overflow queue; called by SchedulerService.tick().
   */
  async drainWorkflowQueue(workflowId: string): Promise<number> {
    const pending = this.deps.db
      .select()
      .from(schema.workflowRunQueue)
      .where(and(
        eq(schema.workflowRunQueue.workflowId, workflowId),
        eq(schema.workflowRunQueue.status, 'pending'),
      ))
      .all();
    let started = 0;
    for (const item of pending) {
      const initialState = item.initialState as unknown as WorkflowRunState | null;
      const graph = item.graphSnapshot as unknown as WorkflowGraph | null;
      this.deps.db
        .update(schema.workflowRunQueue)
        .set({
          status: initialState && graph ? 'dequeued' : 'dropped',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.workflowRunQueue.id, item.id))
        .run();
      if (!initialState || !graph) continue;
      await this.startRun({
        workspaceId: item.workspaceId,
        ambientId: item.ambientId,
        conversationId: null,
        workflowId,
        userId: item.userId,
        triggerId: item.triggerId,
        inputs: (item.inputs as Record<string, unknown>) ?? {},
        initialState,
        graph,
      });
      started += 1;
    }
    return started;
  }

  /**
   * Async completion callback for agent-dispatched tasks.
   * Adapters emit task.completed via NormalizedAgentEvent; the adapter
   * manager forwards into here.
   */
  async notifyTaskCompleted(args: {
    runId: string;
    nodeId: string;
    output: Record<string, unknown>;
  }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    const swarm = parseSwarmTaskId(args.nodeId);
    if (swarm) {
      await this.#onSwarmSubtask(ctx, swarm.nodeId, swarm.index, args.output, null);
      return;
    }
    await this.#completeNode(ctx, args.nodeId, args.output);
    void this.#tick(ctx);
  }

  async notifyTaskFailed(args: { runId: string; nodeId: string; error: string }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    const swarm = parseSwarmTaskId(args.nodeId);
    if (swarm) {
      await this.#onSwarmSubtask(ctx, swarm.nodeId, swarm.index, null, args.error);
      return;
    }
    const node = ctx.graph.nodes.find((candidate) => candidate.id === args.nodeId) ?? null;
    // Self-healing agent task (AGENTIS-PLATFORM-10X §A9): re-dispatch with the
    // error context appended so the agent can correct itself.
    if (node?.config.kind === 'agent_task' && node.config.retryPolicy?.selfHeal) {
      const max = node.config.retryPolicy.maxSelfHealAttempts ?? 2;
      const attempts = ctx.selfHealAttempts.get(node.id) ?? 0;
      if (attempts < max) {
        ctx.selfHealAttempts.set(node.id, attempts + 1);
        this.deps.logger.info('engine.self_heal.retry', {
          runId: ctx.runId,
          nodeId: node.id,
          attempt: attempts + 1,
          max,
        });
        this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, {
          runId: ctx.runId,
          nodeId: node.id,
          attempt: attempts + 1,
          reason: 'self_heal',
        });
        const inputData = ctx.state.nodeStates[node.id]?.inputData ?? {};
        const healConfig: AgentTaskNodeConfig = {
          ...node.config,
          prompt:
            `${node.config.prompt}\n\n---\nPREVIOUS ATTEMPT FAILED (attempt ${attempts + 1}/${max}).\n` +
            `Error: ${args.error}\nAnalyse the error and correct your output.`,
        };
        await this.#dispatchAgentTask(ctx, node, healConfig, inputData);
        return;
      }
    }
    await this.#failNode(ctx, args.nodeId, args.error);
    void this.#tick(ctx);
  }

  /**
   * Apply a dynamic graph patch to a live run (V1-SPEC §6.6).
   *
   * Used by the planner/replan flow, in-canvas user edits, and hub package
   * updates that need to splice nodes into a running workflow. Validates
   * cycles + node references on the merged graph, increments the run's
   * `graphRevision`, persists the merged graph back to the workflow row,
   * mutates the live `RunningContext.graph` so subsequent ticks see the
   * change, and emits `workflow.graph_patched` on the run room.
   */
  async applyGraphPatch(args: {
    runId: string;
    patch: WorkflowGraphPatch;
  }): Promise<{ newRevision: number }> {
    const { runId, patch } = args;
    const ctx = this.#runs.get(runId);
    const run = await this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
    if (!run) {
      throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', `Run ${runId} not found`);
    }
    const currentState = run.runState as unknown as WorkflowRunState;
    const currentRevision = ctx?.state.graphRevision ?? currentState.graphRevision;
    if (patch.baseGraphRevision !== currentRevision) {
      throw new AgentisError(
        'GRAPH_REVISION_CONFLICT',
        `Patch baseGraphRevision ${patch.baseGraphRevision} does not match current ${currentRevision}`,
        { details: { current: currentRevision, base: patch.baseGraphRevision } },
      );
    }

    const baseGraph = ctx?.graph ?? (run.workflowId ? this.#loadWorkflowGraph(run.workflowId) : run.graphSnapshot as WorkflowGraph | null);
    if (!baseGraph) {
      throw new AgentisError('WORKFLOW_RUN_INVALID_STATE', 'Run has no saved workflow or graph snapshot to patch');
    }
    let merged: WorkflowGraph;
    try {
      merged = mergeGraphPatch(baseGraph, patch);
    } catch (err) {
      throw new AgentisError('GRAPH_PATCH_INVALID', (err as Error).message);
    }
    try {
      validateWorkflowGraph(merged, { currentWorkflowId: run.workflowId });
    } catch (err) {
      // Re-throw as GRAPH_PATCH_INVALID so callers can distinguish cycles
      // discovered at patch-apply time from at-rest WORKFLOW_GRAPH_INVALID.
      const msg = err instanceof AgentisError ? err.message : (err as Error).message;
      throw new AgentisError('GRAPH_PATCH_INVALID', msg);
    }

    const newRevision = currentRevision + 1;

    if (run.workflowId) {
      await this.deps.db
        .update(schema.workflows)
        .set({ graph: merged as unknown as object, updatedAt: new Date().toISOString() })
        .where(eq(schema.workflows.id, run.workflowId));
    } else {
      await this.deps.db
        .update(schema.workflowRuns)
        .set({ graphSnapshot: merged as unknown as object, updatedAt: new Date().toISOString() })
        .where(eq(schema.workflowRuns.id, run.id));
    }

    if (ctx) {
      ctx.graph = merged;
      ctx.downstreamEdges = buildDownstreamEdges(merged);
      ctx.state.graphRevision = newRevision;
      await this.#persistRun(ctx);
    } else {
      const nextState: WorkflowRunState = { ...currentState, graphRevision: newRevision };
      await this.deps.db
        .update(schema.workflowRuns)
        .set({
          runState: nextState as unknown as object,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.workflowRuns.id, runId));
    }

    this.deps.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.WORKFLOW_GRAPH_PATCHED, {
      runId,
      patchId: patch.patchId,
      reason: patch.reason,
      newRevision,
    });

    this.deps.activity.record({
      workspaceId: run.workspaceId,
      ambientId: run.ambientId,
      userId: run.userId,
      eventType: 'workflow.graph_patched',
      actorType: 'system',
      actorId: 'engine',
      entityType: 'workflow_run',
      entityId: runId,
      summary: `Graph patched (${patch.reason}) → revision ${newRevision}`,
      metadata: {
        patchId: patch.patchId,
        addNodes: patch.addNodes.length,
        updateNodes: patch.updateNodes.length,
        removeNodes: patch.removeNodeIds.length,
      },
    });

    return { newRevision };
  }

  #loadWorkflowGraph(workflowId: string): WorkflowGraph {
    const wf = this.deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, workflowId))
      .get();
    if (!wf) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `Workflow ${workflowId} not found`);
    }
    return wf.graph as unknown as WorkflowGraph;
  }

  // ────────────────────────────────────────────────────────────
  // Dispatch loop
  // ────────────────────────────────────────────────────────────

  async #tick(ctx: RunningContext): Promise<void> {
    if (ctx.state.status !== 'RUNNING' && ctx.state.status !== 'WAITING') return;

    return await this.#telemetry.span(
      'engine.tick',
      async () => this.#tickBody(ctx),
      { 'agentis.run_id': ctx.runId, 'agentis.workflow_id': ctx.workflowId },
    );
  }

  async #tickBody(ctx: RunningContext): Promise<void> {
    const parallelism = resolveParallelism();
    while (
      ctx.state.readyQueue.length > 0 &&
      Object.keys(ctx.state.activeExecutions).length < parallelism
    ) {
      const item = ctx.state.readyQueue.shift()!;
      const node = ctx.graph.nodes.find((n) => n.id === item.nodeId);
      if (!node) {
        this.deps.logger.warn('engine.tick.unknown_node', { runId: ctx.runId, nodeId: item.nodeId });
        continue;
      }
      ctx.inflightDispatches += 1;
      void this.#dispatchNode(ctx, node, item)
        .then(() => {
          ctx.inflightDispatches -= 1;
          void this.#tick(ctx);
        })
        .catch((err) => {
          ctx.inflightDispatches -= 1;
          void this.#failNode(ctx, node.id, (err as Error).message);
          void this.#tick(ctx);
        });
    }

    // Settle: if no active executions, no in-flight dispatch chains, no
    // waiting inputs left to receive, and ready queue is empty, the run is
    // done. The inflightDispatches counter prevents settling mid-dispatch
    // for passthrough nodes (trigger/merge/router/scratchpad/skill_task)
    // which never register in activeExecutions.
    if (
      ctx.state.readyQueue.length === 0 &&
      Object.keys(ctx.state.activeExecutions).length === 0 &&
      ctx.inflightDispatches === 0
    ) {
      if (ctx.budgetHalt) {
        this.#skipBlockedNodes(ctx, 'Skipped: phase budget exceeded');
        await this.#transitionRunStatus(ctx, 'FAILED');
        this.#runs.delete(ctx.runId);
      } else if (ctx.state.failedNodeIds.length > 0) {
        this.#skipBlockedNodes(ctx, 'Skipped because an upstream node failed');
        await this.#transitionRunStatus(ctx, 'FAILED');
        this.#runs.delete(ctx.runId);
      } else {
        const stillWaiting = Object.values(ctx.state.waitingInputs).some(
          (b) => b.requiredInputs.length > 0,
        );
        if (!stillWaiting) {
          await this.#transitionRunStatus(ctx, 'COMPLETED');
          this.#runs.delete(ctx.runId);
        } else {
          await this.#transitionRunStatus(ctx, 'WAITING');
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Per-node dispatch
  // ────────────────────────────────────────────────────────────

  async #dispatchNode(
    ctx: RunningContext,
    node: WorkflowNode,
    item: ReadyQueueItem,
  ): Promise<void> {
    // Layer 5 human gate: hold the node before it starts if its phase requires
    // approval and the gate hasn't been granted yet. The downstream nodes stay in
    // waitingInputs, so the run settles to WAITING (not COMPLETED) until approved.
    if (await this.#maybeHoldForPhaseGate(ctx, node, item)) return;

    await this.#startNode(ctx, node, item.inputData);

    // Build template context once per dispatch and resolve every templated
    // field in the node's config before any handler sees it. Handlers that
    // need the raw value (transform/filter expressions, evaluator targetPath,
    // workflow_store keys/values) re-read from the original config and call
    // `readTemplatePath()` directly to avoid double-encoding.
    const tctx = this.#buildTemplateContext(ctx, item);
    const resolvedConfig = resolveTemplateDeep(node.config, tctx);

    switch (node.config.kind) {
      case 'trigger': {
        // Triggers are pure pass-throughs at run time — they were the seed.
        await this.#completeNode(ctx, node.id, item.inputData);
        return;
      }
      case 'scratchpad': {
        const result = await this.#executeScratchpadNode(ctx, resolvedConfig as ScratchpadNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'merge': {
        // Merge node passes through the union of received inputs.
        await this.#completeNode(ctx, node.id, item.inputData);
        return;
      }
      case 'router': {
        const cfg = resolvedConfig as RouterNodeConfig;
        if (cfg.routingMode === 'llm_route') {
          const branchOutputs = await this.#executeRouterLlm(ctx, node, cfg, item.inputData);
          await this.#completeNode(ctx, node.id, { branches: branchOutputs });
        } else {
          const branchOutputs = this.#executeRouter(ctx, cfg, item.inputData);
          await this.#completeNode(ctx, node.id, { branches: branchOutputs });
        }
        return;
      }
      case 'checkpoint': {
        await this.#executeCheckpoint(ctx, node, resolvedConfig as CheckpointNodeConfig, item.inputData);
        return;
      }
      case 'skill_task': {
        const result = await this.#executeSkillTask(ctx, node, resolvedConfig as SkillTaskNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'knowledge': {
        const result = await this.#executeKnowledgeNode(ctx, resolvedConfig as KnowledgeNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'agent_task': {
        const agentCfg = resolvedConfig as AgentTaskNodeConfig;
        // §2.2 agentic tool-use loop: when opted in, run in-process against the
        // role-scoped tool runtime and complete synchronously. Otherwise fall
        // through to the external-adapter dispatch (async completion).
        if (await this.#maybeRunAgentToolLoop(ctx, node, agentCfg, item.inputData)) return;
        await this.#dispatchAgentTask(ctx, node, agentCfg, item.inputData);
        return; // adapter event will call notifyTaskCompleted
      }
      case 'agent_swarm': {
        await this.#dispatchAgentSwarm(ctx, node, resolvedConfig as AgentSwarmNodeConfig, item.inputData);
        return; // swarm subtask events resolve the node
      }
      case 'artifact_collect': {
        const result = await this.#executeArtifactCollect(ctx, node, resolvedConfig as ArtifactCollectNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'wait': {
        await this.#executeWait(ctx, node, resolvedConfig as WaitNodeConfig, item.inputData);
        return;
      }
      case 'transform': {
        const result = this.#executeTransform(node.config as TransformNodeConfig, item.inputData, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'filter': {
        const result = this.#executeFilter(node.config as FilterNodeConfig, item.inputData, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'return_output': {
        const result = this.#executeReturnOutput(node.config as ReturnOutputNodeConfig, item.inputData, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'artifact_save': {
        const result = await this.#executeArtifactSave(ctx, node, resolvedConfig as ArtifactSaveNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'browser': {
        const result = await this.#executeBrowser(ctx, node, resolvedConfig as BrowserNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'integration': {
        const result = await this.#executeIntegration(ctx, node, resolvedConfig as IntegrationNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'http_request': {
        const result = await this.#executeHttpRequest(ctx, node, resolvedConfig as HttpRequestNodeConfig);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'workflow_store': {
        const result = await this.#executeWorkflowStore(ctx, node.config as WorkflowStoreNodeConfig, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'workspace_store': {
        const result = await this.#executeWorkspaceStore(ctx, node.config as WorkspaceStoreNodeConfig, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'evaluator': {
        const result = await this.#executeEvaluator(ctx, node, node.config as EvaluatorNodeConfig, item.inputData, tctx);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'guardrails': {
        const result = this.#executeGuardrails(node.config as GuardrailsNodeConfig, item.inputData);
        if (result.shouldFail) {
          throw new AgentisError('VALIDATION_FAILED', result.message);
        }
        await this.#completeNode(ctx, node.id, result.output);
        return;
      }
      case 'loop': {
        await this.#dispatchLoop(ctx, node, resolvedConfig as LoopNodeConfig, item.inputData, tctx);
        return;
      }
      case 'parallel': {
        // Parallel is a pure passthrough at dispatch time — fan-out happens via
        // the regular edge mechanism. `waitFor` / `onBranchError` / `mergeStrategy`
        // are honored at the downstream `merge` node.
        await this.#completeNode(ctx, node.id, item.inputData);
        return;
      }
      case 'subflow': {
        const cfg = node.config as { kind: 'subflow'; workflowId: string; inputMapping?: Record<string, string> };
        if (!this.deps.subflows) {
          // Without a subflow executor wired (legacy embed), surface a clean failure.
          throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'subflow node present but SubflowExecutor not wired');
        }
        const childInputs = cfg.inputMapping ? mapInputs(cfg.inputMapping, item.inputData, this.deps.scratchpad.snapshotOf(ctx.runId)) : item.inputData;
        // Track the parent node as a synthetic active execution so the engine
        // doesn't settle this branch as completed before the child returns.
        ctx.state.activeExecutions[node.id] = {
          taskId: `subflow:${node.id}`,
          nodeId: node.id,
          executorType: 'subflow',
          executorRef: cfg.workflowId,
          startedAt: new Date().toISOString(),
        };
        await this.deps.subflows.start({
          parentRunId: ctx.runId,
          parentNodeId: node.id,
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
          userId: ctx.userId,
          childWorkflowId: cfg.workflowId,
          inputs: childInputs,
          resumeParent: async (output) => {
            await this.#completeNode(ctx, node.id, output);
            void this.#tick(ctx);
          },
          failParent: async (msg) => {
            await this.#failNode(ctx, node.id, msg);
            void this.#tick(ctx);
          },
          startChildRun: async (childArgs) => {
            const handle = await this.startRun(childArgs);
            return { runId: handle.runId };
          },
        });
        return;
      }
    }
  }

  async #executeSkillTask(
    ctx: RunningContext,
    node: WorkflowNode,
    config: SkillTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const skillInput = mapInputs(config.inputMapping, inputData, ctx.scratchpad?.snapshot ?? {});
    const result = await this.deps.skills.execute({
      workspaceId: ctx.workspaceId,
      skillId: config.skillId,
      runId: ctx.runId,
      taskId: node.id,
      input: skillInput,
      scratchpadSnapshot: ctx.scratchpad?.snapshot ?? {},
    });

    if (!result.ok) {
      throw new AgentisError(
        result.errorCode === 'SKILL_TIMEOUT' ? 'SKILL_TIMEOUT' : 'INTERNAL_ERROR',
        `Skill ${config.skillId} failed: ${result.message}`,
      );
    }

    // Apply output mapping to scratchpad.
    if (config.outputMapping) {
      for (const [outKey, padKey] of Object.entries(config.outputMapping)) {
        if (outKey in result.output) {
          this.deps.scratchpad.write(ctx.runId, padKey, result.output[outKey]);
        }
      }
    }

    return result.output;
  }

  async #executeKnowledgeNode(
    ctx: RunningContext,
    config: KnowledgeNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.knowledgeBases) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'knowledge node present but KnowledgeBaseService not wired');
    }

    const query = resolveKnowledgeQuery(config, inputData, ctx.state.nodeStates).trim();
    if (!query) throw new AgentisError('VALIDATION_FAILED', 'knowledge node query is empty');

    const topK = Math.min(Math.max(config.topK ?? 5, 1), 20);
    const bases = config.knowledgeBaseId
      ? [this.deps.knowledgeBases.getKnowledgeBase(ctx.workspaceId, config.knowledgeBaseId)]
      : this.deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId);
    const perBaseTopK = config.knowledgeBaseId ? topK : Math.max(topK, 5);

    const results = bases
      .flatMap((base) => this.deps.knowledgeBases!.search({
        workspaceId: ctx.workspaceId,
        knowledgeBaseId: base.id,
        query,
        topK: perBaseTopK,
      }).map((hit) => ({
        ...hit,
        knowledgeBaseId: base.id,
        knowledgeBaseName: base.name,
      })))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);

    return {
      query,
      topK,
      retrievalMode: config.retrievalMode ?? 'contextual',
      knowledgeBaseId: config.knowledgeBaseId ?? null,
      resultCount: results.length,
      results,
      context: results.map((result, index) => ({
        index: index + 1,
        title: result.knowledgeBaseName,
        content: result.content,
        score: result.score,
        source: result.metadata,
      })),
    };
  }

  /**
   * §2.2 agentic tool-use loop. When `agent_task.useRoleTools` is set and the
   * runtime + an LLM are available, run the role's bounded ReAct loop in-process
   * (against the role-scoped, manifest-enforced tool runtime) and complete the
   * node synchronously. Returns false when the loop isn't applicable, so the
   * caller falls back to the external-adapter dispatch.
   */
  async #maybeRunAgentToolLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<boolean> {
    if (!config.useRoleTools || !config.agentRole || !isAgentRole(config.agentRole)) return false;
    if (!this.deps.agentTools || !this.deps.evaluatorRuntime) return false;

    let skillBlock = '';
    if (config.skills?.length && this.deps.skillLibrary) {
      try {
        skillBlock = await this.deps.skillLibrary.buildSkillBlock(ctx.workspaceId, config.skills);
      } catch (err) {
        this.deps.logger.warn('engine.skill_inject.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }
    // Resolve the concrete agent so its personal memory (§G11) is scoped
    // correctly for both context injection and the agent-memory tools.
    const agentId = config.agentId
      ?? this.deps.specialists?.ensureRole(ctx.workspaceId, ctx.userId, config.agentRole)
      ?? undefined;

    const rolePrompt = specialistForRole(config.agentRole).systemPrompt;
    const preamble = await this.#withWorkspaceContext(ctx, '', rolePrompt, skillBlock, agentId);
    const inputBlock = Object.keys(inputData).length > 0 ? `\n\nINPUT:\n${safeJson(inputData)}` : '';

    const loop = new AgentToolLoop({
      runtime: this.deps.agentTools,
      llm: this.deps.evaluatorRuntime,
      logger: this.deps.logger,
    });
    const result = await loop.run({
      workspaceId: ctx.workspaceId,
      role: config.agentRole,
      task: `${config.prompt}${inputBlock}`,
      systemPreamble: preamble,
      maxSteps: config.maxToolSteps,
      workflowId: ctx.workflowId,
      agentId,
    });

    this.#audit(ctx, {
      nodeId: node.id,
      action: 'agent.tool_loop',
      actorType: 'agent',
      actorId: config.agentRole,
      outputSummary: `${result.stoppedReason}: ${result.toolCalls} tool call(s)`,
    });
    await this.#completeNode(ctx, node.id, {
      output: result.output,
      toolCalls: result.toolCalls,
      steps: result.steps.length,
      stoppedReason: result.stoppedReason,
    });
    return true;
  }

  async #dispatchAgentTask(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    // Layer 2: resolve a specialist `agentRole` to a concrete workspace agent
    // when no explicit agentId is bound. `agentId` always wins.
    let agentId = config.agentId;
    let rolePrompt: string | undefined;
    if (config.agentRole) {
      rolePrompt = specialistForRole(config.agentRole).systemPrompt;
      if (!agentId && this.deps.specialists) {
        agentId = this.deps.specialists.ensureRole(ctx.workspaceId, ctx.userId, config.agentRole) ?? undefined;
      }
    }
    if (!agentId) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        config.agentRole
          ? `agent_task node ${node.id}: role '${config.agentRole}' could not be resolved (specialist library not wired)`
          : `agent_task node ${node.id} has no agentId or agentRole bound`,
      );
    }
    const taskId = randomUUID();
    ctx.state.activeExecutions[node.id] = {
      taskId,
      nodeId: node.id,
      executorType: 'agent',
      executorRef: agentId,
      startedAt: new Date().toISOString(),
    };

    // Resolve behavioral skills (§2.5) into an injected block.
    let skillBlock = '';
    if (config.skills?.length && this.deps.skillLibrary) {
      try {
        skillBlock = await this.deps.skillLibrary.buildSkillBlock(ctx.workspaceId, config.skills);
      } catch (err) {
        this.deps.logger.warn('engine.skill_inject.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }

    // Compose the system preamble: role identity (Layer 2) → workspace context
    // (Layer 1) → agent memory (§G11) → behavioral skills (§2.5) → the task
    // prompt. No agent call starts from zero (Principle #2).
    const prompt = await this.#withWorkspaceContext(ctx, config.prompt, rolePrompt, skillBlock, agentId);

    await this.deps.adapters.dispatchTask({
      taskId,
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      nodeId: node.id,
      title: node.title,
      description: prompt,
      inputData,
      scratchpadSnapshot: this.deps.scratchpad.snapshotOf(ctx.runId),
      capabilityTags: config.capabilityTags,
      timeoutMs: CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS,
    }, agentId);
  }

  /**
   * Compose an agent prompt's system preamble: optional role identity, then the
   * workspace context block (Layer 1), the agent's personal memory (§G11), then
   * the task prompt. Best effort: a context-read failure must never block a
   * dispatch.
   */
  async #withWorkspaceContext(ctx: RunningContext, prompt: string, rolePrompt?: string, skillBlock?: string, agentId?: string): Promise<string> {
    let block = '';
    if (this.deps.workspaceIntelligence) {
      try {
        block = await this.deps.workspaceIntelligence.buildContextBlock(ctx.workspaceId, {
          workflowId: ctx.workflowId,
          // §G1 — fold the most relevant Brain passages into the preamble using
          // the task prompt as the retrieval query. No-op when no KBs match.
          knowledgeQuery: prompt || undefined,
          knowledgeBases: this.deps.knowledgeBases,
        });
      } catch (err) {
        this.#logContextFailure(ctx, err);
      }
    }
    // §G11 — the dispatched agent's personal memory, accumulated across every
    // prior task it has run. Wrapped so the agent sees it as part of its context.
    let agentMemory = '';
    if (agentId && this.deps.agentMemory) {
      const section = this.deps.agentMemory.contextSection(agentId, ctx.workspaceId);
      if (section) agentMemory = `<agent_memory>\n${section}\n</agent_memory>`;
    }
    return [rolePrompt, block, agentMemory, skillBlock, prompt].filter(Boolean).join('\n\n');
  }

  #logContextFailure(ctx: RunningContext, err: unknown): void {
    this.deps.logger.warn('engine.workspace_context.failed', {
      runId: ctx.runId,
      workspaceId: ctx.workspaceId,
      err: (err as Error).message,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Artifact collect node
  // ────────────────────────────────────────────────────────────

  async #executeArtifactCollect(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ArtifactCollectNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Extract artifact references from upstream input.
    const raw = config.artifactPath ? lookupPath(inputData, config.artifactPath) : inputData;
    const refs: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

    // Filter by accepted types when specified.
    const accepted = config.acceptTypes;
    const filtered = accepted
      ? refs.filter((r) => {
          const t = r && typeof r === 'object' ? (r as Record<string, unknown>).type : null;
          return typeof t === 'string' && accepted.includes(t as 'html' | 'image' | 'document' | 'code' | 'data');
        })
      : refs;

    // Persist each artifact to the workspace artifact store.
    const collectedIds: string[] = [];
    const now = new Date().toISOString();
    for (const ref of filtered) {
      const rec = ref && typeof ref === 'object' ? (ref as Record<string, unknown>) : {};
      const type = typeof rec.type === 'string' ? rec.type : 'document';
      const title = typeof rec.title === 'string' ? rec.title : config.collectionName;
      const content = typeof rec.content === 'string' ? rec.content : typeof rec.url === 'string' ? rec.url : '';
      const id = randomUUID();
      try {
        this.deps.db
          .insert(schema.artifacts)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            type: type as 'html' | 'image' | 'document' | 'code' | 'data',
            title: `${config.collectionName}: ${title}`.slice(0, 200),
            content,
            thumbnailUrl: typeof rec.thumbnailUrl === 'string' ? rec.thumbnailUrl : null,
            runId: ctx.runId,
            workflowId: ctx.state.workflowId,
            agentId: null,
            conversationId: null,
            nodeId: node.id,
            metadata: {
              collectionName: config.collectionName,
              versioned: config.versioned !== false,
              requireApproval: config.requireApproval ?? false,
              ...(rec.metadata && typeof rec.metadata === 'object' ? rec.metadata : {}),
            },
            createdAt: now,
            updatedAt: now,
          })
          .run();
        collectedIds.push(id);
      } catch (err) {
        this.deps.logger.warn('artifact_collect.insert_failed', {
          runId: ctx.runId, nodeId: node.id,
          message: (err as Error).message,
        });
      }
    }

    this.deps.logger.info('artifact_collect.done', {
      runId: ctx.runId,
      nodeId: node.id,
      collectionName: config.collectionName,
      collected: collectedIds.length,
      total: refs.length,
    });

    return {
      collectionName: config.collectionName,
      artifactIds: collectedIds,
      count: collectedIds.length,
      requireApproval: config.requireApproval ?? false,
    };
  }

  // ────────────────────────────────────────────────────────────
  // Agent swarm node (AGENTIS-PLATFORM-10X §A8)
  // ────────────────────────────────────────────────────────────

  async #dispatchAgentSwarm(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentSwarmNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    const arrRaw = lookupPath(inputData, config.inputArrayPath);
    const items = Array.isArray(arrRaw) ? arrRaw : [];
    if (items.length === 0) {
      await this.#completeNode(ctx, node.id, { [config.outputKey]: [], count: 0 });
      return;
    }
    const agentId = config.agentId ?? this.#resolveSwarmAgent(config.capabilityTags);
    if (!agentId) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `agent_swarm node ${node.id}: no agent bound and none match capability tags`,
      );
    }
    const maxParallel = Math.min(Math.max(config.maxParallel || 1, 1), 64);
    const swarm: SwarmState = {
      nodeId: node.id,
      total: items.length,
      next: 0,
      items,
      agentId,
      config,
      results: new Map(),
      failures: new Map(),
      settled: false,
    };
    ctx.swarms.set(node.id, swarm);
    // Hold the node open with a synthetic active execution.
    ctx.state.activeExecutions[node.id] = {
      taskId: `swarm:${node.id}`,
      nodeId: node.id,
      executorType: 'agent',
      executorRef: agentId,
      startedAt: new Date().toISOString(),
    };
    const initial = Math.min(maxParallel, items.length);
    for (let i = 0; i < initial; i++) {
      this.#dispatchSwarmSubtask(ctx, node, swarm, swarm.next++);
    }
  }

  #resolveSwarmAgent(capabilityTags: string[]): string | null {
    try {
      const registered = new Set(this.deps.adapters.list().map((r) => r.agentId));
      if (registered.size === 0) return null;
      if (capabilityTags.length > 0) {
        const agents = this.deps.db
          .select({ id: schema.agents.id, capabilityTags: schema.agents.capabilityTags })
          .from(schema.agents)
          .all();
        for (const a of agents) {
          if (!registered.has(a.id)) continue;
          const tags = Array.isArray(a.capabilityTags) ? (a.capabilityTags as string[]) : [];
          if (tags.some((t) => capabilityTags.includes(t))) return a.id;
        }
      }
      return [...registered][0] ?? null;
    } catch {
      return null;
    }
  }

  #dispatchSwarmSubtask(
    ctx: RunningContext,
    node: WorkflowNode,
    swarm: SwarmState,
    index: number,
  ): void {
    const item = swarm.items[index];
    const taskId = `${node.id}::swarm::${index}`;
    void this.deps.adapters
      .dispatchTask(
        {
          taskId,
          runId: ctx.runId,
          workflowId: ctx.workflowId,
          nodeId: taskId,
          title: `${node.title} [${index + 1}/${swarm.total}]`,
          description: swarm.config.prompt,
          inputData: { item, index, prompt: swarm.config.prompt },
          scratchpadSnapshot: this.deps.scratchpad.snapshotOf(ctx.runId),
          capabilityTags: swarm.config.capabilityTags,
          timeoutMs: CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS,
        },
        swarm.agentId,
      )
      .catch((err) => {
        void this.#onSwarmSubtask(ctx, node.id, index, null, (err as Error).message);
      });
  }

  async #onSwarmSubtask(
    ctx: RunningContext,
    nodeId: string,
    index: number,
    output: Record<string, unknown> | null,
    error: string | null,
  ): Promise<void> {
    const swarm = ctx.swarms.get(nodeId);
    if (!swarm || swarm.settled) return;
    if (error) swarm.failures.set(index, error);
    else swarm.results.set(index, output ?? {});

    const node = ctx.graph.nodes.find((n) => n.id === nodeId);

    // first_success: settle as soon as one subtask succeeds.
    if (swarm.config.mergeStrategy === 'first_success' && !error && node) {
      swarm.settled = true;
      ctx.swarms.delete(nodeId);
      delete ctx.state.activeExecutions[nodeId];
      await this.#completeNode(ctx, nodeId, {
        [swarm.config.outputKey]: [output ?? {}],
        count: 1,
        strategy: 'first_success',
      });
      void this.#tick(ctx);
      return;
    }

    // Dispatch the next queued item to keep the pool saturated.
    if (swarm.next < swarm.total && node) {
      this.#dispatchSwarmSubtask(ctx, node, swarm, swarm.next++);
    }

    const done = swarm.results.size + swarm.failures.size;
    if (done < swarm.total || !node) return;

    swarm.settled = true;
    ctx.swarms.delete(nodeId);
    delete ctx.state.activeExecutions[nodeId];

    if (swarm.results.size === 0) {
      await this.#failNode(
        ctx,
        nodeId,
        `agent_swarm: all ${swarm.total} subtasks failed`,
      );
      void this.#tick(ctx);
      return;
    }
    const merged = this.#mergeSwarm(swarm);
    await this.#completeNode(ctx, nodeId, merged);
    void this.#tick(ctx);
  }

  #mergeSwarm(swarm: SwarmState): Record<string, unknown> {
    const ordered = [...swarm.results.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    if (swarm.config.mergeStrategy === 'majority_vote') {
      const tally = new Map<string, number>();
      for (const r of ordered) {
        const key = JSON.stringify(r);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      let bestKey = '';
      let bestN = -1;
      for (const [k, n] of tally) {
        if (n > bestN) {
          bestN = n;
          bestKey = k;
        }
      }
      return {
        [swarm.config.outputKey]: bestKey ? JSON.parse(bestKey) : null,
        votes: bestN,
        count: ordered.length,
        strategy: 'majority_vote',
      };
    }
    return {
      [swarm.config.outputKey]: ordered,
      count: ordered.length,
      failures: swarm.failures.size,
      strategy: 'collect_all',
    };
  }

  async #executeScratchpadNode(
    ctx: RunningContext,
    config: ScratchpadNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (config.operation) {
      case 'read': {
        const value = this.deps.scratchpad.read(ctx.runId, config.key);
        return { [config.key]: value ?? null };
      }
      case 'write': {
        const value =
          config.valuePath !== undefined ? lookupPath(inputData, config.valuePath) : inputData;
        this.deps.scratchpad.write(ctx.runId, config.key, value);
        return { [config.key]: value };
      }
      case 'append': {
        const existing = this.deps.scratchpad.read(ctx.runId, config.key);
        const arr = Array.isArray(existing) ? [...existing] : [];
        const value =
          config.valuePath !== undefined ? lookupPath(inputData, config.valuePath) : inputData;
        arr.push(value);
        this.deps.scratchpad.write(ctx.runId, config.key, arr);
        return { [config.key]: arr };
      }
      case 'delete': {
        this.deps.scratchpad.delete(ctx.runId, config.key);
        return { [config.key]: null };
      }
    }
  }

  #executeRouter(
    ctx: RunningContext,
    config: RouterNodeConfig,
    inputData: Record<string, unknown>,
  ): string[] {
    const scope = { inputs: inputData, scratchpad: this.deps.scratchpad.snapshotOf(ctx.runId) };
    const matches: string[] = [];
    for (const branch of config.branches) {
      if (evalCondition(branch.condition, scope)) {
        matches.push(branch.branchId);
        if (config.routingMode === 'first_match') break;
      }
    }
    return matches;
  }

  /**
   * LLM-routed router. Asks the configured evaluator-tier model to pick exactly
   * one branch by id, given the branch labels + the current input. Falls back
   * to `first_match` semantics if the evaluator runtime isn't wired or if the
   * LLM response can't be parsed.
   */
  async #executeRouterLlm(
    ctx: RunningContext,
    node: WorkflowNode,
    config: RouterNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<string[]> {
    if (!this.deps.evaluatorRuntime) {
      this.deps.logger.warn('engine.router.llm_route.no_runtime', { nodeId: node.id });
      return this.#executeRouter(ctx, { ...config, routingMode: 'first_match' }, inputData);
    }
    try {
      const branchIds = config.branches.map((b) => b.branchId);
      const decision = await this.deps.evaluatorRuntime.routeBranch({
        workspaceId: ctx.workspaceId,
        input: inputData,
        branches: config.branches.map((b) => ({ branchId: b.branchId, label: b.label, condition: b.condition })),
      });
      if (decision && branchIds.includes(decision)) {
        return [decision];
      }
      this.deps.logger.warn('engine.router.llm_route.bad_decision', { nodeId: node.id, decision });
    } catch (err) {
      this.deps.logger.warn('engine.router.llm_route.failed', { nodeId: node.id, err: (err as Error).message });
    }
    return this.#executeRouter(ctx, { ...config, routingMode: 'first_match' }, inputData);
  }

  // ────────────────────────────────────────────────────────────
  // New deterministic primitives — wait / transform / filter
  // ────────────────────────────────────────────────────────────

  async #executeWait(
    ctx: RunningContext,
    node: WorkflowNode,
    config: WaitNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    const delayMs = Math.max(0, Math.floor(config.delayMs ?? 0));
    if (delayMs <= 0) {
      await this.#completeNode(ctx, node.id, inputData);
      return;
    }
    // Persist the wake-at on the active execution so a crash mid-wait isn't
    // a silent run loss — the WaitRecovery boot scan can pick it up. The
    // synthetic execution keeps the settle loop from marking the run COMPLETED
    // while the timer is pending.
    const wakeAt = new Date(Date.now() + delayMs).toISOString();
    ctx.state.activeExecutions[node.id] = {
      taskId: `wait:${node.id}`,
      nodeId: node.id,
      executorType: 'wait',
      executorRef: `timer:${delayMs}ms`,
      startedAt: new Date().toISOString(),
      ...({ wakeAt, inputData } as Record<string, unknown>),
    };
    // Persist the run-state mid-wait so a restart can recover this exact
    // wait state. Without this the runState row reflects the pre-wait
    // moment and the recovery pass can't see the pending timer.
    await this.#persistRun(ctx);
    const timer = setTimeout(() => {
      delete ctx.state.activeExecutions[node.id];
      void (async () => {
        await this.#completeNode(ctx, node.id, inputData);
        void this.#tick(ctx);
      })();
    }, delayMs);
    // Don't keep the process alive solely for a long wait.
    timer.unref?.();
  }

  #executeTransform(
    config: TransformNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Record<string, unknown> {
    const result = evaluateExpression<unknown>(config.expression, {
      input: inputData,
      ctx: { trigger: tctx.trigger, nodes: tctx.nodes, scratchpad: tctx.scratchpad, store: tctx.store },
    });
    if (config.outputKey) {
      return { [config.outputKey]: result };
    }
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return { value: result };
  }

  #executeFilter(
    config: FilterNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Record<string, unknown> {
    const passed = evaluateBooleanExpression(config.condition, {
      input: inputData,
      ctx: { trigger: tctx.trigger, nodes: tctx.nodes, scratchpad: tctx.scratchpad, store: tctx.store },
    });
    // Filter emits a single payload tagged with the result so downstream nodes
    // can either read the boolean or use sourceHandle gating (`pass`/`skip`).
    return { passed, input: inputData };
  }

  // ────────────────────────────────────────────────────────────
  // Output surface — return_output / artifact_save (Layer 6)
  // ────────────────────────────────────────────────────────────

  /**
   * Terminal output node. Selects the value to render and tags it with the
   * `renderAs` viewer hint. The Output API surfaces `renderAs`/`value` to the
   * web Output Surface, which dispatches to the matching viewer (iframe for
   * html, table for rows, etc.).
   */
  #executeReturnOutput(
    config: ReturnOutputNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Record<string, unknown> {
    const renderAs = config.renderAs ?? 'json';
    const value = config.valuePath
      ? readTemplatePath(tctx, config.valuePath) ?? readDotPath(inputData, config.valuePath)
      : inputData;
    return {
      renderAs,
      ...(config.title ? { title: config.title } : {}),
      value: value ?? null,
    };
  }

  /**
   * Persist a value as a workspace artifact (immutable run receipt). V1 stores
   * content inline in the `artifacts` table — the same store used by
   * `artifact_collect`. Returns an artifact ref so downstream nodes and the
   * Output gallery can reference it.
   */
  async #executeArtifactSave(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ArtifactSaveNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = (config.name ?? 'artifact').trim() || 'artifact';
    const rawContent = config.contentPath ? readDotPath(inputData, config.contentPath) : inputData;
    const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? null, null, 2);
    const title = config.titlePath ? String(readDotPath(inputData, config.titlePath) ?? name) : name;
    const type = config.artifactType ?? inferArtifactType(name, content);
    const artifact = this.#persistArtifact(ctx, node, { name, title, type, content, savedBy: 'artifact_save' });
    return { artifact, artifactId: artifact.id };
  }

  /**
   * Insert an artifact row (immutable run receipt). Shared by `artifact_save`
   * and the `browser` node. Content is stored inline (V1); binary payloads
   * (screenshots/PDFs) are persisted as `data:` URLs so the Output gallery can
   * preview + download them without a separate blob endpoint.
   */
  #persistArtifact(
    ctx: RunningContext,
    node: WorkflowNode,
    args: { name: string; title?: string; type: 'html' | 'image' | 'document' | 'code' | 'data'; content: string; savedBy: string },
  ): { id: string; name: string; title: string; type: string; contentType: string; size: number } {
    const id = randomUUID();
    const now = new Date().toISOString();
    const title = (args.title ?? args.name).slice(0, 200);
    // testNode() uses a synthetic `test-…` runId with no workflow_runs row —
    // null the FK so dry-running an artifact_save/browser node from the canvas
    // Test tab doesn't trip the run_id foreign key.
    const runId = ctx.runId.startsWith('test-') ? null : ctx.runId;
    try {
      this.deps.db
        .insert(schema.artifacts)
        .values({
          id,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          type: args.type,
          title,
          content: args.content,
          thumbnailUrl: null,
          runId,
          workflowId: ctx.workflowId,
          agentId: null,
          conversationId: null,
          nodeId: node.id,
          metadata: { name: args.name, savedBy: args.savedBy },
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (err) {
      this.deps.logger.warn('artifact.persist_failed', {
        runId: ctx.runId, nodeId: node.id, message: (err as Error).message,
      });
      throw new AgentisError('INTERNAL_ERROR', `artifact persist failed: ${(err as Error).message}`);
    }
    return { id, name: args.name, title, type: args.type, contentType: contentTypeFor(args.name, args.type), size: args.content.length };
  }

  /**
   * Native browser node (Layer 3 §3.2). Renders HTML / navigates URLs via the
   * BrowserPool (headless Chromium) and persists screenshots/PDFs as artifacts.
   */
  async #executeBrowser(
    ctx: RunningContext,
    node: WorkflowNode,
    config: BrowserNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.browserPool) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'browser node present but BrowserPool not wired');
    }
    const html = config.html
      ?? (config.htmlPath ? asString(readDotPath(inputData, config.htmlPath)) : extractInputHtml(inputData));
    const opts = {
      url: config.url,
      html: html || undefined,
      selector: config.selector,
      formData: config.formData,
      submitSelector: config.submitSelector,
      fullPage: config.fullPage,
      headless: config.headless,
      viewport: config.viewport,
      timeout: config.timeout,
    };
    ctx.state.activeExecutions[node.id] = {
      taskId: `browser:${node.id}`,
      nodeId: node.id,
      executorType: 'browser',
      executorRef: config.operation,
      startedAt: new Date().toISOString(),
    };
    try {
      switch (config.operation) {
        case 'serve_html':
        case 'screenshot': {
          const png = await this.deps.browserPool.screenshot(opts);
          const name = config.artifactName ?? (config.operation === 'serve_html' ? 'page.png' : 'screenshot.png');
          const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
          const artifact = this.#persistArtifact(ctx, node, { name, type: 'image', content: dataUrl, savedBy: 'browser' });
          if (config.operation === 'serve_html') {
            // Emit both the live HTML (for a downstream return_output iframe) and
            // the screenshot artifact card.
            return { type: 'html', content: html ?? '', screenshot: artifact, artifactId: artifact.id };
          }
          return { screenshot: artifact, artifactId: artifact.id };
        }
        case 'pdf': {
          const pdf = await this.deps.browserPool.pdf(opts);
          const name = config.artifactName ?? 'document.pdf';
          const dataUrl = `data:application/pdf;base64,${pdf.toString('base64')}`;
          const artifact = this.#persistArtifact(ctx, node, { name, type: 'document', content: dataUrl, savedBy: 'browser' });
          return { pdf: artifact, artifactId: artifact.id };
        }
        case 'navigate': {
          const r = await this.deps.browserPool.navigate(opts);
          return { title: r.title, text: r.text, html: r.html };
        }
        case 'extract_text': {
          const text = await this.deps.browserPool.extractText(opts);
          return { text };
        }
        case 'fill_form': {
          const r = await this.deps.browserPool.fillForm(opts);
          return { title: r.title, values: r.values, html: r.html };
        }
        case 'extract_table': {
          const rows = await this.deps.browserPool.extractTable(opts);
          return { rows, count: rows.length };
        }
        default:
          throw new AgentisError('VALIDATION_FAILED', `browser: unknown operation ${(config as { operation: string }).operation}`);
      }
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  // ────────────────────────────────────────────────────────────
  // Integration / HTTP
  // ────────────────────────────────────────────────────────────

  async #executeIntegration(
    ctx: RunningContext,
    node: WorkflowNode,
    config: IntegrationNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.connectors) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'integration node present but ConnectorRegistry not wired');
    }
    if (!config.integrationId) {
      throw new AgentisError('VALIDATION_FAILED', 'integration node missing integrationId');
    }
    if (!config.operationId) {
      throw new AgentisError('VALIDATION_FAILED', 'integration node missing operationId');
    }
    let credential: Record<string, unknown> | null = null;
    if (config.credentialId) {
      if (!this.deps.vault) {
        throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'integration node references a credential but CredentialVault is not wired');
      }
      const row = this.deps.db
        .select()
        .from(schema.credentials)
        .where(and(eq(schema.credentials.id, config.credentialId), eq(schema.credentials.workspaceId, ctx.workspaceId)))
        .get();
      if (!row) {
        throw new AgentisError('RESOURCE_NOT_FOUND', `credential '${config.credentialId}' not found`);
      }
      try {
        const decoded = this.deps.vault.decrypt(row.encryptedValue);
        const parsed = parseJsonOrString(decoded);
        credential = typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : { value: decoded };
      } catch (err) {
        throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', `failed to decrypt credential: ${(err as Error).message}`);
      }
    }
    ctx.state.activeExecutions[node.id] = {
      taskId: `integration:${node.id}`,
      nodeId: node.id,
      executorType: 'integration',
      executorRef: `${config.integrationId}.${config.operationId}`,
      startedAt: new Date().toISOString(),
    };
    try {
      const result = await this.deps.connectors.execute(config.integrationId, {
        operation: config.operationId,
        params: config.inputs ?? {},
        credential,
        inputData,
      });
      return result;
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  async #executeHttpRequest(
    ctx: RunningContext,
    node: WorkflowNode,
    config: HttpRequestNodeConfig,
  ): Promise<Record<string, unknown>> {
    if (!config.url) throw new AgentisError('VALIDATION_FAILED', 'http_request node missing url');
    const method = (config.method ?? 'GET').toUpperCase();
    const timeoutMs = Math.max(1, Math.min(config.timeoutMs ?? 30_000, 120_000));
    const maxRetries = Math.max(0, Math.min(config.maxRetries ?? 0, 5));
    const retryOn = new Set((config.retryOn ?? []).map((c) => Number(c)));
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    if (config.auth) {
      switch (config.auth.type) {
        case 'bearer':
          headers['authorization'] = `Bearer ${config.auth.token}`;
          break;
        case 'api_key':
          headers[config.auth.header.toLowerCase()] = config.auth.token;
          break;
        case 'basic': {
          const encoded = Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64');
          headers['authorization'] = `Basic ${encoded}`;
          break;
        }
        default:
          break;
      }
    }
    ctx.state.activeExecutions[node.id] = {
      taskId: `http:${node.id}`,
      nodeId: node.id,
      executorType: 'http',
      executorRef: `${method} ${redactUrl(config.url)}`,
      startedAt: new Date().toISOString(),
    };
    try {
      let attempt = 0;
      let lastError: Error | null = null;
      while (attempt <= maxRetries) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(config.url, {
            method,
            headers,
            body: method === 'GET' || method === 'DELETE' ? undefined : config.body,
            signal: controller.signal,
          });
          clearTimeout(timer);
          const text = await res.text();
          let parsed: unknown = text;
          if (text && res.headers.get('content-type')?.includes('json')) {
            try {
              parsed = JSON.parse(text);
            } catch {
              /* keep text */
            }
          }
          if (!res.ok) {
            if (retryOn.has(res.status) && attempt < maxRetries) {
              attempt += 1;
              await sleep(backoffMs(attempt));
              continue;
            }
            return {
              ok: false,
              status: res.status,
              body: parsed,
            };
          }
          const out: Record<string, unknown> = {
            ok: true,
            status: res.status,
            body: parsed,
          };
          if (config.responseMapping) {
            const key = config.responseMapping.outputKey;
            if (config.responseMapping.bodyPath) {
              out[key] = readDotPath(parsed, config.responseMapping.bodyPath);
            } else {
              out[key] = parsed;
            }
          }
          return out;
        } catch (err) {
          clearTimeout(timer);
          lastError = err as Error;
          if (attempt >= maxRetries) break;
          attempt += 1;
          await sleep(backoffMs(attempt));
        }
      }
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `http_request failed: ${lastError?.message ?? 'unknown error'}`);
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  // ────────────────────────────────────────────────────────────
  // Workflow-scoped persistent KV
  // ────────────────────────────────────────────────────────────

  async #executeWorkflowStore(
    ctx: RunningContext,
    config: WorkflowStoreNodeConfig,
    tctx: TemplateContext,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.workflowStore) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'workflow_store node present but WorkflowStoreService not wired');
    }
    if (!ctx.workflowId) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'workflow_store node requires a persistent workflow id (ephemeral runs are not supported)');
    }
    const out: Record<string, unknown> = {};
    for (const op of config.operations ?? []) {
      const key = op.key ? resolveTemplate(op.key, tctx) : undefined;
      const outKey = op.outputKey ?? key ?? op.op;
      switch (op.op) {
        case 'get': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workflow_store.get requires a key');
          out[outKey] = this.deps.workflowStore.get(ctx.workspaceId, ctx.workflowId, key);
          break;
        }
        case 'set': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workflow_store.set requires a key');
          const value = op.value !== undefined ? parseJsonOrString(resolveTemplate(op.value, tctx)) : undefined;
          out[outKey] = this.deps.workflowStore.set(ctx.workspaceId, ctx.workflowId, key, value);
          break;
        }
        case 'delete': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workflow_store.delete requires a key');
          out[outKey] = this.deps.workflowStore.delete(ctx.workspaceId, ctx.workflowId, key);
          break;
        }
        case 'increment': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workflow_store.increment requires a key');
          out[outKey] = this.deps.workflowStore.increment(ctx.workspaceId, ctx.workflowId, key, op.incrementBy ?? 1);
          break;
        }
        case 'append': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workflow_store.append requires a key');
          const value = op.value !== undefined ? parseJsonOrString(resolveTemplate(op.value, tctx)) : undefined;
          out[outKey] = this.deps.workflowStore.append(ctx.workspaceId, ctx.workflowId, key, value);
          break;
        }
        case 'get_all': {
          out[outKey] = this.deps.workflowStore.snapshot(ctx.workspaceId, ctx.workflowId);
          break;
        }
        default:
          throw new AgentisError('VALIDATION_FAILED', `workflow_store: unknown op ${(op as { op: string }).op}`);
      }
    }
    return out;
  }

  async #executeWorkspaceStore(
    ctx: RunningContext,
    config: WorkspaceStoreNodeConfig,
    tctx: TemplateContext,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.workspaceStore) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'workspace_store node present but WorkspaceStoreService not wired');
    }
    const ws = ctx.workspaceId;
    const out: Record<string, unknown> = {};
    for (const op of config.operations ?? []) {
      const key = op.key ? resolveTemplate(op.key, tctx) : undefined;
      const outKey = op.outputKey ?? key ?? op.op;
      switch (op.op) {
        case 'get':
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workspace_store.get requires a key');
          out[outKey] = this.deps.workspaceStore.get(ws, key);
          break;
        case 'set': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workspace_store.set requires a key');
          const value = op.value !== undefined ? parseJsonOrString(resolveTemplate(op.value, tctx)) : undefined;
          out[outKey] = this.deps.workspaceStore.set(ws, key, value);
          break;
        }
        case 'delete':
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workspace_store.delete requires a key');
          out[outKey] = this.deps.workspaceStore.delete(ws, key);
          break;
        case 'increment':
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workspace_store.increment requires a key');
          out[outKey] = this.deps.workspaceStore.increment(ws, key, op.incrementBy ?? 1);
          break;
        case 'append': {
          if (!key) throw new AgentisError('VALIDATION_FAILED', 'workspace_store.append requires a key');
          const value = op.value !== undefined ? parseJsonOrString(resolveTemplate(op.value, tctx)) : undefined;
          out[outKey] = this.deps.workspaceStore.append(ws, key, value);
          break;
        }
        case 'get_all':
          out[outKey] = this.deps.workspaceStore.snapshot(ws);
          break;
        default:
          throw new AgentisError('VALIDATION_FAILED', `workspace_store: unknown op ${(op as { op: string }).op}`);
      }
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────
  // Evaluator / Guardrails
  // ────────────────────────────────────────────────────────────

  async #executeEvaluator(
    ctx: RunningContext,
    node: WorkflowNode,
    config: EvaluatorNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.evaluatorRuntime) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'evaluator node present but EvaluatorRuntime not wired');
    }
    if (!config.targetPath) {
      throw new AgentisError('VALIDATION_FAILED', 'evaluator node missing targetPath');
    }
    // Read the raw value (typed, not stringified) from the input or run context.
    const target = readTemplatePath({ ...tctx, trigger: inputData, nodes: { ...tctx.nodes, input: inputData } }, config.targetPath)
      ?? readDotPath(inputData, config.targetPath);
    if (target === undefined) {
      throw new AgentisError('VALIDATION_FAILED', `evaluator: targetPath '${config.targetPath}' did not resolve`);
    }
    ctx.state.activeExecutions[node.id] = {
      taskId: `evaluator:${node.id}`,
      nodeId: node.id,
      executorType: 'evaluator',
      executorRef: 'llm_judge',
      startedAt: new Date().toISOString(),
    };
    try {
      // Track FAIL→retry cycles via a tagged inputData field — the evaluator-retry
      // pattern routes back to the upstream agent_task, which receives a bumped
      // iterationCount on each cycle.
      const prevIteration = Number(inputData['__evalIteration'] ?? 0);
      const verdict = await this.deps.evaluatorRuntime.evaluate({
        workspaceId: ctx.workspaceId,
        target,
        criteria: config.criteria,
        rubric: config.rubric,
        passThreshold: config.passThreshold,
      });
      return {
        score: verdict.score,
        passed: verdict.passed,
        critique: verdict.critique,
        dimensionScores: verdict.dimensionScores,
        iterationCount: prevIteration + 1,
        maxRetriesReached: prevIteration + 1 >= (config.maxRetries ?? 3),
      };
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  #executeGuardrails(
    config: GuardrailsNodeConfig,
    inputData: Record<string, unknown>,
  ): { shouldFail: boolean; message: string; output: Record<string, unknown> } {
    const violations: Array<{ rule: string; target: string; message: string }> = [];
    for (const rule of config.rules ?? []) {
      const value = readDotPath(inputData, rule.target);
      const ok = checkGuardrail(rule.type, value, rule);
      if (!ok) {
        violations.push({
          rule: rule.type,
          target: rule.target,
          message: rule.message ?? `guardrail '${rule.type}' failed for '${rule.target}'`,
        });
      }
    }
    const block = (config.onViolation ?? 'block') === 'block' && violations.length > 0;
    return {
      shouldFail: block,
      message: violations.map((v) => v.message).join('; ') || 'guardrails violated',
      output: { ...inputData, guardrailViolations: violations },
    };
  }

  // ────────────────────────────────────────────────────────────
  // Loop
  // ────────────────────────────────────────────────────────────

  async #dispatchLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    config: LoopNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Promise<void> {
    if (!this.deps.subflows) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'loop node present but SubflowExecutor not wired');
    }
    if (!config.bodyWorkflowId) {
      throw new AgentisError('VALIDATION_FAILED', 'loop node missing bodyWorkflowId');
    }
    // Resolve items array — accept either a `{{path}}` template or a raw dot path.
    let items: unknown;
    if (config.itemsExpression?.includes('{{')) {
      // Stringified pass — we need typed access, so read the path directly.
      const stripped = config.itemsExpression.replace(/^\{\{\s*|\s*\}\}$/g, '');
      items = readTemplatePath(tctx, stripped);
    } else if (config.itemsExpression) {
      items = readTemplatePath(tctx, config.itemsExpression) ?? readDotPath(inputData, config.itemsExpression);
    }
    if (!Array.isArray(items)) {
      throw new AgentisError('VALIDATION_FAILED', `loop.itemsExpression did not resolve to an array (got ${typeof items})`);
    }
    if (items.length === 0) {
      await this.#completeNode(ctx, node.id, { [config.outputArrayKey]: [], count: 0 });
      return;
    }
    const concurrency = Math.max(1, Math.min(config.maxConcurrency ?? 1, 32));
    const chunkSize = Math.max(1, config.chunkSize ?? items.length);
    const errorPolicy = config.onIterationError ?? 'stop_all';

    ctx.state.activeExecutions[node.id] = {
      taskId: `loop:${node.id}`,
      nodeId: node.id,
      executorType: 'loop',
      executorRef: `${items.length} items, c=${concurrency}, chunk=${chunkSize}`,
      startedAt: new Date().toISOString(),
    };

    // Run loop fully async; complete/fail the node once all chunks settle.
    void this.#runLoop(ctx, node, config, items, concurrency, chunkSize, errorPolicy)
      .catch((err) => {
        delete ctx.state.activeExecutions[node.id];
        void this.#failNode(ctx, node.id, (err as Error).message);
        void this.#tick(ctx);
      });
  }

  async #runLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    config: LoopNodeConfig,
    items: unknown[],
    concurrency: number,
    chunkSize: number,
    errorPolicy: 'stop_all' | 'continue' | 'collect_errors',
  ): Promise<void> {
    const results: unknown[] = new Array(items.length);
    const errors: Array<{ index: number; message: string }> = [];

    for (let chunkStart = 0; chunkStart < items.length; chunkStart += chunkSize) {
      const chunkEnd = Math.min(chunkStart + chunkSize, items.length);
      const chunkIndexes: number[] = [];
      for (let i = chunkStart; i < chunkEnd; i += 1) chunkIndexes.push(i);

      // Process this chunk with bounded concurrency.
      const pool: Array<Promise<void>> = [];
      const next = (async () => {
        let cursor = 0;
        const runOne = async (i: number): Promise<void> => {
          try {
            const itemOutput = await this.#runLoopIteration(ctx, node, config, items[i], i);
            results[i] = itemOutput;
          } catch (err) {
            const message = (err as Error).message;
            errors.push({ index: i, message });
            if (errorPolicy === 'stop_all') throw err;
          }
        };
        const workers: Array<Promise<void>> = [];
        const launch = async (): Promise<void> => {
          while (cursor < chunkIndexes.length) {
            const my = chunkIndexes[cursor++]!;
            await runOne(my);
          }
        };
        for (let w = 0; w < Math.min(concurrency, chunkIndexes.length); w += 1) {
          workers.push(launch());
        }
        await Promise.all(workers);
      })();
      pool.push(next);

      try {
        await Promise.all(pool);
      } catch (err) {
        // stop_all: bubble up.
        delete ctx.state.activeExecutions[node.id];
        await this.#failNode(ctx, node.id, `loop aborted on item ${errors.at(-1)?.index ?? '?'}: ${(err as Error).message}`);
        void this.#tick(ctx);
        return;
      }

      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.LOOP_PROGRESS, {
        runId: ctx.runId,
        nodeId: node.id,
        completed: chunkEnd,
        total: items.length,
        errors: errors.length,
      });

      // Persist per-chunk progress onto the loop node's state. This survives a
      // page refresh (the canvas reads it back) and gives a future
      // idempotent-resume the cursor it needs. NOTE: we deliberately do NOT
      // auto-resume a half-finished loop after a restart — re-running
      // iterations would double-fire their side effects (agent/http/integration
      // calls). Safe loop resume requires per-iteration idempotency keys, which
      // is a separate design. Until then a loop interrupted by a restart fails
      // loud and the operator replays it.
      const loopNs = ctx.state.nodeStates[node.id];
      if (loopNs) {
        loopNs.outputData = {
          ...(loopNs.outputData ?? {}),
          _loopProgress: { completed: chunkEnd, total: items.length, errors: errors.length },
        };
        await this.#persistRun(ctx);
      }
    }

    delete ctx.state.activeExecutions[node.id];
    const output: Record<string, unknown> = {
      [config.outputArrayKey]: results,
      count: items.length,
    };
    if (errorPolicy === 'collect_errors' && errors.length > 0) {
      output['errors'] = errors;
    }
    await this.#completeNode(ctx, node.id, output);
    void this.#tick(ctx);
  }

  /**
   * Run a single loop iteration by delegating to SubflowExecutor.
   * Returns the child run's final output map.
   */
  async #runLoopIteration(
    ctx: RunningContext,
    node: WorkflowNode,
    config: LoopNodeConfig,
    item: unknown,
    index: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      void this.deps.subflows!.start({
        parentRunId: ctx.runId,
        parentNodeId: `${node.id}:item:${index}`,
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        childWorkflowId: config.bodyWorkflowId,
        inputs: { loop: { item, index } },
        resumeParent: async (output) => resolve(output ?? {}),
        failParent: async (msg) => reject(new Error(msg)),
        startChildRun: async (childArgs) => {
          const handle = await this.startRun(childArgs);
          return { runId: handle.runId };
        },
      });
    });
  }

  async #executeCheckpoint(
    ctx: RunningContext,
    node: WorkflowNode,
    config: CheckpointNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    // `task_id` has an FK to `tasks` — we can't stash the node id there, so the
    // resume target is tracked in-memory keyed by the approval id.
    const approval = await this.deps.approvals.create({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      runId: ctx.runId,
      taskId: null,
      gatewayId: null,
      source: 'checkpoint',
      title: node.title || 'Checkpoint approval',
      summary: `Checkpoint pending in workflow run ${ctx.runId}`,
      confidence: null,
    });
    this.#pendingApprovals(ctx).set(approval.id, { kind: 'checkpoint', targetId: node.id });
    // Mark node WAITING; an explicit operator approval will resume the run
    // through ApprovalInboxService.resolve() → engine.notifyTaskCompleted().
    const ns = ctx.state.nodeStates[node.id]!;
    ns.status = 'WAITING';
    await this.#persistRun(ctx);
    this.deps.bus.publish(
      REALTIME_ROOMS.run(ctx.runId),
      REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
      { runId: ctx.runId, nodeId: node.id, reason: 'checkpoint' },
    );
  }

  // ────────────────────────────────────────────────────────────
  // Lifecycle helpers
  // ────────────────────────────────────────────────────────────

  async #startNode(ctx: RunningContext, node: WorkflowNode, inputData: Record<string, unknown>) {
    const ns = ctx.state.nodeStates[node.id]!;
    ns.status = 'RUNNING';
    ns.startedAt = new Date().toISOString();
    ns.inputData = inputData;
    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: 'node.started',
      nodeId: node.id,
      payload: { title: node.title, type: node.type },
    });
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_STARTED, {
      runId: ctx.runId,
      nodeId: node.id,
    });
    this.#emitWorkStep(ctx, node, 'start');
    this.#onPhaseNodeStart(ctx, node);
    this.#audit(ctx, {
      nodeId: node.id,
      action: 'node.started',
      actorType: node.config.kind === 'agent_task' || node.config.kind === 'agent_swarm' ? 'agent' : 'system',
      actorId: nodeActorId(node),
      inputSummary: summarizeForAudit(inputData),
    });
    ctx.eventsSinceSnapshot += 1;
  }

  /** Record an audit entry, enriching it with the node's phase. Best-effort. */
  #audit(ctx: RunningContext, entry: {
    nodeId?: string;
    action: string;
    actorType: 'agent' | 'user' | 'system' | 'scheduler';
    actorId: string;
    inputSummary?: string | null;
    outputSummary?: string | null;
    costCents?: number | null;
  }): void {
    if (!this.deps.audit) return;
    this.deps.audit.record({
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      phaseId: entry.nodeId ? phaseIdForNode(ctx.graph, entry.nodeId) : null,
      nodeId: entry.nodeId ?? null,
      agentId: entry.actorType === 'agent' ? entry.actorId : null,
      action: entry.action,
      actorType: entry.actorType,
      actorId: entry.actorId,
      inputSummary: entry.inputSummary ?? null,
      outputSummary: entry.outputSummary ?? null,
      costCents: entry.costCents ?? null,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Phase execution model (Layer 5): SLA tracking + budget governance
  // ────────────────────────────────────────────────────────────

  #phaseRuntime(ctx: RunningContext): Map<string, PhaseRuntimeState> {
    if (!ctx.phaseRuntime) ctx.phaseRuntime = new Map();
    return ctx.phaseRuntime;
  }

  #pendingApprovals(ctx: RunningContext): Map<string, { kind: 'checkpoint' | 'phase_gate'; targetId: string }> {
    if (!ctx.pendingApprovals) ctx.pendingApprovals = new Map();
    return ctx.pendingApprovals;
  }

  /**
   * Route an approval resolution to the right resume path (checkpoint node or
   * phase gate). The resume target is looked up from the in-memory map keyed by
   * the approval id. Public — called from the approval-resolution wiring.
   */
  async resolveApproval(args: { runId: string; approvalId: string; decision: 'approve' | 'reject' }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    const pending = ctx.pendingApprovals?.get(args.approvalId);
    if (!pending) return;
    ctx.pendingApprovals!.delete(args.approvalId);
    if (pending.kind === 'phase_gate') {
      if (args.decision === 'approve') await this.resumePhaseGate({ runId: args.runId, phaseId: pending.targetId });
      else await this.failRunForGate({ runId: args.runId, phaseId: pending.targetId, reason: 'Phase gate rejected' });
      return;
    }
    // checkpoint: approve completes the node; reject leaves it waiting (V1).
    if (args.decision === 'approve') {
      await this.notifyTaskCompleted({ runId: args.runId, nodeId: pending.targetId, output: { approved: true } });
    }
  }

  /** Start the phase clock + SLA timer the first time any of its nodes runs. */
  #onPhaseNodeStart(ctx: RunningContext, node: WorkflowNode): void {
    const phaseId = phaseIdForNode(ctx.graph, node.id);
    if (!phaseId) return;
    const phase = ctx.graph.phases?.find((p) => p.id === phaseId);
    if (!phase) return;
    const rt = this.#phaseRuntime(ctx);
    let st = rt.get(phaseId);
    if (!st) { st = { started: false, startedAt: 0, cost: 0, slaBreached: false }; rt.set(phaseId, st); }
    if (st.started) return;
    st.started = true;
    st.startedAt = Date.now();
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.PHASE_STARTED, {
      runId: ctx.runId, phaseId, name: phase.name,
    });
    if (typeof phase.slaDurationMs === 'number' && phase.slaDurationMs > 0) {
      const timer = setTimeout(() => {
        st!.slaBreached = true;
        const payload = { runId: ctx.runId, phaseId, name: phase.name, slaDurationMs: phase.slaDurationMs };
        this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.PHASE_SLA_BREACHED, payload);
        this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.PHASE_SLA_BREACHED, payload);
        this.#audit(ctx, { action: 'phase.sla_breached', actorType: 'system', actorId: 'engine', outputSummary: `phase ${phase.name} exceeded ${phase.slaDurationMs}ms` });
      }, phase.slaDurationMs);
      timer.unref?.();
      st.slaTimer = timer;
    }
  }

  /**
   * Accrue a completed node's cost into its phase. Returns true when the phase
   * budget is exceeded (the caller halts the run). Also emits PHASE_COMPLETED
   * and clears the SLA timer when the phase finishes.
   */
  #onPhaseNodeComplete(ctx: RunningContext, node: WorkflowNode): boolean {
    const phaseId = phaseIdForNode(ctx.graph, node.id);
    if (!phaseId) return false;
    const phase = ctx.graph.phases?.find((p) => p.id === phaseId);
    if (!phase) return false;
    const rt = this.#phaseRuntime(ctx);
    const st = rt.get(phaseId) ?? { started: true, startedAt: Date.now(), cost: 0, slaBreached: false };
    rt.set(phaseId, st);
    st.cost += nodeCostCents(node) ?? 0;

    if (typeof phase.budgetCents === 'number' && st.cost > phase.budgetCents) {
      const payload = { runId: ctx.runId, phaseId, name: phase.name, spentCents: st.cost, budgetCents: phase.budgetCents };
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.BUDGET_PHASE_EXCEEDED, payload);
      this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.BUDGET_PHASE_EXCEEDED, payload);
      this.#audit(ctx, { action: 'budget.phase_exceeded', actorType: 'system', actorId: 'engine', outputSummary: `phase ${phase.name} spent ${st.cost}c > ${phase.budgetCents}c` });
      if (st.slaTimer) clearTimeout(st.slaTimer);
      return true;
    }

    const allDone = phase.nodeIds.every((id) =>
      ctx.state.completedNodeIds.includes(id) || ctx.state.skippedNodeIds.includes(id));
    if (allDone) {
      if (st.slaTimer) clearTimeout(st.slaTimer);
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.PHASE_COMPLETED, {
        runId: ctx.runId, phaseId, name: phase.name, spentCents: st.cost,
        durationMs: st.startedAt ? Date.now() - st.startedAt : null, slaBreached: st.slaBreached,
      });
      this.#audit(ctx, { action: 'phase.completed', actorType: 'system', actorId: 'engine', outputSummary: `${phase.name}: ${st.cost}c` });
    }
    return false;
  }

  /**
   * Per-run workflow cost ceiling (§5.3): the middle budget tier between
   * per-phase and workspace/day. Accrues the completed node's cost into the run
   * total and returns true when it exceeds `workflows.budget_cents`.
   */
  #workflowRunBudgetExceeded(ctx: RunningContext, node: WorkflowNode): boolean {
    ctx.runCostCents = (ctx.runCostCents ?? 0) + (nodeCostCents(node) ?? 0);
    if (ctx.workflowBudgetCents === undefined) {
      const wf = this.deps.db
        .select({ budget: schema.workflows.budgetCents })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, ctx.workflowId))
        .get();
      ctx.workflowBudgetCents = wf?.budget ?? null;
    }
    const cap = ctx.workflowBudgetCents;
    if (cap == null || cap <= 0 || ctx.runCostCents <= cap) return false;
    const payload = { runId: ctx.runId, workflowId: ctx.workflowId, spentCents: ctx.runCostCents, budgetCents: cap };
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.BUDGET_RUN_EXCEEDED, payload);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.BUDGET_RUN_EXCEEDED, payload);
    this.#audit(ctx, { action: 'budget.run_exceeded', actorType: 'system', actorId: 'engine', outputSummary: `run spent ${ctx.runCostCents}c > ${cap}c` });
    return true;
  }

  /**
   * Workspace/day cost ceiling (§5.3): the outermost budget cage above per-phase.
   * Sums the workspace's audited spend since UTC midnight (the just-completed
   * node's cost is already recorded synchronously) and returns true when it
   * exceeds `workspaces.daily_budget_cents`. Uncapped workspaces never trip.
   */
  #workspaceDailyBudgetExceeded(ctx: RunningContext): boolean {
    if (!this.deps.audit) return false;
    const ws = this.deps.db
      .select({ cap: schema.workspaces.dailyBudgetCents })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.workspaceId))
      .get();
    const cap = ws?.cap;
    if (cap == null || cap <= 0) return false;
    const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const spent = this.deps.audit.workspaceSpendSince(ctx.workspaceId, startOfDay);
    if (spent <= cap) return false;
    const payload = { runId: ctx.runId, workspaceId: ctx.workspaceId, spentCents: spent, budgetCents: cap };
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.BUDGET_WORKSPACE_EXCEEDED, payload);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.BUDGET_WORKSPACE_EXCEEDED, payload);
    this.#audit(ctx, { action: 'budget.workspace_exceeded', actorType: 'system', actorId: 'engine', outputSummary: `workspace spent ${spent}c > ${cap}c/day` });
    return true;
  }

  /**
   * Hold a node before dispatch when its phase has a human gate that hasn't been
   * granted. Creates a `phase_gate` approval the first time, marks the node
   * WAITING, and stashes the ready item for re-enqueue on approval. Returns true
   * when the node was held (caller must not dispatch it).
   */
  async #maybeHoldForPhaseGate(ctx: RunningContext, node: WorkflowNode, item: ReadyQueueItem): Promise<boolean> {
    const phaseId = phaseIdForNode(ctx.graph, node.id);
    if (!phaseId) return false;
    const phase = ctx.graph.phases?.find((p) => p.id === phaseId);
    if (!phase?.humanGate) return false;
    const rt = this.#phaseRuntime(ctx);
    let st = rt.get(phaseId);
    if (!st) { st = { started: false, startedAt: 0, cost: 0, slaBreached: false }; rt.set(phaseId, st); }
    if (st.gateState === 'approved') return false;

    st.held = st.held ?? [];
    st.held.push(item);
    const ns = ctx.state.nodeStates[node.id];
    if (ns) ns.status = 'WAITING';

    if (st.gateState !== 'pending') {
      st.gateState = 'pending';
      const approval = await this.deps.approvals.create({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        runId: ctx.runId,
        taskId: null,
        gatewayId: null,
        source: 'phase_gate',
        title: `Approve phase: ${phase.name}`,
        summary: phase.humanGate.message ?? `Phase "${phase.name}" requires approval before it runs.`,
        confidence: null,
      });
      this.#pendingApprovals(ctx).set(approval.id, { kind: 'phase_gate', targetId: phaseId });
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
        runId: ctx.runId, nodeId: node.id, reason: 'phase_gate', phaseId,
      });
      this.#audit(ctx, { nodeId: node.id, action: 'human_gate.requested', actorType: 'system', actorId: 'engine', outputSummary: `phase ${phase.name}` });
    }
    await this.#persistRun(ctx);
    return true;
  }

  /**
   * Release a phase gate (operator approved). Re-enqueues every node held behind
   * the gate and re-enters the dispatch loop. Public — called from the approval
   * resolution handler.
   */
  async resumePhaseGate(args: { runId: string; phaseId: string }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    const st = ctx.phaseRuntime?.get(args.phaseId);
    if (!st || st.gateState === 'approved') return;
    st.gateState = 'approved';
    const held = st.held ?? [];
    st.held = [];
    this.#audit(ctx, { action: 'human_gate.approved', actorType: 'user', actorId: 'operator', outputSummary: `phase ${args.phaseId}` });
    for (const item of held) {
      const ns = ctx.state.nodeStates[item.nodeId];
      if (ns) ns.status = 'PENDING';
      ctx.state.readyQueue.push(item);
    }
    if (ctx.state.status === 'WAITING') ctx.state.status = 'RUNNING';
    await this.#persistRun(ctx);
    void this.#tick(ctx);
  }

  /** Fail a run because a phase gate was rejected. Public — called from approval resolution. */
  async failRunForGate(args: { runId: string; phaseId: string; reason: string }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) {
      await this.#cancelPersistedRun(args.runId);
      return;
    }
    this.#audit(ctx, { action: 'human_gate.rejected', actorType: 'user', actorId: 'operator', outputSummary: `phase ${args.phaseId}: ${args.reason}` });
    markOpenNodesSkipped(ctx.state, args.reason);
    await this.#transitionRunStatus(ctx, 'FAILED');
    this.#runs.delete(args.runId);
  }

  /** Clear any pending phase SLA timers (called on run terminal). */
  #clearPhaseTimers(ctx: RunningContext): void {
    if (!ctx.phaseRuntime) return;
    for (const st of ctx.phaseRuntime.values()) {
      if (st.slaTimer) clearTimeout(st.slaTimer);
    }
  }

  async #completeNode(
    ctx: RunningContext,
    nodeId: string,
    output: Record<string, unknown>,
  ): Promise<void> {
    const ns = ctx.state.nodeStates[nodeId];
    if (!ns) return;
    ns.status = 'COMPLETED';
    ns.completedAt = new Date().toISOString();
    ns.outputData = output;
    if (!ctx.state.completedNodeIds.includes(nodeId)) ctx.state.completedNodeIds.push(nodeId);
    delete ctx.state.activeExecutions[nodeId];

    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: 'node.completed',
      nodeId,
      payload: { output },
    });
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_COMPLETED, {
      runId: ctx.runId,
      nodeId,
      outputPreview: compactRealtimePayload(output),
    });
    const completedNode = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (completedNode) this.#emitWorkStep(ctx, completedNode, 'complete');
    this.#audit(ctx, {
      nodeId,
      action: 'node.completed',
      actorType: completedNode && (completedNode.config.kind === 'agent_task' || completedNode.config.kind === 'agent_swarm') ? 'agent' : 'system',
      actorId: completedNode ? nodeActorId(completedNode) : 'engine',
      outputSummary: summarizeForAudit(output),
      costCents: completedNode ? nodeCostCents(completedNode) : null,
    });
    ctx.eventsSinceSnapshot += 1;

    // Phase governance (Layer 5): accrue cost; on budget overrun, halt the run
    // before fanning out so no further spend occurs. The settle loop in #tick
    // transitions the run to FAILED when `budgetHalt` is set.
    if (completedNode && this.#onPhaseNodeComplete(ctx, completedNode)) {
      ctx.budgetHalt = true;
      markOpenNodesSkipped(ctx.state, 'Halted: phase budget exceeded');
      await this.#persistRun(ctx);
      return;
    }

    // Per-run workflow ceiling (§5.3) — the middle budget tier.
    if (completedNode && this.#workflowRunBudgetExceeded(ctx, completedNode)) {
      ctx.budgetHalt = true;
      markOpenNodesSkipped(ctx.state, 'Halted: workflow run budget exceeded');
      await this.#persistRun(ctx);
      return;
    }

    // Workspace/day ceiling (§5.3) — the outermost budget cage. Checked after
    // every node so a single run can't blow the workspace's daily allowance.
    if (this.#workspaceDailyBudgetExceeded(ctx)) {
      ctx.budgetHalt = true;
      markOpenNodesSkipped(ctx.state, 'Halted: workspace daily budget exceeded');
      await this.#persistRun(ctx);
      return;
    }

    // Fan out to downstream nodes. Error edges are reserved for `#failNode`
    // and must NOT be traversed on a successful completion — but their
    // downstream target IS still waiting on this source's id. Drop it from
    // the required list so the target doesn't block the run from settling.
    for (const edge of ctx.downstreamEdges.get(nodeId) ?? []) {
      const buf = ctx.state.waitingInputs[edge.target];
      if (!buf) continue;

      if (edge.type === 'error') {
        // Catch branch — source completed successfully, so this edge never
        // fires. Drop it from required. If the target has no other required
        // sources AND received no inputs, it's an unreachable catch-only
        // node and we mark it skipped.
        buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
        if (buf.requiredInputs.length === 0 && Object.keys(buf.receivedInputs).length === 0) {
          const targetState = ctx.state.nodeStates[edge.target];
          if (targetState && targetState.status === 'PENDING') {
            targetState.status = 'SKIPPED';
            targetState.completedAt = new Date().toISOString();
            if (!ctx.state.skippedNodeIds.includes(edge.target)) {
              ctx.state.skippedNodeIds.push(edge.target);
            }
          }
          delete ctx.state.waitingInputs[edge.target];
        }
        continue;
      }

      // Conditional edge gating.
      if (edge.condition) {
        const scope = { output, scratchpad: this.deps.scratchpad.snapshotOf(ctx.runId) };
        if (!evalCondition(edge.condition, scope)) continue;
      }

      buf.receivedInputs[nodeId] = output;
      buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
      if (buf.requiredInputs.length === 0) {
        // Promote to ready queue with merged inputs.
        const merged = mergeBufferedInputs(buf);
        ctx.state.readyQueue.push({
          nodeId: edge.target,
          priority: 0,
          insertedAt: new Date().toISOString(),
          inputData: merged,
        });
        delete ctx.state.waitingInputs[edge.target];
      }
    }

    await this.#maybeSnapshot(ctx);
    await this.#persistRun(ctx);
  }

  async #failNode(ctx: RunningContext, nodeId: string, error: string): Promise<void> {
    const ns = ctx.state.nodeStates[nodeId];
    if (!ns) return;
    delete ctx.state.activeExecutions[nodeId];

    // ── Error-edge routing (must happen BEFORE we mark the node as FAILED
    //    or push to failedNodeIds). When a connected error edge exists, the
    //    failure is "handled" — the catch branch runs and the node is
    //    treated as COMPLETED-with-error for settle purposes. This ordering
    //    matters because #tick() can re-enter from another path between
    //    `void this.#failNode()` and its first await, and would see the
    //    failed state and transition the run to FAILED.
    const errorEdges = (ctx.downstreamEdges.get(nodeId) ?? []).filter((e) => e.type === 'error');
    if (errorEdges.length > 0) {
      const errorPayload = {
        ...(ns.inputData ?? {}),
        error: {
          nodeId,
          message: error,
          at: new Date().toISOString(),
        },
      };
      // Mark as completed (not failed) — the catch branch handled it.
      ns.status = 'COMPLETED';
      ns.completedAt = new Date().toISOString();
      ns.error = error;        // keep the error for debugging
      ns.outputData = errorPayload;
      if (!ctx.state.completedNodeIds.includes(nodeId)) ctx.state.completedNodeIds.push(nodeId);

      for (const edge of errorEdges) {
        const buf = ctx.state.waitingInputs[edge.target];
        if (!buf) continue;
        buf.receivedInputs[nodeId] = errorPayload;
        buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
        if (buf.requiredInputs.length === 0) {
          const merged = mergeBufferedInputs(buf);
          ctx.state.readyQueue.push({
            nodeId: edge.target,
            priority: 0,
            insertedAt: new Date().toISOString(),
            inputData: merged,
          });
          delete ctx.state.waitingInputs[edge.target];
        }
      }

      // Emit an explanatory ledger event + bus event so observers still see
      // the failure even though the run continues.
      await this.deps.ledger.append({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        runId: ctx.runId,
        eventType: 'node.failed',
        nodeId,
        payload: { error, handledBy: 'error_edge' },
      });
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_FAILED, {
        runId: ctx.runId,
        nodeId,
        error,
        handledByErrorEdge: true,
      });
      const failedNode = ctx.graph.nodes.find((n) => n.id === nodeId);
      if (failedNode) this.#emitWorkStep(ctx, failedNode, 'fail', error);
      this.#audit(ctx, { nodeId, action: 'node.failed', actorType: 'system', actorId: 'engine', outputSummary: `handled by error edge: ${error}` });
      await this.#persistRun(ctx);
      return;
    }

    // No error edge wired — terminal failure for the node + the run.
    ns.status = 'FAILED';
    ns.completedAt = new Date().toISOString();
    ns.error = error;
    if (!ctx.state.failedNodeIds.includes(nodeId)) ctx.state.failedNodeIds.push(nodeId);

    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: 'node.failed',
      nodeId,
      payload: { error },
    });
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_FAILED, {
      runId: ctx.runId,
      nodeId,
      error,
    });
    const failedNode = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (failedNode) this.#emitWorkStep(ctx, failedNode, 'fail', error);
    this.#audit(ctx, { nodeId, action: 'node.failed', actorType: 'system', actorId: 'engine', outputSummary: error });
    await this.#persistRun(ctx);
  }

  /**
   * Build the template-resolver context snapshot for the current dispatch.
   *
   * Captured once per node so the resolver sees a consistent view even if
   * other nodes complete concurrently. The `nodes` map is keyed by node id;
   * we expose the `outputData` directly so `{{nodes.foo.bar}}` matches the
   * user's intuition about node outputs.
   */
  #buildTemplateContext(ctx: RunningContext, item: ReadyQueueItem, loop?: { item: unknown; index: number }): TemplateContext {
    const nodeOutputs: Record<string, Record<string, unknown>> = {};
    for (const [id, ns] of Object.entries(ctx.state.nodeStates)) {
      if (ns.outputData) nodeOutputs[id] = ns.outputData as Record<string, unknown>;
    }
    // The trigger inputs are whatever the run was started with — the first
    // queued item's inputData on the trigger node carries them.
    const triggerNode = ctx.graph.nodes.find((n) => n.type === 'trigger');
    const triggerInputs = (triggerNode && ctx.state.nodeStates[triggerNode.id]?.inputData) as
      | Record<string, unknown>
      | undefined;
    const scratchpadSnap = this.deps.scratchpad.snapshotOf(ctx.runId);
    // Workflow-store snapshot — empty when the service isn't wired or workflowId is missing.
    const storeSnap = this.deps.workflowStore && ctx.workflowId
      ? this.deps.workflowStore.snapshot(ctx.workspaceId, ctx.workflowId)
      : {};
    // Workspace-store (Tier 3) snapshot — powers `{{workspace.kv.*}}`.
    const workspaceKvSnap = this.deps.workspaceStore
      ? this.deps.workspaceStore.snapshot(ctx.workspaceId)
      : {};
    return buildTemplateContext({
      triggerInputs: triggerInputs ?? item.inputData ?? {},
      nodeOutputs,
      scratchpad: scratchpadSnap,
      store: storeSnap,
      workspace: { id: ctx.workspaceId, kv: workspaceKvSnap },
      run: { id: ctx.runId, startedAt: ctx.startedAt },
      loop,
    });
  }

  #skipBlockedNodes(ctx: RunningContext, reason: string): void {
    markOpenNodesSkipped(ctx.state, reason);
  }

  async #cancelPersistedRun(runId: string): Promise<void> {
    const run = await this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
    if (!run || isTerminalRunStatus(run.status)) return;

    const state = run.runState as unknown as WorkflowRunState | null;
    if (state) {
      state.status = 'CANCELLED';
      markOpenNodesSkipped(state, 'Run cancelled');
    }
    const now = new Date().toISOString();
    await this.deps.db
      .update(schema.workflowRuns)
      .set({
        status: 'CANCELLED',
        runState: (state ?? run.runState) as unknown as object,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.workflowRuns.id, runId));
  }

  /**
   * Publish a human-readable AGENT_WORK_STEP to the workspace room so the
   * canvas Live feed can attribute work to a named agent in real time.
   * NODE_* events stay run-scoped and id-only; this is the agent-facing layer.
   */
  #emitWorkStep(
    ctx: RunningContext,
    node: WorkflowNode,
    phase: 'start' | 'complete' | 'fail',
    detail?: string,
  ): void {
    const config = node.config as { kind?: string; agentId?: string | null };
    const agentId =
      config.kind === 'agent_task' || config.kind === 'agent_swarm'
        ? config.agentId ?? null
        : null;
    let agentName: string | undefined;
    if (agentId) {
      const row = this.deps.db
        .select({ name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();
      agentName = row?.name;
    }
    const description =
      phase === 'start'
        ? node.title
        : phase === 'complete'
          ? `Completed ${node.title}`
          : `Failed at ${node.title}`;
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.AGENT_WORK_STEP, {
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      nodeId: node.id,
      agentId,
      agentName,
      step: config.kind ?? 'node',
      phase,
      description,
      detail,
      progress: {
        done: ctx.state.completedNodeIds.length,
        total: ctx.graph.nodes.length,
      },
    });
  }

  async #transitionRunStatus(ctx: RunningContext, status: WorkflowRunStatus): Promise<void> {
    if (ctx.state.status === status) return;

    // Output contract enforcement: a run transitioning to COMPLETED must match
    // the workflow's declared `outputContract` (when set). Mismatches downgrade
    // to COMPLETED_WITH_CONTRACT_VIOLATION so operators see the problem on the
    // canvas instead of silently shipping bad data. Brain-apps will reuse this
    // exact path when validating an App's typed output surface.
    if (status === 'COMPLETED') {
      const contract = (ctx.graph as { outputContract?: { fields?: Array<{ key: string; type: string; required?: boolean }> } }).outputContract;
      if (contract?.fields && contract.fields.length > 0) {
        const finalOutput = this.#collectFinalOutput(ctx);
        const violations = validateAgainstContract(finalOutput, contract.fields);
        if (violations.length > 0) {
          this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CONTRACT_VIOLATION, {
            runId: ctx.runId,
            violations,
          });
          status = 'COMPLETED_WITH_CONTRACT_VIOLATION';
          // Persist the violations alongside the run state for the Output tab.
          (ctx.state as unknown as { contractViolations?: string[] }).contractViolations = violations;
        }
      }
    }

    const previous = ctx.state.status;
    ctx.state.status = status;
    const finishing = status === 'COMPLETED'
      || status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
      || status === 'FAILED'
      || status === 'CANCELLED';
    await this.deps.db
      .update(schema.workflowRuns)
      .set({
        status,
        runState: ctx.state as unknown as object,
        ...(status === 'RUNNING' && !ctx.startedAt
          ? { startedAt: new Date().toISOString() }
          : {}),
        ...(finishing ? { completedAt: new Date().toISOString() } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, ctx.runId));

    // Finalize all internal bookkeeping (terminal conversation message,
    // subflow parent notification) BEFORE we publish the terminal event.
    // External observers (schedulers, tests, the activity feed) treat
    // RUN_COMPLETED / RUN_FAILED / RUN_CANCELLED as the "everything is done"
    // signal — so any further work performed after the publish would race.
    if (finishing && previous !== status) {
      this.#clearPhaseTimers(ctx);
      await this.#appendTerminalConversationMessage(ctx, status);
      this.#audit(ctx, {
        action: `run.${status.toLowerCase()}`,
        actorType: 'system',
        actorId: 'engine',
        outputSummary: `${ctx.state.completedNodeIds.length} completed, ${ctx.state.failedNodeIds.length} failed`,
      });
      // Self-improvement: after a failure, look for a repeat pattern (§7.2).
      if (status === 'FAILED' && this.deps.instincts) {
        void this.deps.instincts.onRunFailed({
          workspaceId: ctx.workspaceId,
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          state: ctx.state,
        });
      }
    }

    // If this is a child subflow run reaching a terminal state, notify the executor.
    if (finishing && this.deps.subflows && previous !== status) {
      const child = this.deps.db
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, ctx.runId))
        .get();
      if (child?.parentRunId) {
        const parent = this.deps.subflows.findParentByChildRunId(ctx.runId);
        if (parent) {
          // Final output: union of all completed-node outputs, dominated by the
          // last completed terminal node. Lightweight fallback when there's no
          // explicit "return" node.
          const finalNodeId = ctx.state.completedNodeIds.at(-1);
          const finalOutput = (finalNodeId && ctx.state.nodeStates[finalNodeId]?.outputData) || {};
          await this.deps.subflows.onChildRunFinished({
            childRunId: ctx.runId,
            parentRunId: parent.parentRunId,
            parentNodeId: parent.parentNodeId,
            status: status as 'COMPLETED' | 'FAILED' | 'CANCELLED',
            finalOutput: finalOutput as Record<string, unknown>,
            workspaceId: child.workspaceId,
            ambientId: child.ambientId,
            ...(status !== 'COMPLETED' ? { error: `child run ${ctx.runId} ${status}` } : {}),
          });
        }
      }
    }

    const eventName =
      status === 'COMPLETED' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
        ? REALTIME_EVENTS.RUN_COMPLETED
        : status === 'FAILED' || status === 'CANCELLED'
          ? REALTIME_EVENTS.RUN_FAILED
          : REALTIME_EVENTS.RUN_RUNNING;
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), eventName, {
      runId: ctx.runId,
      status,
    });
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), eventName, {
      runId: ctx.runId,
      status,
      workflowId: ctx.workflowId,
    });
  }

  async #persistRun(ctx: RunningContext): Promise<void> {
    await this.deps.db
      .update(schema.workflowRuns)
      .set({
        runState: ctx.state as unknown as object,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, ctx.runId));
  }

  /**
   * Compute the final-output payload for a run, used for outputContract
   * validation. Prefers nodes marked `config.isOutput` over the
   * "last-completed node" heuristic; falls back to the union of every
   * sink node's output when no nodes are explicitly marked.
   */
  #collectFinalOutput(ctx: RunningContext): Record<string, unknown> {
    const outputNodes = ctx.graph.nodes.filter((n) => {
      const cfg = n.config as { isOutput?: boolean };
      return cfg.isOutput === true;
    });
    if (outputNodes.length > 0) {
      const merged: Record<string, unknown> = {};
      for (const n of outputNodes) {
        const out = ctx.state.nodeStates[n.id]?.outputData;
        if (out && typeof out === 'object' && !Array.isArray(out)) {
          Object.assign(merged, out);
        }
      }
      return merged;
    }
    // Fallback — last completed node's output. Matches the subflow parent
    // notification semantics so contract validation and parent handoff agree.
    const finalNodeId = ctx.state.completedNodeIds.at(-1);
    const out = (finalNodeId && ctx.state.nodeStates[finalNodeId]?.outputData) || {};
    return (out && typeof out === 'object' && !Array.isArray(out)) ? (out as Record<string, unknown>) : {};
  }

  async #maybeSnapshot(ctx: RunningContext): Promise<void> {
    if (ctx.eventsSinceSnapshot < CONSTANTS.RUN_STATE_SNAPSHOT_INTERVAL_EVENTS) return;
    ctx.eventsSinceSnapshot = 0;
    await this.deps.db.insert(schema.workflowRunSnapshots).values({
      id: randomUUID(),
      runId: ctx.runId,
      sequenceNumber: ctx.state.lastLedgerSequence,
      runState: ctx.state as unknown as object,
    });
  }

  async #appendTerminalConversationMessage(ctx: RunningContext, status: WorkflowRunStatus): Promise<void> {
    if (!this.deps.conversations) return;
    const run = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, ctx.runId))
      .get();
    const conversationId = run?.conversationId ?? ctx.conversationId ?? null;
    if (!conversationId) return;

    const workflow = run?.workflowId
      ? this.deps.db
          .select({ title: schema.workflows.title })
          .from(schema.workflows)
          .where(eq(schema.workflows.id, run.workflowId))
          .get()
      : null;
    const title = run?.ephemeralTitle ?? workflow?.title ?? 'Workflow run';
    const statusLabel = status === 'COMPLETED' ? 'completed' : status === 'FAILED' ? 'failed' : 'cancelled';

    try {
      this.deps.conversations.appendSystem({
        workspaceId: ctx.workspaceId,
        conversationId,
        sessionMessageId: `run-terminal:${ctx.runId}`,
        body: `Run ${statusLabel}: ${title}`,
        metadata: {
          source: 'workflow',
          runId: ctx.runId,
          workflowId: run?.workflowId ?? null,
          runStatus: status,
          runTitle: title,
          isEphemeral: Boolean(run?.isEphemeral),
        },
      });
    } catch (error) {
      this.deps.logger.warn('engine.conversation_run_bridge.failed', {
        workspaceId: ctx.workspaceId,
        runId: ctx.runId,
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

interface RunningContext {
  runId: string;
  workflowId: string;
  workspaceId: string;
  ambientId: string | null;
  conversationId: string | null;
  userId: string;
  graph: WorkflowGraph;
  downstreamEdges: Map<string, WorkflowEdge[]>;
  state: WorkflowRunState;
  eventsSinceSnapshot: number;
  /**
   * Number of #dispatchNode promise chains currently in-flight. Tracked
   * in-memory only (not persisted). Required because passthrough node kinds
   * never register in activeExecutions but still hold the run open until
   * their #completeNode fan-out runs.
   */
  inflightDispatches: number;
  startedAt?: string;
  scratchpad?: { snapshot: Record<string, unknown> };
  /** Active agent_swarm nodes keyed by node id. */
  swarms: Map<string, SwarmState>;
  /** Self-heal attempt counters keyed by agent_task node id. */
  selfHealAttempts: Map<string, number>;
  /** Per-phase execution runtime (cost accrual + SLA timer). Lazily created. */
  phaseRuntime?: Map<string, PhaseRuntimeState>;
  /** Set when a phase / run / workspace budget is exceeded — settles the run as FAILED. */
  budgetHalt?: boolean;
  /** Accrued cost for this run (cents) — drives the per-run workflow ceiling (§5.3). */
  runCostCents?: number;
  /** Cached workflow per-run budget: undefined = not yet loaded, null = uncapped. */
  workflowBudgetCents?: number | null;
  /** In-memory map of pending approval id → resume target (checkpoint node / phase). */
  pendingApprovals?: Map<string, { kind: 'checkpoint' | 'phase_gate'; targetId: string }>;
}

interface PhaseRuntimeState {
  started: boolean;
  startedAt: number;
  cost: number;
  slaTimer?: ReturnType<typeof setTimeout>;
  slaBreached: boolean;
  /** Human-gate state (§5.1). `none` until the phase's first node is reached. */
  gateState?: 'none' | 'pending' | 'approved';
  /** Ready-queue items held while the gate is pending — re-enqueued on approval. */
  held?: ReadyQueueItem[];
}

interface SwarmState {
  nodeId: string;
  total: number;
  /** Index of the next item to dispatch. */
  next: number;
  items: unknown[];
  agentId: string;
  config: AgentSwarmNodeConfig;
  results: Map<number, Record<string, unknown>>;
  failures: Map<number, string>;
  settled: boolean;
}

/** Parse a `${nodeId}::swarm::${index}` synthetic task id. */
function parseSwarmTaskId(taskId: string): { nodeId: string; index: number } | null {
  const marker = '::swarm::';
  const at = taskId.lastIndexOf(marker);
  if (at < 0) return null;
  const index = Number(taskId.slice(at + marker.length));
  if (!Number.isInteger(index)) return null;
  return { nodeId: taskId.slice(0, at), index };
}

function resolveParallelism(): number {
  const raw = process.env.AGENTIS_WORKFLOW_PARALLELISM ?? CONSTANTS.WORKFLOW_PARALLELISM_DEFAULT;
  if (raw === 'unbounded') return Number.MAX_SAFE_INTEGER;
  if (raw === 'auto') {
    const cpu = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency;
    return Math.max(2, (cpu ?? 4) * 2);
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

function buildDownstreamEdges(graph: WorkflowGraph): Map<string, WorkflowEdge[]> {
  const downstream = new Map<string, WorkflowEdge[]>();
  for (const edge of graph.edges) {
    const edges = downstream.get(edge.source);
    if (edges) edges.push(edge);
    else downstream.set(edge.source, [edge]);
  }
  return downstream;
}

function compactRealtimePayload(value: Record<string, unknown>): Record<string, unknown> {
  const preview: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 8)) {
    if (entry === null || typeof entry !== 'object') {
      preview[key] = entry;
      continue;
    }
    if (Array.isArray(entry)) {
      preview[key] = { type: 'array', count: entry.length };
      continue;
    }
    preview[key] = { type: 'object', keys: Object.keys(entry).slice(0, 8) };
  }
  return preview;
}

function mergeGraphPatch(base: WorkflowGraph, patch: WorkflowGraphPatch): WorkflowGraph {
  const removeIds = new Set(patch.removeNodeIds);
  const updateById = new Map<string, WorkflowNode>(
    patch.updateNodes.map((n) => [n.id, n] as const),
  );
  const removeEdgeIds = new Set(patch.removeEdgeIds);

  // Reject add/update collisions early so the resulting graph stays unique.
  const baseNodeIds = new Set(base.nodes.map((n) => n.id));
  for (const n of patch.addNodes) {
    if (baseNodeIds.has(n.id) && !removeIds.has(n.id)) {
      throw new Error(`Cannot add node ${n.id}: already exists`);
    }
  }
  for (const n of patch.updateNodes) {
    if (!baseNodeIds.has(n.id)) {
      throw new Error(`Cannot update node ${n.id}: not in base graph`);
    }
  }
  for (const id of patch.removeNodeIds) {
    if (!baseNodeIds.has(id)) {
      throw new Error(`Cannot remove node ${id}: not in base graph`);
    }
  }

  const nextNodes: WorkflowNode[] = [];
  for (const n of base.nodes) {
    if (removeIds.has(n.id)) continue;
    nextNodes.push(updateById.get(n.id) ?? n);
  }
  for (const n of patch.addNodes) nextNodes.push(n);

  const surviving = new Set(nextNodes.map((n) => n.id));
  const baseEdgeIds = new Set(base.edges.map((e) => e.id));
  for (const id of patch.removeEdgeIds) {
    if (!baseEdgeIds.has(id)) {
      throw new Error(`Cannot remove edge ${id}: not in base graph`);
    }
  }
  for (const e of patch.addEdges) {
    if (baseEdgeIds.has(e.id)) {
      throw new Error(`Cannot add edge ${e.id}: already exists`);
    }
  }

  const nextEdges: WorkflowEdge[] = [];
  for (const e of base.edges) {
    if (removeEdgeIds.has(e.id)) continue;
    // Drop edges whose endpoints were removed by the patch.
    if (!surviving.has(e.source) || !surviving.has(e.target)) continue;
    nextEdges.push(e);
  }
  for (const e of patch.addEdges) nextEdges.push(e);

  return { ...base, nodes: nextNodes, edges: nextEdges };
}

function mapInputs(
  mapping: Record<string, string>,
  inputData: Record<string, unknown>,
  scratchpad: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(mapping).length === 0) return inputData;
  const out: Record<string, unknown> = {};
  for (const [field, source] of Object.entries(mapping)) {
    // Convention: "scratchpad.x.y" pulls from scratchpad; "inputs.x" or just
    // "x" pulls from the upstream node output. Anything not found becomes
    // null — we never throw at the boundary because workflows often have
    // optional inputs.
    if (source.startsWith('scratchpad.')) {
      out[field] = lookupPath(scratchpad, source.slice('scratchpad.'.length));
    } else if (source.startsWith('inputs.')) {
      out[field] = lookupPath(inputData, source.slice('inputs.'.length));
    } else {
      out[field] = lookupPath(inputData, source);
    }
  }
  return out;
}

function markOpenNodesSkipped(state: WorkflowRunState, reason: string): void {
  const now = new Date().toISOString();
  state.readyQueue = [];
  state.waitingInputs = {};
  state.activeExecutions = {};
  for (const ns of Object.values(state.nodeStates)) {
    if (ns.status === 'PENDING' || ns.status === 'WAITING' || ns.status === 'RUNNING') {
      ns.status = 'SKIPPED';
      ns.completedAt = now;
      ns.error = reason;
      if (!state.skippedNodeIds.includes(ns.nodeId)) state.skippedNodeIds.push(ns.nodeId);
    }
  }
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

function lookupPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const normalized = path.startsWith('$.') ? path.slice(2) : path.startsWith('$') ? path.slice(1) : path;
  const parts = normalized.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function resolveKnowledgeQuery(
  config: KnowledgeNodeConfig,
  inputData: Record<string, unknown>,
  nodeStates: WorkflowRunState['nodeStates'],
): string {
  if ((config.queryMode ?? 'static') === 'dynamic') {
    const source = config.queryNodeId ? nodeStates[config.queryNodeId]?.outputData : inputData;
    const value = lookupPath(source ?? inputData, config.queryPath ?? '');
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return JSON.stringify(value);
  }
  return config.query ?? '';
}

function mergeBufferedInputs(buf: { receivedInputs: Record<string, unknown> }): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [src, value] of Object.entries(buf.receivedInputs)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(merged, value);
    } else {
      merged[src] = value;
    }
  }
  return merged;
}

/**
 * Validate a final-output payload against a `WorkflowContract.fields` shape.
 * Returns human-readable violation messages; empty array means the contract
 * is satisfied. Brain-apps' AppRuntimeContract reuses this same function via
 * the `WorkflowContract` shape — keep it pure and dependency-free.
 */
function validateAgainstContract(
  output: Record<string, unknown>,
  fields: Array<{ key: string; type: string; required?: boolean }>,
): string[] {
  const violations: string[] = [];
  for (const field of fields) {
    const value = output[field.key];
    const present = value !== undefined && value !== null;
    if (!present) {
      if (field.required) violations.push(`Required field "${field.key}" is missing`);
      continue;
    }
    if (field.type === 'any') continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (field.type === 'object' && (actual !== 'object' || Array.isArray(value))) {
      violations.push(`Field "${field.key}" expected object, got ${actual}`);
    } else if (field.type === 'array' && !Array.isArray(value)) {
      violations.push(`Field "${field.key}" expected array, got ${actual}`);
    } else if (field.type === 'string' && actual !== 'string') {
      violations.push(`Field "${field.key}" expected string, got ${actual}`);
    } else if (field.type === 'number' && actual !== 'number') {
      violations.push(`Field "${field.key}" expected number, got ${actual}`);
    } else if (field.type === 'boolean' && actual !== 'boolean') {
      violations.push(`Field "${field.key}" expected boolean, got ${actual}`);
    }
  }
  return violations;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function backoffMs(attempt: number): number {
  // Exponential with jitter, capped at 4s.
  const base = Math.min(4000, 200 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 100);
}

function redactUrl(url: string): string {
  // Strip query params from the executor reference for activity feeds; keep
  // host + path so operators can still recognize the call.
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.length > 60 ? `${url.slice(0, 60)}…` : url;
  }
}

function asString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** The phase id (if any) a node belongs to — for audit + SLA/budget attribution. */
function phaseIdForNode(graph: WorkflowGraph, nodeId: string): string | null {
  for (const phase of graph.phases ?? []) {
    if (phase.nodeIds?.includes(nodeId)) return phase.id;
  }
  return null;
}

/** Best identifier for the actor behind a node — agent id/role for agent nodes, else 'engine'. */
function nodeActorId(node: WorkflowNode): string {
  const cfg = node.config as { kind?: string; agentId?: string; agentRole?: string };
  if (cfg.kind === 'agent_task' || cfg.kind === 'agent_swarm') {
    return cfg.agentId ?? cfg.agentRole ?? 'agent';
  }
  return 'engine';
}

/** Declared per-node cost estimate (cents), if the node carries one. */
function nodeCostCents(node: WorkflowNode): number | null {
  const c = (node.config as { estimatedCostCents?: unknown }).estimatedCostCents;
  return typeof c === 'number' ? c : null;
}

/** Short, log-safe preview of a node payload for the audit trail. */
function summarizeForAudit(value: unknown): string | null {
  if (value == null) return null;
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > 280 ? `${s.slice(0, 279)}…` : s;
  } catch {
    return null;
  }
}

/** Best-effort JSON for embedding input data in a tool-loop task prompt. */
function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 4_000 ? `${s.slice(0, 3_999)}…` : s;
  } catch {
    return String(value);
  }
}

/** Pull an HTML string out of a node input: a string, or `{content|html|body}`. */
function extractInputHtml(inputData: Record<string, unknown>): string {
  for (const key of ['content', 'html', 'body']) {
    const v = inputData[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** Best-effort artifact class from a filename + content shape. */
function inferArtifactType(name: string, content: string): 'html' | 'image' | 'document' | 'code' | 'data' {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['json', 'csv', 'tsv', 'yaml', 'yml'].includes(ext)) return 'data';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'css'].includes(ext)) return 'code';
  if (['md', 'markdown', 'txt', 'pdf', 'docx'].includes(ext)) return 'document';
  const trimmed = content.trim();
  if (/^<!doctype html|^<html|^<h\d|^<div|^<body/i.test(trimmed)) return 'html';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'data';
  return 'document';
}

/** MIME type from filename + coarse artifact class. */
function contentTypeFor(name: string, type: 'html' | 'image' | 'document' | 'code' | 'data'): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const byExt: Record<string, string> = {
    html: 'text/html', htm: 'text/html', md: 'text/markdown', markdown: 'text/markdown',
    json: 'application/json', csv: 'text/csv', pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', txt: 'text/plain',
  };
  if (byExt[ext]) return byExt[ext];
  if (type === 'html') return 'text/html';
  if (type === 'image') return 'image/png';
  if (type === 'data') return 'application/json';
  if (type === 'code') return 'text/x-code-file';
  return 'text/plain';
}

function readDotPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cursor: unknown = obj;
  for (const segment of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function parseJsonOrString(input: string): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return '';
  // Best-effort JSON parse for values authored as templates — fall back to the
  // literal string when the result isn't valid JSON.
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return input;
    }
  }
  return input;
}

function checkGuardrail(
  type: string,
  value: unknown,
  rule: { value?: string; limit?: number },
): boolean {
  const asString = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  switch (type) {
    case 'not_empty':
      if (value == null) return false;
      if (typeof value === 'string') return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value as object).length > 0;
      return Boolean(value);
    case 'min_length':
      return asString(value).length >= (rule.limit ?? 0);
    case 'max_length':
      return asString(value).length <= (rule.limit ?? Number.POSITIVE_INFINITY);
    case 'contains':
      return !!rule.value && asString(value).includes(rule.value);
    case 'not_contains':
      return !!rule.value && !asString(value).includes(rule.value);
    case 'regex':
      if (!rule.value) return true;
      try {
        return new RegExp(rule.value).test(asString(value));
      } catch {
        return false;
      }
    case 'json_schema':
      // Lightweight check — full JSON Schema validation lives in the contract
      // pipeline. For inline guardrails we just verify the value parses as JSON
      // and (optionally) has the declared required top-level keys.
      if (!rule.value) return true;
      try {
        const schema = JSON.parse(rule.value) as { required?: string[] };
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
        if (Array.isArray(schema.required)) {
          for (const key of schema.required) {
            if (!(key in (value as Record<string, unknown>))) return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    default:
      return true;
  }
}
