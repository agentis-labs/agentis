/**
 * Workflow Engine.
 *
 * Owns the run lifecycle. BullMQ (or in-process queue) is plumbing for
 * durability and delayed wake-ups; the engine owns:
 *   - run-state transitions
 *   - the deterministic ready queue
 *   - multi-input buffering (waitingInputs)
 *   - dispatch to extensions/agents/subflows/routers
 *   - ledger writes
 *   - snapshot cadence
 *   - completion / failure / cancellation
 *
 * V1 scope: full happy path for extension_task and trigger nodes; agent_task
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
  type WorkflowSelfHealIncident,
  type WorkflowNodeContractDeviation,
  type ReadyQueueItem,
  type ExtensionTaskNodeConfig,
  type AgentTaskNodeConfig,
  type KnowledgeNodeConfig,
  type KnowledgeIngestNodeConfig,
  type RouterNodeConfig,
  type MergeNodeConfig,
  type CheckpointNodeConfig,
  type HumanInputNodeConfig,
  type ScratchpadNodeConfig,
  type AgentSwarmNodeConfig,
  type ArtifactCollectNodeConfig,
  type WaitNodeConfig,
  type TransformNodeConfig,
  type FilterNodeConfig,
  type IntegrationNodeConfig,
  type McpNodeConfig,
  type DataQueryNodeConfig,
  type DataMutateNodeConfig,
  type AggregateWindowNodeConfig,
  type HttpRequestNodeConfig,
  type WorkflowStoreNodeConfig,
  type WorkspaceStoreNodeConfig,
  type EvaluatorNodeConfig,
  type GuardrailsNodeConfig,
  type LoopNodeConfig,
  type ConvergeNodeConfig,
  type ParallelNodeConfig,
  type ReturnOutputNodeConfig,
  type ArtifactSaveNodeConfig,
  type BrowserNodeConfig,
  type AgentSessionNodeConfig,
  type DynamicSwarmNodeConfig,
  type PlannerNodeConfig,
  type StopErrorNodeConfig,
  type CodeNodeConfig,
  type SpreadsheetNodeConfig,
  type GraphQlNodeConfig,
  type WorkflowEdge,
  type WorkflowGraphPatch,
  type WorkflowRecoveryMode,
  type WorkflowRecoveryTier,
  type AgentRole,
  type AgentTool,
  type AgentRequirements,
  type AgentAdapter,
  type ChatDelta,
  type ToolDefinition,
  type SpecialistDefinition,
  agentSatisfiesRequirements as adapterSatisfiesRequirements,
  describeAgentRequirements,
  hasAgentRequirements,
  requiredAffordanceKeys,
  affordanceLabel,
  type AgentAffordance,
  specialistForRole,
  genericSpecialist,
  roleTools,
  effectiveSpecialistTools,
  normalizeRole,
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
import type { ExtensionRuntime } from '../services/extensionRuntime.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { WorktreeManager, WorktreeHandle } from '../services/worktreeManager.js';
import type { SubflowExecutor } from '../services/subflowExecutor.js';
import type { KnowledgeBaseService } from '../services/knowledgeBase.js';
import type { ConversationStore } from '../services/conversationStore.js';
import { buildIntegrationDeliveryReceipt, manifestHttpConnector, type ConnectorRegistry } from '@agentis/integrations';
import type { WorkflowStoreService } from '../services/workflowStore.js';
import type { WorkspaceStoreService } from '../services/workspaceStore.js';
import type { EvaluationRuntime } from '../services/structuredEvaluatorRuntime.js';
import { StructuredEvaluatorRuntime } from '../services/structuredEvaluatorRuntime.js';
import { AdapterStructuredCompleter, FallbackStructuredCompleter, type StructuredCompleter } from '../services/structuredCompleter.js';
import { WorkflowSelfHealService, type IntentAnchor, type RepairResourceContext, type DeepPlanArgs, type DeepPlanResult } from '../services/workflowSelfHeal.js';
import { getSelfHealConfig, type SelfHealConfig } from '../services/selfHealSettings.js';
import { decideRecoveryPolicy, recoveryFailureFingerprint, recoveryTierForPlan, repairPlanFingerprint } from '../services/workflowRecoveryPolicy.js';
import { composeOperatingManual, getWorkspaceManual } from '../services/agentOperatingManual.js';
import { loadAgentIdentitySnapshot, renderAgentIdentityBlock } from '../services/agentIdentity.js';
import { parseGeneric } from '../services/evaluatorRuntime.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { WorkspaceIntelligenceService } from '../services/workspaceIntelligence.js';
import type { BrowserPool } from '../services/browserPool.js';
import type { SpecialistAgentService } from '../services/specialistAgents.js';
import { resolveResponsibleSpecialist } from '../services/responsibleSpecialist.js';
import type { SpecialistProfileService } from '../services/specialistProfileService.js';
import type { SpecialistRuntimeService } from '../services/specialistRuntimeService.js';
import type { AuditTrailService } from '../services/auditTrail.js';
import type { InstinctEngine } from '../services/instinctEngine.js';
import type { AgentToolRuntime } from '../services/agentToolRuntime.js';
import { AgentToolLoop, type StructuredLlm } from '../services/agentToolLoop.js';
import type { AgentisToolRegistry } from '../services/agentisToolRegistry.js';
import { ChatSessionExecutor } from '../services/chatSessionExecutor.js';
import type { AgentSessionService } from '../services/agentSession.js';
import type { AgentSessionRuntime, SessionRunContext, SessionOutcome, SessionYield } from '../services/agentSessionRuntime.js';
import { attenuateGrant } from '../services/agentSessionRuntime.js';
import type { PlanService } from '../services/planService.js';
import type { AgentMemoryService } from '../services/agentMemory.js';
import type { PersonalBrainService } from '../services/personalBrain.js';
import type { FailureReflectionService } from '../services/failureReflection.js';
import { FeynmanReflectionService, REPEAT_FAILURE_THRESHOLD, type FeynmanTrigger } from '../services/feynmanReflection.js';
import type { AbilityService } from '../services/abilityService.js';
import type { AbilityComposer, ComposerEntry, AbilityTier } from '../services/abilityComposer.js';
import type { SpecialistLoadoutService } from '../services/specialistLoadoutService.js';
import type { SpecialistMindService } from '../services/specialistMindService.js';
import type { EmbeddingProvider } from '../services/embeddingProvider.js';
import { embedText as embedTextHelper } from '../services/embeddingProvider.js';
import type { SharedIntelligenceService } from '../services/sharedIntelligence.js';
import type { CognitivePromotionQueueWorker } from '../services/cognitivePromotionQueueWorker.js';
import { resolveMemoryPolicy } from '../services/memoryPolicyResolver.js';
import type { PeerProfileService } from '../services/peerProfileService.js';
import { evalCondition } from './SafeConditionParser.js';
import { validateWorkflowGraph } from './validateGraph.js';
import { noopTelemetry, type Telemetry } from '../telemetry/index.js';
import { buildTemplateContext, resolveTemplate, resolveTemplateDeep, readTemplatePath, type TemplateContext } from './templateResolver.js';
import { nodeIdempotencyKey } from './idempotency.js';
import { NodeHandlerRegistry } from './handlers/NodeHandler.js';
import { registerPureNodeHandlers } from './handlers/pureHandlers.js';
import { registerUtilityNodeHandlers } from './handlers/utilityHandlers.js';
import { evaluateExpression, evaluateBooleanExpression } from './safeExpression.js';
import { assertSafeUrl } from '../services/safeUrl.js';
import { normalizeWorkflowGraph } from '../services/workflowGraphNormalization.js';
import { getCustomIntegrationManifest } from '../services/integrationRegistry.js';
import { routeModelForTask } from '../services/modelRoutingPolicy.js';

export interface EngineDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  logger: Logger;
  ledger: LedgerService;
  scratchpad: ScratchpadService;
  activity: ActivityFeedService;
  approvals: ApprovalInboxService;
  extensions: ExtensionRuntime;
  adapters: AdapterManager;
  subflows?: SubflowExecutor;
  knowledgeBases?: KnowledgeBaseService;
  /** Conversation bridge â€” lets chat-started runs report terminal state back to the thread. */
  conversations?: ConversationStore;
  /** Integration connector registry â€” required for `integration` and `http_request` nodes. */
  connectors?: ConnectorRegistry;
  /** Registered MCP servers' tools, callable from an `mcp` node (masterplan 2.3). */
  mcpBridge?: McpBridgePort;
  /** Agentic App datastore access for the `data_query` / `data_mutate` nodes. */
  appData?: AppDataPort;
  /** Resolve the owning App id from the running workflow when a data node omits `appId`. */
  resolveAppIdForWorkflow?: (workspaceId: string, workflowId: string) => string | undefined;
  /** Workflow-scoped KV â€” required for `workflow_store` nodes. */
  workflowStore?: WorkflowStoreService;
  /** Workspace-scoped KV (Tier 3) â€” required for `workspace_store` nodes + `{{workspace.kv.*}}`. */
  workspaceStore?: WorkspaceStoreService;
  /** Dedicated LLM-as-judge runtime. Live agent adapters are used as a fallback. */
  evaluatorRuntime?: EvaluationRuntime;
  /**
   * Optional per-workspace evaluator resolution (OMNICHANNEL §4.4 model overrides).
   * When set, `evaluator`/`router` nodes honor a workspace's evaluation-role model;
   * falls back to `evaluatorRuntime`.
   */
  resolveEvaluatorRuntime?: (
    workspaceId: string,
    role: 'synthesis' | 'evaluation',
    hint?: { task?: string | null; purpose?: string | null; explicitModel?: string | null },
  ) => EvaluationRuntime | undefined;
  /**
   * LAYER 0 (immersive-realtime): mint a real, model-backed runtime for an agent
   * that has no explicitly configured adapter — so `agent_task` always runs on a
   * working brain (the workspace's default model) instead of a dead `offline`
   * http stub. Bound to the agent's id so its thoughts/tool-calls attribute
   * correctly. Returns undefined only when NO model is configured at all.
   */
  resolveAgentRuntime?: (workspaceId: string, agentId: string, task?: string | null, explicitModel?: string | null) => AgentAdapter | undefined;
  modelAssistedRuntimeEnabled?: (workspaceId: string) => boolean;
  /** Credential vault â€” required for `integration` nodes that need decrypted credentials. */
  vault?: CredentialVault;
  /** Workspace Intelligence - injects operator-authored workspace docs into agent prompts. */
  workspaceIntelligence?: WorkspaceIntelligenceService;
  /** Native Playwright runtime â€” required for `browser` nodes. */
  browserPool?: BrowserPool;
  /** Specialist agent library â€” resolves `agent_task.agentRole` â†’ agentId (Layer 2). */
  specialists?: SpecialistAgentService;
  specialistProfiles?: SpecialistProfileService;
  specialistRuntime?: SpecialistRuntimeService;
  /** Full per-run audit trail (Â§5.4). Best-effort; never blocks a run. */
  audit?: AuditTrailService;
  /** Self-improvement: analyzes failed runs for repeat patterns (Â§7.2). */
  instincts?: InstinctEngine;
  /** Role-scoped tool execution (Â§2.2.1) â€” consumed by the agentic tool-use loop. */
  agentTools?: AgentToolRuntime;
  /** Agent-scoped personal memory (Â§G11) â€” injected into each dispatched agent's preamble. */
  agentMemory?: AgentMemoryService;
  /** Operator-owned notes shared with an agent only after an explicit grant. */
  personalBrain?: PersonalBrainService;
  /** Records deterministic failure lessons into the responsible agent's memory. */
  failureReflection?: FailureReflectionService;
  /** Phase 4 — queued, grounded Feynman repair loop for stubborn failures. */
  feynmanReflection?: FeynmanReflectionService;
  /** Behavioral specialization units â€” semantically scored + injected into agent prompts. */
  abilities?: AbilityService;
  /** Phase 3 â€” specialist ability loadouts (required/preferred/forbidden by role). */
  loadouts?: SpecialistLoadoutService;
  /** Phase 2 - specialist-specific mind context (sources, atoms, visual patterns). */
  specialistMind?: SpecialistMindService;
  /** Resolves the workspace's embedding provider for ability-relevance scoring. */
  abilityEmbeddings?: (workspaceId: string) => EmbeddingProvider;
  /** ABILITIES-10X — composes/reconciles the ability stack + prefix-cache ordering. */
  abilityComposer?: AbilityComposer;
  /** Canonical shared brain graph retrieval and evaluator feedback. */
  sharedIntelligence?: SharedIntelligenceService;
  /**
   * Real accumulated spend for a run AND its descendant subflow runs — recorded
   * cost (cents) + model tokens. Drives the `converge` node's budget breaker
   * (AGENT-COOPERATION-10X §Pillar 1). Absent → only ms + the ceiling enforce.
   */
  resolveRunSpend?: (rootRunId: string) => { costCents: number; tokens: number };
  /** Autonomous, intent-preserving workflow self-healing (AGENT-AUTONOMY §W7/W5.0). */
  selfHeal?: WorkflowSelfHealService;
  /**
   * The full agent tool registry (the same surface chat uses) — build/create
   * extensions, abilities, agents, workflows. Drives the self-heal deep replan so
   * the orchestrator has FULL creation power, not just read-only discovery.
   */
  toolRegistry?: AgentisToolRegistry;
  /** Durable promotion queue for successful workflow outputs. */
  brainQueue?: CognitivePromotionQueueWorker;
  /** User/agent peer-card context learned from chat and sessions. */
  peerProfiles?: PeerProfileService;
  /** Persistent agent-session store â€” required for `agent_session`/`planner`/`dynamic_swarm` nodes + `agent_task.useSession`. */
  sessions?: AgentSessionService;
  /** The session cognitive loop (THINKâ†’EXECUTEâ†’DECIDE) â€” paired with `sessions`. */
  sessionRuntime?: AgentSessionRuntime;
  /** Durable task spine above conversations/runs; executors only report into it. */
  plans?: PlanService;
  /**
   * Scored, explainable specialist selection (SPECIALISTS-10X §Demand Router).
   * When an `agent_task` is underspecified (no explicit agent and only a generic
   * role), the engine consults the router so selection is scored + recorded
   * instead of a bare `specialist` fallback. Narrow port over
   * `SpecialistDemandRouter` to keep the engine decoupled.
   */
  specialistRouter?: SpecialistRouterPort;
  /**
   * Per-task filesystem isolation for parallel agents. When present, the engine
   * allocates an isolated working directory for each swarm subtask so concurrent
   * agents never share one checkout. Absent = no isolation (single-agent default
   * behavior; subtasks fall back to the adapter's configured cwd).
   */
  worktrees?: WorktreeManager;
  /** Optional tracer; defaults to a no-op so tests stay free of OTel deps. */
  telemetry?: Telemetry;
}

/**
 * Narrow structural port over `SpecialistDemandRouter.request` so the engine can
 * consult it for scored role selection without importing the concrete service.
 */
/** Narrow port over McpToolBridge.call so the engine stays decoupled from it. */
export interface McpBridgePort {
  call(workspaceId: string, toolId: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

/** Narrow port over AppDatastore for the `data_query` / `data_mutate` nodes. */
export interface AppDataPort {
  query(workspaceId: string, appId: string, collection: string, q: { filter?: Record<string, unknown>; sort?: Array<{ field: string; dir: 'asc' | 'desc' }>; limit?: number; cursor?: string }): { rows: unknown[]; nextCursor?: string };
  aggregate(workspaceId: string, appId: string, collection: string, input: { op: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; groupBy?: string; filter?: Record<string, unknown>; limit?: number }): Array<{ group: string | number | null; value: number }>;
  insert(workspaceId: string, appId: string, collection: string, record: Record<string, unknown>): { id: string };
  update(workspaceId: string, appId: string, collection: string, id: string, patch: Record<string, unknown>): { id: string };
  upsert(workspaceId: string, appId: string, collection: string, match: Record<string, unknown>, record: Record<string, unknown>): { id: string };
  delete(workspaceId: string, appId: string, collection: string, id: string): void;
}

export interface SpecialistRouterPort {
  request(
    workspaceId: string,
    userId: string,
    input: {
      task: string;
      callerAgentId?: string | null;
      workflowId?: string | null;
      runId?: string | null;
      materialize?: boolean;
      createRun?: boolean;
    },
  ): Promise<{
    selectedRole: string;
    selectedAgentId: string | null;
    explanation: string;
    traceId: string;
    topology: string;
    score: number;
  }>;
}

type SelfHealEngineResult =
  | { kind: 'output_fixed'; output: Record<string, unknown> }
  | { kind: 'structural_applied' }
  | { kind: 'awaiting_approval' }
  | { kind: 'none'; reason?: string; diagnosis?: string };

export interface StartRunArgs {
  workspaceId: string;
  ambientId: string | null;
  conversationId?: string | null;
  workflowId: string;
  planId?: string | null;
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
  /**
   * LAYER 1 (immersive-realtime): a capped, in-memory replayable activity tail per
   * run — every node step, agent thought, tool call, and status change as a
   * RealtimeEnvelope. Lets a surface opened mid-run BACK-FILL recent history via
   * `getRunActivity(runId)` (GET /v1/runs/:id/activity) and then stream live, so it
   * never shows "EVENTS 0". Dropped when the run leaves memory.
   */
  readonly #runActivity = new Map<string, RunActivityEnvelope[]>();
  readonly #telemetry: Telemetry;
  /** Decomposition seam (NATIVE-ADVANCEMENT Proposal 4): pure node kinds resolve here, not in the dispatch switch. */
  readonly #nodeHandlers = new NodeHandlerRegistry();

  constructor(private readonly deps: EngineDeps) {
    this.#telemetry = deps.telemetry ?? noopTelemetry;
    registerPureNodeHandlers(this.#nodeHandlers);
    registerUtilityNodeHandlers(this.#nodeHandlers);
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Public API
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async startRun(args: StartRunArgs): Promise<RunHandle> {
    const normalized = normalizeWorkflowGraph(this.deps.db, args.workspaceId, args.graph);
    const graph = normalized.graph;
    if (normalized.repairs.length > 0) {
      this.deps.logger.info('engine.graph.normalized', {
        runId: args.initialState.runId,
        workflowId: args.workflowId,
        repairs: normalized.repairs,
      });
    }
    validateWorkflowGraph(graph, { currentWorkflowId: args.workflowId });
    const ctx: RunningContext = {
      runId: args.initialState.runId,
      workflowId: args.workflowId,
      planId: args.planId ?? null,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      conversationId: args.conversationId ?? null,
      userId: args.userId,
      graph,
      downstreamEdges: buildDownstreamEdges(graph),
      state: args.initialState,
      eventsSinceSnapshot: 0,
      inflightDispatches: 0,
      swarms: new Map(),
      selfHealAttempts: hydrateSelfHealAttempts(args.initialState),
      abortController: new AbortController(),
    };
    this.#runs.set(ctx.runId, ctx);
    if (ctx.planId && this.deps.plans) {
      this.deps.plans.bindRun(ctx.workspaceId, ctx.userId, ctx.planId, ctx.runId);
    }
    await this.deps.db
      .update(schema.workflowRuns)
      .set({
        graphSnapshot: graph as unknown as object,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workflowRuns.id, ctx.runId));

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

    // Kick the dispatch loop. Don't await â€” runs are async.
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
   *   - NON-RECOVERABLE: a run with an in-flight agent / extension / http /
   *     integration / subflow / evaluator execution. We can't know whether
   *     that external work completed, so re-dispatching risks double
   *     side-effects. These are failed loud with a clear reason.
   *
   * Returns a summary so bootstrap can log it.
   */
  async recoverInterruptedRuns(): Promise<{ resumed: number; failed: number }> {
    // A session parked on `request_approval` persists BOTH an approval row
    // (source 'checkpoint') and a waiting agent_session whose wakeCondition is
    // `approval:*`. Those resume through the session-recovery pass (kind
    // 'session'), not the checkpoint pass — collect their (run,node) keys so the
    // checkpoint pass skips them and doesn't mis-register them as plain gates.
    const sessionApprovalKeys = new Set<string>();
    if (this.deps.sessions) {
      for (const s of this.deps.sessions.listWaiting()) {
        if (s.runId && s.nodeId && (s.wakeCondition ?? '').startsWith('approval:')) {
          sessionApprovalKeys.add(`${s.runId}::${s.nodeId}`);
        }
      }
    }
    const isSessionApproval = (runId: string, approval: { targetId: string | null }): boolean =>
      Boolean(approval.targetId) && sessionApprovalKeys.has(`${runId}::${approval.targetId}`);
    const isGateApproval = (runId: string, approval: { source: string; targetId: string | null }): boolean =>
      (approval.source === 'checkpoint' || approval.source === 'phase_gate' || approval.source === 'self_heal') && !isSessionApproval(runId, approval);

    const running = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.status, 'RUNNING'))
      .all();
    const waitingForApproval = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.status, 'WAITING'))
      .all()
      .filter((run) => this.deps.db
        .select()
        .from(schema.approvalRequests)
        .where(and(eq(schema.approvalRequests.runId, run.id), eq(schema.approvalRequests.status, 'pending')))
        .all()
        .some((approval) => isGateApproval(run.id, approval)));
    let resumed = 0;
    let failed = 0;
    for (const run of [...running, ...waitingForApproval]) {
      const state = run.runState as unknown as WorkflowRunState | null;
      const activeExecs = state?.activeExecutions ? Object.values(state.activeExecutions) : [];
      const approvalRows = this.deps.db
        .select()
        .from(schema.approvalRequests)
        .where(and(eq(schema.approvalRequests.runId, run.id), eq(schema.approvalRequests.status, 'pending')))
        .all()
        .filter((approval) => isGateApproval(run.id, approval));
      if (activeExecs.length === 0 && approvalRows.length > 0 && run.workflowId && state) {
        try {
          const graph = this.#loadWorkflowGraph(run.workflowId);
          const ctx: RunningContext = {
            runId: run.id,
            workflowId: run.workflowId,
            planId: this.deps.plans?.findByRun(run.workspaceId, run.id)?.id ?? null,
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
            selfHealAttempts: hydrateSelfHealAttempts(state),
          };
          for (const approval of approvalRows) {
            if (!approval.targetId) {
              throw new Error(`approval ${approval.id} is missing its resume target`);
            }
            const kind = approval.source === 'phase_gate' ? 'phase_gate' : approval.source === 'self_heal' ? 'self_heal' : 'checkpoint';
            if (kind === 'self_heal') {
              const payload = approval.payload as Record<string, unknown> | null;
              if (payload?.kind === 'retry_with_repair_context') {
                this.#pendingApprovals(ctx).set(approval.id, {
                  kind,
                  targetId: approval.targetId,
                  healAction: 'retry_with_repair_context',
                  retryError: typeof payload.error === 'string' ? payload.error : 'Previous attempt failed.',
                  retryDiagnosis: typeof payload.diagnosis === 'string' ? payload.diagnosis : 'Retry requested by self-healing.',
                  retryAttempt: typeof payload.attempt === 'number' ? payload.attempt : 1,
                  retryMaxAttempts: typeof payload.maxAttempts === 'number' ? payload.maxAttempts : 1,
                });
              } else {
                const healPatch = selfHealPatchFromPayload(approval.payload);
                if (!healPatch) throw new Error(`self-heal approval ${approval.id} is missing its durable patch`);
                this.#pendingApprovals(ctx).set(approval.id, { kind, targetId: approval.targetId, healAction: 'graph_patch', healPatch });
              }
            } else {
              this.#pendingApprovals(ctx).set(approval.id, { kind, targetId: approval.targetId });
            }
            if (kind === 'phase_gate') {
              const phase = graph.phases?.find((item) => item.id === approval.targetId);
              const held = (phase?.nodeIds ?? [])
                .filter((nodeId) => state.nodeStates[nodeId]?.status === 'WAITING')
                .map((nodeId) => ({
                  nodeId,
                  priority: 0,
                  insertedAt: new Date().toISOString(),
                  inputData: state.nodeStates[nodeId]?.inputData ?? {},
                }));
              if (!phase || held.length === 0) {
                throw new Error(`phase gate ${approval.targetId} has no persisted held node`);
              }
              this.#phaseRuntime(ctx).set(phase.id, {
                started: false,
                startedAt: 0,
                cost: 0,
                slaBreached: false,
                gateState: 'pending',
                held,
              });
            }
          }
          this.#runs.set(ctx.runId, ctx);
          this.deps.logger.info('engine.run_approval_resumed', { runId: run.id, approvals: approvalRows.length });
          resumed += 1;
          continue;
        } catch (err) {
          this.deps.logger.warn('engine.run_approval_resume_failed', { runId: run.id, err: (err as Error).message });
        }
      }
      if (!run.workflowId || !state) {
        // Truly unrecoverable (no graph or no persisted state) â€” fail loud.
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
          planId: this.deps.plans?.findByRun(run.workspaceId, run.id)?.id ?? null,
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
          selfHealAttempts: hydrateSelfHealAttempts(state),
        };
        this.#runs.set(ctx.runId, ctx);
        // AEJ crash recovery (NATIVE-ADVANCEMENT Proposal 1):
        //  - `wait` executions re-arm their timer for the remaining delay.
        //  - every OTHER in-flight execution (agent / integration / http /
        //    subflow / extension / …) had an UNKNOWN outcome at crash time.
        //    Rather than failing the whole run (the old "fail loud"), we
        //    RE-DISPATCH it so the run survives the restart. Each carries a
        //    stable idempotency key (runId+nodeId), journaled to the ledger, so
        //    dedup-capable handlers/connectors make the retry effectively once.
        //    (Effectively-once still requires downstream dedup support — the
        //    standard durable-execution caveat — but resuming beats a dead run.)
        let redispatched = 0;
        for (const exec of activeExecs) {
          const inputData = ((exec as unknown as { inputData?: Record<string, unknown> }).inputData)
            ?? ctx.state.nodeStates[exec.nodeId]?.inputData
            ?? {};
          if (exec.executorType === 'wait') {
            const wakeAt = (exec as unknown as { wakeAt?: string }).wakeAt;
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
          } else if (exec.executorType === 'subflow' && this.deps.subflows) {
            // Durable delegation (1.4): a subflow parent must NOT be re-dispatched
            // (that would spawn a *second* child run and orphan the first). Instead
            // re-bind to the child run that survived in the DB; if that child already
            // finished during downtime, resume the parent immediately.
            this.#recoverSubflowParent(ctx, exec);
          } else {
            const idempotencyKey = nodeIdempotencyKey(ctx.runId, exec.nodeId, 0);
            delete ctx.state.activeExecutions[exec.nodeId];
            const ns = ctx.state.nodeStates[exec.nodeId];
            if (ns) ns.status = 'PENDING';
            ctx.state.readyQueue.push({
              nodeId: exec.nodeId,
              priority: 0,
              insertedAt: new Date().toISOString(),
              inputData,
              idempotencyKey,
            });
            void this.deps.ledger.append({
              workspaceId: ctx.workspaceId,
              ambientId: ctx.ambientId,
              runId: ctx.runId,
              eventType: 'node.redispatched',
              nodeId: exec.nodeId,
              payload: { idempotencyKey, reason: 'crash_recovery' },
            });
            redispatched += 1;
          }
        }
        if (redispatched > 0) queueMicrotask(() => void this.#tick(ctx));
        this.deps.logger.info('engine.run_resumed', {
          runId: run.id,
          waits: activeExecs.length - redispatched,
          redispatched,
        });
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
    // SMARTER-AGENTS-10X durability: re-arm parked agent sessions (await_event /
    // sleep_until / request_approval) so a process restart resumes them instead
    // of leaving the run WAITING forever. Runs to handle: any WAITING run with a
    // parked session — including those whose ONLY in-flight work is a session
    // yield (no approval, no active exec), which the passes above never see.
    try {
      const sessionRecovery = await this.#recoverParkedSessions();
      if (sessionRecovery.recovered > 0) {
        this.deps.logger.info('engine.parked_sessions_recovered', { count: sessionRecovery.recovered });
      }
    } catch (err) {
      this.deps.logger.warn('engine.parked_session_recovery_failed', { err: (err as Error).message });
    }
    return { resumed, failed };
  }

  /**
   * Rehydrate and re-arm every parked agent session so suspensions survive a
   * restart. For each waiting session it rebuilds the run context (reusing an
   * already-recovered run when present), then re-registers the wake hook by kind:
   *   - `event:NAME`   → run-event waiter (resumes via notifySessionEvent)
   *   - `time:ISO`     → timer (fires immediately if the deadline already passed)
   *   - `approval:TID` → pending-approval link (resumes when the human decides)
   * Delegation parks never persist (resolved inline), so they never appear here.
   */
  async #recoverParkedSessions(): Promise<{ recovered: number }> {
    if (!this.deps.sessions || !this.deps.sessionRuntime) return { recovered: 0 };
    const waiting = this.deps.sessions.listWaiting();
    if (waiting.length === 0) return { recovered: 0 };
    const byRun = new Map<string, typeof waiting>();
    for (const s of waiting) {
      if (!s.runId || !s.nodeId) continue;
      const list = byRun.get(s.runId) ?? [];
      list.push(s);
      byRun.set(s.runId, list);
    }
    let recovered = 0;
    for (const [runId, sessions] of byRun) {
      const ctx = this.#ensureRecoveredCtx(runId);
      if (!ctx) continue;
      for (const session of sessions) {
        const node = ctx.graph.nodes.find((n) => n.id === session.nodeId);
        const cond = session.wakeCondition ?? '';
        if (!node || !cond) continue;
        const toolCallId = typeof session.suspendPayload?.toolCallId === 'string'
          ? session.suspendPayload.toolCallId
          : '';
        const runCtx = await this.#rebuildSessionRunCtx(ctx, session.agentId, node);
        if (cond.startsWith('event:')) {
          const event = cond.slice('event:'.length);
          const list = this.#sessionWaiters(ctx).get(event) ?? [];
          list.push({ sessionId: session.id, nodeId: node.id, toolCallId, runCtx });
          this.#sessionWaiters(ctx).set(event, list);
          recovered += 1;
        } else if (cond.startsWith('time:')) {
          const untilIso = cond.slice('time:'.length);
          const remaining = Math.max(0, Date.parse(untilIso) - Date.now());
          const fire = () => void this.#wakeSession(ctx, node, session.id, runCtx, toolCallId, { sleptUntil: untilIso });
          if (remaining <= 0) queueMicrotask(fire);
          else { const timer = setTimeout(fire, remaining); timer.unref?.(); }
          recovered += 1;
        } else if (cond.startsWith('approval:')) {
          const approval = this.deps.db
            .select()
            .from(schema.approvalRequests)
            .where(and(
              eq(schema.approvalRequests.runId, runId),
              eq(schema.approvalRequests.targetId, node.id),
              eq(schema.approvalRequests.status, 'pending'),
            ))
            .all()[0];
          if (approval) {
            this.#pendingApprovals(ctx).set(approval.id, { kind: 'session', targetId: node.id, sessionId: session.id, toolCallId, runCtx });
            recovered += 1;
          }
        }
      }
    }
    return { recovered };
  }

  /**
   * Durable delegation (masterplan 1.4): re-attach a subflow parent node to the
   * child run that outlived a restart. The child persists its own run row keyed
   * by `parentRunId`; the parent node's id is recovered from its own persisted
   * `activeExecutions` entry. We rebind the resume/fail callbacks over the
   * rehydrated parent context, then:
   *   - child already terminal (finished during downtime) → resume/fail now;
   *   - child still in-flight → leave the parent RUNNING; its eventual terminal
   *     transition finds the freshly-rebound pending and resumes the parent.
   * If no child row exists at all (the start never persisted), we fall back to a
   * plain re-dispatch so the run can't hang.
   */
  #recoverSubflowParent(ctx: RunningContext, exec: { nodeId: string; executorRef?: string }): void {
    const subflows = this.deps.subflows;
    if (!subflows) return;
    const parentNodeId = exec.nodeId;
    const childWorkflowId = exec.executorRef;
    // Find the child run this parent node spawned. (parentRunId + child workflow
    // id is the durable link; pick the most recent if a workflow is reused.)
    const candidates = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.parentRunId, ctx.runId))
      .all()
      .filter((row) => !childWorkflowId || row.workflowId === childWorkflowId)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    const child = candidates[0];
    if (!child) {
      // The child was never persisted — re-dispatch the node so the run survives.
      delete ctx.state.activeExecutions[parentNodeId];
      const ns = ctx.state.nodeStates[parentNodeId];
      if (ns) ns.status = 'PENDING';
      ctx.state.readyQueue.push({
        nodeId: parentNodeId,
        priority: 0,
        insertedAt: new Date().toISOString(),
        inputData: ns?.inputData ?? {},
        idempotencyKey: nodeIdempotencyKey(ctx.runId, parentNodeId, 0),
      });
      queueMicrotask(() => void this.#tick(ctx));
      return;
    }

    if (!subflows.hasPending(ctx.runId, parentNodeId)) {
      subflows.rebind({
        parentRunId: ctx.runId,
        parentNodeId,
        childRunId: child.id,
        resumeParent: async (output) => {
          await this.#completeNode(ctx, parentNodeId, output);
          void this.#tick(ctx);
        },
        failParent: async (msg) => {
          await this.#failNode(ctx, parentNodeId, msg);
          void this.#tick(ctx);
        },
      });
    }

    const terminal = child.status === 'COMPLETED' || child.status === 'FAILED' || child.status === 'CANCELLED';
    if (terminal) {
      // The child finished while we were down — drive the parent resume now,
      // since the child's terminal transition already fired (and found no binding).
      const childState = child.runState as unknown as WorkflowRunState | null;
      const finalNodeId = childState?.completedNodeIds?.at(-1);
      const finalOutput = (finalNodeId && childState?.nodeStates?.[finalNodeId]?.outputData) || {};
      void subflows.onChildRunFinished({
        childRunId: child.id,
        parentRunId: ctx.runId,
        parentNodeId,
        status: child.status as 'COMPLETED' | 'FAILED' | 'CANCELLED',
        finalOutput: finalOutput as Record<string, unknown>,
        workspaceId: child.workspaceId,
        ambientId: child.ambientId,
        ...(child.status !== 'COMPLETED' ? { error: `child run ${child.id} ${child.status}` } : {}),
      });
    }
    // else: parent stays RUNNING; the in-flight child (recovered as its own run)
    // will notify on its terminal transition via the rebound pending.
  }

  /** Get a live run ctx, rehydrating it from DB when not already in memory. */
  #ensureRecoveredCtx(runId: string): RunningContext | null {
    const existing = this.#runs.get(runId);
    if (existing) return existing;
    const run = this.deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    const state = run?.runState as unknown as WorkflowRunState | null;
    if (!run || run.status !== 'WAITING' || !run.workflowId || !state) return null;
    try {
      const graph = this.#loadWorkflowGraph(run.workflowId);
      const ctx: RunningContext = {
        runId: run.id,
        workflowId: run.workflowId,
        planId: this.deps.plans?.findByRun(run.workspaceId, run.id)?.id ?? null,
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
        selfHealAttempts: hydrateSelfHealAttempts(state),
      };
      this.#runs.set(ctx.runId, ctx);
      return ctx;
    } catch (err) {
      this.deps.logger.warn('engine.session_run_rehydrate_failed', { runId, err: (err as Error).message });
      return null;
    }
  }

  /** Rebuild a session run-context for wake (workspace/brain addendum + role). */
  async #rebuildSessionRunCtx(ctx: RunningContext, agentId: string, node: WorkflowNode): Promise<SessionRunContext> {
    const cfg = node.config as { agentRole?: AgentRole };
    const role = cfg.agentRole && isAgentRole(cfg.agentRole) ? cfg.agentRole : undefined;
    let runContextBlock = '';
    try {
      runContextBlock = (await this.#withWorkspaceContext(ctx, '', undefined, '', agentId)).prompt;
    } catch {
      runContextBlock = '';
    }
    return {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: ctx.runId,
      nodeId: node.id,
      agentId,
      workflowId: ctx.workflowId,
      planId: ctx.planId,
      ...(role ? { role } : {}),
      runContextBlock,
    };
  }

  /**
   * Dry-run a single node in isolation.
   *
   * Builds an ephemeral RunningContext that does NOT persist to the database
   * or fire ledger events, dispatches the node's handler against the provided
   * inputs, and returns either the output or a structured error. The node's
   * own side-effects (HTTP calls, integration writes, agent dispatches) still
   * happen â€” this is "run this one node now" with real credentials, not a mock.
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
    const graph = normalizeWorkflowGraph(this.deps.db, args.workspaceId, wf.graph as unknown as WorkflowGraph).graph;
    const node = graph.nodes.find((n) => n.id === args.nodeId);
    if (!node) {
      return { ok: false, error: `node ${args.nodeId} not found in workflow`, code: 'RESOURCE_NOT_FOUND', durationMs: Date.now() - startedAt };
    }
    // Async node kinds (agent_task, subflow, agent_swarm, checkpoint) cannot
    // be dry-run synchronously through #dispatchNode without setting up the
    // full callback machinery. Reject them explicitly so the UI can surface
    // a friendly message instead of hanging.
    const asyncKinds: ReadonlyArray<string> = ['agent_task', 'agent_swarm', 'subflow', 'checkpoint', 'loop', 'converge', 'agent_session', 'dynamic_swarm', 'planner'];
    if (asyncKinds.includes(node.config.kind)) {
      return {
        ok: false,
        error: `'${node.config.kind}' is async â€” test it via a real run`,
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
      planId: null,
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
      selfHealAttempts: hydrateSelfHealAttempts(initialState),
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
        case 'extension_task':
          output = await this.#executeExtensionTask(ctx, node, resolvedConfig as ExtensionTaskNodeConfig, args.inputs);
          break;
        case 'knowledge':
          output = await this.#executeKnowledgeNode(ctx, resolvedConfig as KnowledgeNodeConfig, args.inputs);
          break;
        case 'knowledge_ingest':
          output = await this.#executeKnowledgeIngestNode(ctx, resolvedConfig as KnowledgeIngestNodeConfig, args.inputs);
          break;
        case 'artifact_collect':
          output = await this.#executeArtifactCollect(ctx, node, resolvedConfig as ArtifactCollectNodeConfig, args.inputs);
          break;
        case 'wait':
          // No-op for tests â€” return inputs immediately.
          output = args.inputs;
          break;
        case 'transform':
        case 'filter':
          // Pure kinds resolve through the handler registry (Proposal 4).
          output = this.#nodeHandlers.get(node.config.kind)!.execute(node.config, { inputData: args.inputs, tctx });
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
        case 'code':
          output = await this.#executeCode(ctx, node, resolvedConfig as CodeNodeConfig, args.inputs);
          break;
        case 'spreadsheet':
          output = await this.#executeSpreadsheet(node, resolvedConfig as SpreadsheetNodeConfig, args.inputs);
          break;
        case 'graphql':
          output = await this.#executeGraphQl(ctx, node, resolvedConfig as GraphQlNodeConfig);
          break;
        case 'stop_error': {
          const cfg = resolvedConfig as StopErrorNodeConfig;
          return { ok: false, error: cfg.errorMessage || 'Workflow stopped by stop_error node', code: 'WORKFLOW_STOPPED', durationMs: Date.now() - startedAt };
        }
        case 'error_trigger':
          output = args.inputs;
          break;
        default: {
          // Pure utility kinds (datetime, crypto_util, xml_parse, markdown,
          // json_schema_validate, html_extract, sticky_note) resolve through the
          // handler registry — same path the live dispatch uses.
          const pure = this.#nodeHandlers.get(node.config.kind);
          if (pure) {
            output = pure.execute(node.config, { inputData: args.inputs, tctx });
            break;
          }
          return { ok: false, error: `node kind '${node.config.kind}' is not testable in isolation`, code: 'VALIDATION_FAILED', durationMs: Date.now() - startedAt };
        }
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
    // Stop in-flight work that honors the run signal (e.g. outbound HTTP, agent
    // model calls) rather than letting it run to completion after cancellation
    // (NATIVE-ADVANCEMENT Proposal 7, Agentis-native run-scoped cancellation).
    await this.#interruptActiveWork(ctx);
    // Don't leave the active node stuck "running": mark open nodes skipped so the
    // UI reflects a stopped run, not a frozen one (same as the persisted path).
    markOpenNodesSkipped(ctx.state, 'Run cancelled');
    await this.#transitionRunStatus(ctx, 'CANCELLED');
    this.#disposeRunState(runId);
  }

  /**
   * Pause is deliberately different from cancel: preserve the unfinished
   * frontier as WAITING work so the exact nodes can be resumed later.
   */
  async pauseRun(runId: string): Promise<void> {
    const ctx = this.#runs.get(runId);
    if (!ctx) {
      await this.#pausePersistedRun(runId);
      return;
    }
    await this.#interruptActiveWork(ctx);
    for (const nodeId of Object.keys(ctx.state.activeExecutions)) {
      const node = ctx.state.nodeStates[nodeId];
      if (node?.status === 'RUNNING') {
        node.status = 'WAITING';
        node.blockedReason = 'Paused by operator';
      }
      delete ctx.state.activeExecutions[nodeId];
    }
    await this.#transitionRunStatus(ctx, 'PAUSED');
  }

  /** Never let a non-cooperative adapter make the operator wait forever. */
  async #interruptActiveWork(ctx: RunningContext): Promise<void> {
    try { ctx.abortController?.abort(); } catch { /* best-effort */ }
    await Promise.all(Object.values(ctx.state.activeExecutions).map(async (exec) => {
      if (!exec?.taskId || exec.executorType !== 'agent' || !exec.executorRef) return;
      await Promise.race([
        this.deps.adapters.cancelTask(exec.executorRef, exec.taskId).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    }));
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
    if (ctx.state.status === 'PAUSED' || isTerminalRunStatus(ctx.state.status)) return;
    const swarm = parseSwarmTaskId(args.nodeId);
    if (swarm) {
      await this.#onSwarmSubtask(ctx, swarm.nodeId, swarm.index, args.output, null);
      return;
    }
    const active = ctx.state.activeExecutions[args.nodeId];
    const node = ctx.graph.nodes.find((candidate) => candidate.id === args.nodeId);
    const agentId = active?.executorType === 'agent'
      ? active.executorRef
      : node?.config.kind === 'agent_task'
        ? node.config.agentId
        : undefined;
    let output: Record<string, unknown>;
    try {
      output = node ? normalizeDeclaredNodeOutput(node, args.output) : args.output;
    } catch (err) {
      // W5.0/W7 — a declared-output miss must not be a dead run. Recover the key(s)
      // from the agent's OWN output, or apply/queue a structural repair, before
      // failing. Only `output_fixed` continues inline; structural outcomes
      // re-dispatch or pause the node themselves.
      const heal = node ? await this.#runSelfHeal(ctx, node, args.output, (err as Error).message) : { kind: 'none' as const };
      if (heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval') return;
      if (heal.kind !== 'output_fixed') {
        await this.#failNode(ctx, args.nodeId, selfHealFailureMessage((err as Error).message, heal));
        void this.#tick(ctx);
        return;
      }
      output = heal.output;
    }
    try {
      const completedOutput = await this.#completeNode(ctx, args.nodeId, output);
      if (!completedOutput) {
        void this.#tick(ctx);
        return;
      }
      output = completedOutput;
    } catch (err) {
      await this.#failNode(ctx, args.nodeId, (err as Error).message);
      void this.#tick(ctx);
      return;
    }
    this.#enqueueSuccessfulBrainCapture(ctx, args.nodeId, output, agentId ?? null);
    // CONVERSATION THEATER: the specialist reports its result back (dispatch path).
    if (agentId && node && node.config.kind === 'agent_task') {
      this.#recordSpecialistResult(ctx, node, agentId, output);
    }
    void this.#tick(ctx);
  }

  /**
   * W5.0 / W7 — autonomous, intent-preserving self-healing for a failed agent
   * node. Tries to recover the declared output from the agent's OWN output
   * (W5.0); otherwise diagnoses and (when certified + validated) applies a
   * STRUCTURAL graph repair — autonomously or via operator approval per the
   * workspace setting. Never fabricates; escalates on uncertainty.
   *
   *   output_fixed       → caller completes the node with `output`.
   *   structural_applied → patch applied + node re-dispatched; caller returns.
   *   awaiting_approval  → approval created + node WAITING; caller returns.
   *   none               → no safe heal; caller fails the node honestly.
   */
  async #runSelfHeal(
    ctx: RunningContext,
    node: WorkflowNode,
    rawOutput: Record<string, unknown>,
    error: string,
  ): Promise<SelfHealEngineResult> {
    if (!this.deps.selfHeal) return { kind: 'none' };
    if (!isSelfHealableNode(node)) return { kind: 'none' };
    let cfg;
    try { cfg = getSelfHealConfig(this.deps.db, ctx.workspaceId); } catch { return { kind: 'none' }; }
    if (!cfg.enabled) return { kind: 'none' };
    const attempts = selfHealAttemptCount(ctx, node.id);
    if (attempts >= cfg.maxRepairPlans) {
      return this.#blockSelfHeal(ctx, node, {
        mode: cfg.mode,
        attempt: attempts,
        maxAttempts: cfg.maxRepairPlans,
        error,
        reason: `Self-healing stopped after ${attempts}/${cfg.maxRepairPlans} distinct repair plans for this failure lineage.`,
        diagnosis: 'Attempt limit reached before a certified repair could be applied.',
        exhausted: true,
      });
    }
    this.#recordSelfHealIncident(ctx, node, {
      status: 'DIAGNOSING',
      mode: cfg.mode,
      attempt: attempts + 1,
      maxAttempts: cfg.maxRepairPlans,
      error,
    });
    this.#emitWorkStep(ctx, node, 'thinking', 'Checking deterministic recovery options');
    await this.#persistRun(ctx).catch(() => {});

    // ── STRATEGY 1 (deterministic, zero-token): runtime repair. The most common
    //    long-run failure is an agent whose runtime dropped or was never bound.
    //    Rebind it, or reroute the step to the configured healer (default: the
    //    orchestrator). Only when neither is possible do we spend tokens on LLM
    //    diagnosis / a structural patch.
    if (node.config.kind === 'agent_task' && isRuntimeBindingFailure(error)) {
      const runtimeRepair = await this.#repairNodeRuntime(ctx, node, error, cfg);
      if (runtimeRepair.kind !== 'none') return runtimeRepair;
    }

    const prompt = (node.config as { prompt?: string }).prompt ?? '';
    const completer = this.#resolveSelfHealCompleter(ctx, node, prompt, error, cfg);
    const intent: IntentAnchor = {
      goal: node.title || prompt || 'workflow node',
      nodeObjective: prompt || node.title || '',
      declaredOutputKeys: declaredOutputKeys(node),
      inputContract: ctx.graph.inputContract,
    };
    this.#recordSelfHealIncident(ctx, node, {
      status: 'PLANNING',
      mode: cfg.mode,
      attempt: attempts + 1,
      maxAttempts: cfg.maxRepairPlans,
      error,
      diagnosis: 'Orchestrator is repairing the workflow with the chat tool loop.',
    });
    await this.#persistRun(ctx).catch(() => {});
    try {
      const res = await this.deps.selfHeal.heal({
        workspaceId: ctx.workspaceId,
        graph: ctx.graph,
        node,
        error,
        rawOutput,
        upstreamOutputs: this.#upstreamOutputs(ctx, node.id),
        intent,
        completer,
        tier: recoveryTierForPlan(this.#repairPlansFor(ctx, node.id).length),
        immutableNodeIds: this.#immutableRecoveryNodeIds(ctx, node.id),
        resources: this.#availableRepairResources(ctx),
        // FULL POWER: the orchestrator runs through the chat executor first and
        // returns a candidate graph that still passes finalize/validate/certify.
        deepPlan: (args) => this.#orchestratorReplan(ctx, node, args),
        onProgress: (progress) => {
          const detail = progress.phase === 'stalled'
            ? 'Repair runtime stalled; falling back only to the configured route.'
            : progress.phase === 'started'
              ? 'Asking the selected repair runtime for a grounded plan'
              : progress.phase === 'thinking'
                ? 'Repair runtime is reasoning'
                : 'Repair runtime is responding';
          this.#emitWorkStep(ctx, node, 'thinking', detail);
        },
      });
      const attempt = recordSelfHealAttempt(ctx, node.id);
      await this.#persistRun(ctx).catch((persistErr) => {
        this.deps.logger.warn('engine.self_heal.attempt_persist_failed', {
          runId: ctx.runId,
          nodeId: node.id,
          error: (persistErr as Error).message,
        });
      });

      if (res.outcome === 'output_fixed') {
        this.#recordSelfHealIncident(ctx, node, {
          status: 'APPLIED',
          mode: cfg.mode,
          attempt,
          maxAttempts: cfg.maxRepairPlans,
          diagnosis: res.diagnosis,
          outcome: 'output_fixed',
        });
        this.deps.logger.info('engine.self_heal.output_fixed', { runId: ctx.runId, nodeId: node.id, attempt });
        this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, {
          runId: ctx.runId,
          nodeId: node.id,
          reason: 'self_heal_output_recovered',
          detail: res.diagnosis,
          attempt,
        });
        await this.deps.ledger.append({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
          runId: ctx.runId,
          eventType: 'self_heal.output_fixed',
          nodeId: node.id,
          payload: { diagnosis: res.diagnosis, attempt },
        }).catch(() => {});
        this.#audit(ctx, { nodeId: node.id, action: 'self_heal.output_fixed', actorType: 'system', actorId: 'engine', outputSummary: res.diagnosis });
        return { kind: 'output_fixed', output: res.output };
      }

      // Structural repair flows for ANY re-dispatchable node (agent_task,
      // evaluator, transform, integration, …): #applyHealAndRedispatch /
      // #proposeHealForApproval reset the node and re-run it through #dispatchNode,
      // which handles every node kind uniformly.
      if (res.outcome === 'graph_repair') {
        const patch = this.#buildHealPatch(ctx, res.patchedGraph, res.diagnosis);
        // Patch ids and graph revisions change on every apply; they must not
        // defeat duplicate detection for the same semantic repair.
        const fingerprint = repairPlanFingerprint({
          tier: res.tier,
          resumeNodeId: res.resumeNodeId,
          addNodes: patch.addNodes,
          updateNodes: patch.updateNodes,
          removeNodeIds: patch.removeNodeIds,
          addEdges: patch.addEdges,
          removeEdgeIds: patch.removeEdgeIds,
        });
        const priorPlans = this.#repairPlansFor(ctx, node.id);
        if (priorPlans.some((plan) => plan.fingerprint === fingerprint)) {
          return this.#blockSelfHeal(ctx, node, {
            mode: cfg.mode,
            attempt,
            maxAttempts: cfg.maxRepairPlans,
            error,
            reason: 'Self-healing rejected a duplicate repair plan instead of retrying the same change.',
            diagnosis: res.diagnosis,
          });
        }
        const runPlanCount = Object.values(ctx.state.selfHealIncidents ?? {}).reduce((total, incident) => total + (incident.plans?.length ?? 0), 0);
        if (runPlanCount >= Math.max(1, cfg.maxRepairPlans) * 2) {
          return this.#blockSelfHeal(ctx, node, {
            mode: cfg.mode,
            attempt,
            maxAttempts: cfg.maxRepairPlans,
            error,
            reason: 'Run-level self-healing circuit breaker reached; Agentis stopped instead of cycling between failures.',
            diagnosis: res.diagnosis,
          });
        }
        const policy = decideRecoveryPolicy(cfg.mode, ctx.graph, res.patchedGraph);
        const plan = this.#appendRepairPlan(ctx, node, {
          tier: res.tier,
          fingerprint,
          requiresApproval: policy.requiresApproval,
          patchId: patch.patchId,
          resumeNodeId: res.resumeNodeId,
          riskReason: policy.impact.reason,
          status: policy.requiresApproval ? 'awaiting_approval' : 'planned',
        });
        if (policy.requiresApproval) {
          const queued = await this.#proposeHealForApproval(ctx, node, patch, res.resumeNodeId, res.diagnosis, res.grounding, attempt, cfg.maxRepairPlans, policy.impact.reason, plan.id);
          return queued
            ? { kind: 'awaiting_approval' }
            : await this.#blockSelfHeal(ctx, node, {
                mode: cfg.mode,
                attempt,
                maxAttempts: cfg.maxRepairPlans,
                error,
                reason: 'Self-healing produced a guarded repair but could not create its confirmation request.',
                diagnosis: res.diagnosis,
              });
        }
        const applied = await this.#applyHealAndRedispatch(ctx, res.resumeNodeId, patch, plan.id);
        if (!applied) {
          return this.#blockSelfHeal(ctx, node, {
            mode: cfg.mode,
            attempt,
            maxAttempts: cfg.maxRepairPlans,
            error,
            reason: 'Self-healing certified a graph repair, but the repair could not be applied.',
            diagnosis: res.diagnosis,
          });
        }
        this.#completeRepairPlan(ctx, node, plan.id, 'applied');
        this.#recordSelfHealIncident(ctx, node, {
          status: 'APPLIED', mode: cfg.mode, attempt, maxAttempts: cfg.maxRepairPlans,
          tier: res.tier, diagnosis: res.diagnosis, reason: res.grounding,
          riskReason: policy.impact.reason, resumeNodeId: res.resumeNodeId, outcome: 'graph_patch_applied',
        });
        await this.deps.ledger.append({
          workspaceId: ctx.workspaceId, ambientId: ctx.ambientId, runId: ctx.runId,
          eventType: 'self_heal.graph_patched', nodeId: node.id,
          payload: { diagnosis: res.diagnosis, grounding: res.grounding, tier: res.tier, fingerprint, impact: policy.impact.impact },
        }).catch(() => {});
        this.#audit(ctx, { nodeId: node.id, action: 'self_heal.graph_patched', actorType: 'system', actorId: 'engine', outputSummary: res.diagnosis });
        return { kind: 'structural_applied' };
      }

      if (res.outcome === 'escalate') {
        this.deps.logger.info('engine.self_heal.escalate', { runId: ctx.runId, nodeId: node.id, reason: res.reason, attempt });
        await this.deps.ledger.append({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
          runId: ctx.runId,
          eventType: 'self_heal.escalated',
          nodeId: node.id,
          payload: { reason: res.reason, diagnosis: res.diagnosis, attempt },
        }).catch(() => {});
        this.#audit(ctx, { nodeId: node.id, action: 'self_heal.escalated', actorType: 'system', actorId: 'engine', outputSummary: `${res.reason}: ${res.diagnosis}` });
        // The orchestrator (the primary repair, inside heal()) already had its full
        // tool-loop turn. If it couldn't ground a safe fix, blindly re-running the
        // same step just burns minutes (the real failure log showed exactly that).
        // Stop honestly and offer the operator the "send to Agentis team" path.
        return this.#blockSelfHeal(ctx, node, {
          mode: cfg.mode,
          attempt,
          maxAttempts: cfg.maxRepairPlans,
          error,
          reason: res.reason,
          diagnosis: res.diagnosis,
        });
      }
      return { kind: 'none' };
    } catch (err) {
      const message = (err as Error).message;
      this.deps.logger.warn('engine.self_heal.failed', { runId: ctx.runId, nodeId: node.id, error: message });
      await this.deps.ledger.append({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        runId: ctx.runId,
        eventType: 'self_heal.failed',
        nodeId: node.id,
        payload: { error: message },
      }).catch(() => {});
      return this.#blockSelfHeal(ctx, node, {
        mode: cfg.mode,
        attempt: selfHealAttemptCount(ctx, node.id),
        maxAttempts: cfg.maxRepairPlans,
        error,
        reason: `Self-healing failed before it could produce a certified repair: ${message}`,
      });
    }
  }

  /**
   * STRATEGY 1 — deterministic runtime repair (zero LLM tokens). Handles the most
   * common long-run failure: a step whose agent has no connected runtime. First
   * rebind the step's own agent (no intent change at all, always safe → applied
   * regardless of mode). If that can't be done, reroute the step to the healer
   * (configured agent, else the orchestrator) — an intent-preserving change of
   * executor that honours the structural mode (autonomous applies, approve asks).
   * Returns `{ kind: 'none' }` when no runtime repair is possible, so the caller
   * falls through to LLM diagnosis / honest escalation.
   */
  async #repairNodeRuntime(
    ctx: RunningContext,
    node: WorkflowNode,
    error: string,
    cfg: SelfHealConfig,
  ): Promise<SelfHealEngineResult> {
    if (node.config.kind !== 'agent_task') return { kind: 'none' };
    const config = node.config;
    const pinnedId = config.agentId ?? null;

    // 1) Rebind the step's own agent runtime — the least invasive repair.
    if (pinnedId && this.#tryBindAgentRuntime(ctx, pinnedId, config.prompt, stringValue(config.modelOverride) ?? this.#agentConfiguredModel(pinnedId))) {
      const attempt = recordSelfHealAttempt(ctx, node.id);
      await this.#persistRun(ctx).catch(() => {});
      const diagnosis = `Reconnected the runtime for "${this.#agentDisplayName(pinnedId)}" and re-ran the step.`;
      const ok = await this.#redispatchNodeFresh(ctx, node.id, 'self_heal_runtime_rebound');
      if (ok) {
        this.#recordSelfHealIncident(ctx, node, {
          status: 'APPLIED', mode: cfg.mode, attempt, maxAttempts: cfg.maxRepairPlans,
          diagnosis, outcome: 'runtime_rebound',
        });
        await this.#persistRun(ctx).catch(() => {});
        await this.deps.ledger.append({
          workspaceId: ctx.workspaceId, ambientId: ctx.ambientId, runId: ctx.runId,
          eventType: 'self_heal.runtime_rebound', nodeId: node.id, payload: { agentId: pinnedId, attempt },
        }).catch(() => {});
        this.#audit(ctx, { nodeId: node.id, action: 'self_heal.runtime_rebound', actorType: 'system', actorId: 'engine', outputSummary: diagnosis });
        return { kind: 'structural_applied' };
      }
    }

    // 2) Reroute the step to the healer (configured agent, else orchestrator).
    const healerId = this.#resolveHealerExecutor(ctx, cfg, config.prompt);
    if (healerId && healerId !== pinnedId) {
      const attempt = recordSelfHealAttempt(ctx, node.id);
      await this.#persistRun(ctx).catch(() => {});
      const healerName = this.#agentDisplayName(healerId);
      const reroutedGraph: WorkflowGraph = {
        ...ctx.graph,
        nodes: ctx.graph.nodes.map((n) => (n.id === node.id ? { ...n, config: { ...config, agentId: healerId } } : n)),
      };
      const patch = this.#buildHealPatch(ctx, reroutedGraph, 'runtime_reroute');
      const diagnosis = `${pinnedId ? `Agent "${this.#agentDisplayName(pinnedId)}"` : 'This step\'s agent'} has no connected runtime. Re-routed the step to ${healerName} (online), preserving the task and its declared output contract.`;
      const grounding = `runtime reroute: ${pinnedId ?? 'unbound'} → ${healerId}`;
      const policy = decideRecoveryPolicy(cfg.mode, ctx.graph, reroutedGraph);
      const fingerprint = repairPlanFingerprint({
        tier: 'deterministic',
        addNodes: patch.addNodes,
        updateNodes: patch.updateNodes,
        removeNodeIds: patch.removeNodeIds,
        addEdges: patch.addEdges,
        removeEdgeIds: patch.removeEdgeIds,
      });
      if (this.#repairPlansFor(ctx, node.id).some((plan) => plan.fingerprint === fingerprint)) {
        return this.#blockSelfHeal(ctx, node, {
          mode: cfg.mode, attempt, maxAttempts: cfg.maxRepairPlans, error,
          reason: 'Self-healing rejected a duplicate runtime reroute instead of cycling executors.', diagnosis,
        });
      }
      const plan = this.#appendRepairPlan(ctx, node, {
        tier: 'deterministic',
        fingerprint,
        requiresApproval: policy.requiresApproval,
        patchId: patch.patchId,
        resumeNodeId: node.id,
        riskReason: policy.impact.reason,
        status: policy.requiresApproval ? 'awaiting_approval' : 'planned',
      });
      if (!policy.requiresApproval) {
        const applied = await this.#applyHealAndRedispatch(ctx, node.id, patch, plan.id);
        if (applied) {
          this.#recordSelfHealIncident(ctx, node, {
            status: 'APPLIED', mode: cfg.mode, attempt, maxAttempts: cfg.maxRepairPlans,
            diagnosis, reason: grounding, outcome: 'runtime_rerouted',
          });
          await this.#persistRun(ctx).catch(() => {});
          await this.deps.ledger.append({
            workspaceId: ctx.workspaceId, ambientId: ctx.ambientId, runId: ctx.runId,
            eventType: 'self_heal.runtime_rerouted', nodeId: node.id, payload: { from: pinnedId, to: healerId, attempt },
          }).catch(() => {});
          this.#audit(ctx, { nodeId: node.id, action: 'self_heal.runtime_rerouted', actorType: 'system', actorId: 'engine', outputSummary: diagnosis });
          return { kind: 'structural_applied' };
        }
      } else {
        const queued = await this.#proposeHealForApproval(ctx, node, patch, node.id, diagnosis, grounding, attempt, cfg.maxRepairPlans, policy.impact.reason, plan.id);
        if (queued) return { kind: 'awaiting_approval' };
      }
    }

    return { kind: 'none' };
  }

  /** Bind an agent's runtime if it isn't already connected. Returns true if it ends up connected. */
  #tryBindAgentRuntime(ctx: RunningContext, agentId: string, task?: string | null, model?: string | null): boolean {
    if (this.#agentHasConnectedRuntime(agentId)) return true;
    try {
      const runtime = this.deps.resolveAgentRuntime?.(ctx.workspaceId, agentId, task ?? null, model ?? null);
      if (runtime) {
        this.deps.adapters.register(agentId, runtime);
        this.deps.logger.info('engine.self_heal.runtime_bound', { runId: ctx.runId, agentId, adapterType: runtime.adapterType });
      }
    } catch (err) {
      this.deps.logger.warn('engine.self_heal.runtime_bind_failed', { runId: ctx.runId, agentId, error: (err as Error).message });
    }
    return this.#agentHasConnectedRuntime(agentId);
  }

  /** The agent that backs self-healing: configured healer → orchestrator → any connected agent. Ensures a runtime. */
  #resolveHealerExecutor(ctx: RunningContext, cfg: SelfHealConfig, task?: string | null): string | null {
    const ready = (id: string | null | undefined): string | null =>
      id && this.#tryBindAgentRuntime(ctx, id, task, this.#agentConfiguredModel(id)) ? id : null;
    return ready(cfg.healerAgentId)
      ?? ready(this.#findAgentByRole(ctx.workspaceId, 'orchestrator'))
      ?? this.#resolveConnectedFallbackAgent(ctx.workspaceId, []);
  }

  /** Human-readable name for an agent id (falls back to role, then id). */
  #agentDisplayName(agentId: string): string {
    try {
      const row = this.deps.db
        .select({ name: schema.agents.name, role: schema.agents.role })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();
      return row?.name?.trim() || row?.role?.trim() || agentId;
    } catch {
      return agentId;
    }
  }

  /**
   * The owning App's id for a workflow, or null for a bare workflow. When an
   * App owns the workflow, its run's memory forms into — and is recalled from —
   * the App's brain scope (AGENTIC-APPS-10X §5.4), so an Agentic App's
   * intelligence is bound to the App and travels with it. Memoized per workflow.
   */
  #appScopeId(workspaceId: string, workflowId: string): string | null {
    const cached = this.#appScopeCache.get(workflowId);
    if (cached !== undefined) return cached;
    let appId: string | null = null;
    try {
      const row = this.deps.db
        .select({ appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId)))
        .get();
      appId = row?.appId ?? null;
    } catch {
      appId = null;
    }
    this.#appScopeCache.set(workflowId, appId);
    return appId;
  }
  readonly #appScopeCache = new Map<string, string | null>();

  /** The REAL agents a repair may use, so the planner routes to something that exists. */
  #availableRepairResources(ctx: RunningContext): RepairResourceContext {
    try {
      const agents = this.deps.db
        .select({ id: schema.agents.id, role: schema.agents.role, status: schema.agents.status, capabilityTags: schema.agents.capabilityTags, isPaused: schema.agents.isPaused })
        .from(schema.agents)
        .where(eq(schema.agents.workspaceId, ctx.workspaceId))
        .all()
        .filter((a) => !a.isPaused)
        .map((a) => ({
          id: a.id,
          ...(a.role ? { role: a.role } : {}),
          status: this.#agentHasConnectedRuntime(a.id) ? 'connected' : (a.status ?? 'offline'),
          ...(Array.isArray(a.capabilityTags) && a.capabilityTags.length > 0 ? { capabilities: a.capabilityTags as string[] } : {}),
        }));
      return { agents };
    } catch {
      return {};
    }
  }

  /**
   * FULL POWER (the top rung): run the orchestrator as a real agent — the SAME
   * tool surface chat has — to replan a failed run. With the registry wired it can
   * CREATE what's missing (new agents, extensions, abilities, workflows) and then
   * resume; without it, it falls back to a read-only discovery loop. Either way it
   * only RETURNS a repaired graph: the service's finalize/validate/certify gates
   * and the engine's immutable-node/resume/policy/attempt-cap all apply unchanged,
   * so agency never bypasses safety and it can't loop (one plan per bounded
   * attempt; on failure it falls through to honest escalation).
   */
  async #orchestratorReplan(ctx: RunningContext, node: WorkflowNode, args: DeepPlanArgs): Promise<DeepPlanResult | null> {
    let cfg: SelfHealConfig;
    try { cfg = getSelfHealConfig(this.deps.db, ctx.workspaceId); } catch { return null; }
    const prompt = (node.config as { prompt?: string }).prompt ?? '';
    const healerId = this.#resolveHealerExecutor(ctx, cfg, prompt);
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
    const resourceLines = (args.resources?.agents ?? [])
      .map((a) => `- ${a.id}${a.role ? ` (${a.role})` : ''} [${a.status ?? 'unknown'}]${a.capabilities?.length ? ` caps: ${a.capabilities.join(',')}` : ''}`)
      .join('\n');
    const brief = [
      'You are the orchestrator repairing a FAILED workflow run so it still achieves its goal.',
      'Rules: change HOW, never WHAT (preserve the goal, input contract, and the meaning of declared outputs).',
      'NEVER alter the immutable (completed/active) nodes — their work is done; reusing it is mandatory and saves tokens.',
      'Resume from the minimal failed frontier; do not rebuild completed steps.',
      'Prefer the real available agents below. If a needed capability is genuinely missing, you MAY create it (a new agent, extension, ability, or workflow) with your tools — full power. Never reference a resource you have not verified exists or created.',
      '',
      `GOAL: ${clip(args.intent.goal, 500)}`,
      `DECLARED OUTPUTS (meaning immutable): ${args.intent.declaredOutputKeys.join(', ')}`,
      `FAILING NODE: ${args.node.id}`,
      `ERROR: ${clip(args.error, 600)}`,
      `DIAGNOSIS: ${clip(args.diagnosis, 500)}`,
      `IMMUTABLE NODE IDS: ${args.immutableNodeIds.join(', ') || '(none)'}`,
      resourceLines ? `AVAILABLE AGENTS:\n${clip(resourceLines, 2000)}` : 'AVAILABLE AGENTS: (none connected)',
      `COMPLETED UPSTREAM OUTPUTS (read-only evidence):\n${clip(JSON.stringify(args.upstreamOutputs ?? {}), 6000)}`,
      `CURRENT NODES:\n${clip(JSON.stringify(args.graph.nodes), 9000)}`,
      `CURRENT EDGES:\n${clip(JSON.stringify(args.graph.edges), 4000)}`,
      '',
      'Do not directly patch or rerun this live run with a tool. Create missing internal resources if needed, then RETURN the candidate repaired graph. The engine will validate, certify, checkpoint, apply, and resume.',
      'When the workflow can succeed, finish with EXACTLY one JSON object between <agentis_self_heal_repair> tags:',
      '<agentis_self_heal_repair>',
      '{"nodes":[...full nodes...],"edges":[...full edges...],"resumeNodeId":"<node id to resume from>","grounding":"<one line citing the evidence>","preservesIntent":true,"grounded":true,"cannotRepair":false}',
      '</agentis_self_heal_repair>',
      'If you cannot repair without breaking the rules, output <agentis_self_heal_repair>{"cannotRepair":true}</agentis_self_heal_repair>.',
    ].join('\n');
    this.#emitWorkStep(ctx, node, 'thinking', 'Orchestrator is replanning the workflow with full power');

    const chatPlan = await this.#chatReplanLoop(ctx, node, healerId, brief, clip);
    if (chatPlan) return chatPlan;

    // Fallback: read-only discovery loop when no chat-capable repair agent exists.
    const llm = (this.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'evaluation', { task: args.error, purpose: 'self_heal_replan' })
      ?? this.deps.evaluatorRuntime
      ?? this.#resolveSelfHealCompleter(ctx, node, prompt, args.error, cfg)) as StructuredLlm | null;
    if (!llm) return null;
    if (!this.deps.agentTools) return null;
    const role = ((healerId ? this.#agentRole(healerId) : null) ?? 'orchestrator') as AgentRole;
    const discoveryTools: AgentTool[] = ['web_search', 'read_url', 'knowledge_search', 'agent_memory_search', 'workflow_memory_read', 'run_code'];
    try {
      const result = await new AgentToolLoop({ runtime: this.deps.agentTools, llm, logger: this.deps.logger }).run({
        workspaceId: ctx.workspaceId, role, task: brief, tools: discoveryTools, maxSteps: 6, workflowId: ctx.workflowId,
        ...(healerId ? { agentId: healerId } : {}),
        onStep: (step) => { if (step.phase === 'thinking' && step.thought) this.#emitWorkStep(ctx, node, 'thinking', clip(step.thought, 200)); },
        ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
      });
      return this.#parseReplanOutput(result.output);
    } catch (err) {
      this.deps.logger.warn('engine.self_heal.replan_failed', { runId: ctx.runId, nodeId: node.id, error: (err as Error).message });
      return null;
    }
  }

  /** The full-power ReAct loop over the complete agent tool registry (creation included). */
  async #chatReplanLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    healerId: string | null,
    brief: string,
    clip: (s: string, n: number) => string,
  ): Promise<DeepPlanResult | null> {
    if (!healerId) return null;
    const adapter = this.deps.adapters.get(healerId)?.adapter;
    if (!adapter?.chat || adapter.capabilities?.().interactiveChat === false) return null;
    const systemAddendum = [
      'SELF-HEALING MODE: you are repairing a live workflow run.',
      'You may use ANY tool below — including creating new agents, abilities, extensions, or workflows — to make the run succeed.',
      'Use normal chat tool calls while working; only the final answer must be the tagged repair JSON.',
      '  {"thought":"...","action":"tool","toolId":"<id>","arguments":{...}}  — to use/create with a tool',
      '  {"thought":"...","action":"final","output":{...repair graph...}}      — when the workflow can now succeed',
      'Hard boundary: do not call agentis.workflow.patch, agentis.workflow.run, agentis.ephemeral.run, agentis.run.cancel, agentis.approval.resolve, or outbound channel-send tools for this repair. The engine applies and observes the repair after your final graph.',
      'Final response contract: reply with only <agentis_self_heal_repair>{...}</agentis_self_heal_repair>. No prose outside the tags.',
    ].join('\n');
    let text = '';
    let sawConfirmation = false;
    try {
      for await (const delta of ChatSessionExecutor.turn(adapter, [], brief, {
        workspaceId: ctx.workspaceId,
        agentId: healerId,
        userId: ctx.userId,
        conversationId: `self-heal:${ctx.runId}:${node.id}`,
        clientTurnId: `self-heal:${ctx.runId}:${node.id}`,
        executionMode: 'chat',
        runId: ctx.runId,
        ambientId: ctx.ambientId,
        viewport: {
          surface: 'run_detail',
          route: `/runs/${ctx.runId}`,
          resourceId: ctx.runId,
          resourceKind: 'run',
          activeRunId: ctx.runId,
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
        },
        ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
      }, {
        tools: this.#selfHealChatTools(),
        maxTurns: 8,
        maxToolCalls: 24,
        systemAddendum,
      })) {
        if (delta.type === 'text') text += delta.delta;
        if (delta.type === 'confirmation_required') sawConfirmation = true;
        this.#relaySelfHealChatDelta(ctx, node, healerId, delta, clip);
      }
    } catch (err) {
      this.deps.logger.warn('engine.self_heal.replan_failed', { runId: ctx.runId, nodeId: node.id, error: (err as Error).message });
      return null;
    }
    if (sawConfirmation) {
      this.#emitWorkStep(ctx, node, 'thinking', 'The repair agent reached a tool confirmation; self-heal will stop instead of applying an unreviewed tool action.');
      return null;
    }
    const out = this.#parseReplanOutput(text);
    if (out) this.deps.logger.info('engine.self_heal.replan_planned', { runId: ctx.runId, nodeId: node.id, source: 'chat' });
    return out;
      // a chat turn — the monitor/console/canvas all read these events, so the
  }

  #relaySelfHealChatDelta(
    ctx: RunningContext,
    node: WorkflowNode,
    healerId: string,
    delta: ChatDelta,
    clip: (s: string, n: number) => string,
  ): void {
    if (delta.type === 'activity') {
      this.#emitWorkStep(ctx, node, delta.phase === 'error' ? 'fail' : delta.phase === 'complete' ? 'complete' : 'thinking', [delta.label, delta.detail].filter(Boolean).join(' - '));
      return;
    }
    if (delta.type === 'thinking') {
      this.notifyAgentActivity({ runId: ctx.runId, agentId: healerId, taskId: node.id, kind: 'thinking', text: clip(delta.delta, 1000) });
      return;
    }
    if (delta.type === 'text' && delta.delta.trim()) {
      this.notifyAgentActivity({ runId: ctx.runId, agentId: healerId, taskId: node.id, kind: 'text', text: clip(delta.delta, 1000) });
      return;
    }
    if (delta.type === 'tool_call') {
      this.notifyAgentActivity({ runId: ctx.runId, agentId: healerId, taskId: node.id, kind: 'tool_call', tool: delta.name, toolInput: delta.args });
      return;
    }
    if (delta.type === 'tool_result') {
      this.notifyAgentActivity({ runId: ctx.runId, agentId: healerId, taskId: node.id, kind: 'tool_result', tool: delta.name, toolResult: delta.error ? { error: delta.error } : delta.result });
      return;
    }
    if (delta.type === 'confirmation_required') {
      this.#emitWorkStep(ctx, node, 'thinking', `Repair tool "${delta.toolCall.name}" needs confirmation`);
    }
  }

  #selfHealChatTools(): ToolDefinition[] | undefined {
    const registry = this.deps.toolRegistry;
    if (!registry) return undefined;
    const blocked = new Set([
      'agentis.workflow.patch',
      'agentis.workflow.run',
      'agentis.ephemeral.run',
      'agentis.run.cancel',
      'agentis.approval.resolve',
      'agentis.channel.send',
    ]);
    return registry.catalog().tools
      .filter((tool) => !blocked.has(tool.id))
      .map((tool) => ({
        name: tool.id,
        description: tool.longDescription ?? tool.description,
        parameters: toolInputSchemaToChatParameters(tool.inputSchema),
      }));
  }

  #parseReplanOutput(out: unknown): DeepPlanResult | null {
    type ReplanShape = {
      nodes?: WorkflowNode[];
      edges?: WorkflowGraph['edges'];
      resumeNodeId?: string;
      grounding?: string;
      preservesIntent?: boolean;
      grounded?: boolean;
      cannotRepair?: boolean;
    };
    let parsed: ReplanShape | null = null;
    if (out && typeof out === 'object') parsed = out as ReplanShape;
    else if (typeof out === 'string') {
      const tagged = out.match(/<agentis_self_heal_repair>\s*([\s\S]*?)\s*<\/agentis_self_heal_repair>/i)?.[1] ?? out;
      parsed = parseGeneric(tagged) as ReplanShape | null;
    }
    if (!parsed || parsed.cannotRepair || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return null;
    return {
      nodes: parsed.nodes,
      ...(parsed.edges ? { edges: parsed.edges } : {}),
      ...(parsed.resumeNodeId ? { resumeNodeId: parsed.resumeNodeId } : {}),
      ...(parsed.grounding ? { grounding: parsed.grounding } : {}),
      ...(parsed.preservesIntent === true ? { preservesIntent: true } : {}),
      ...(parsed.grounded === true ? { grounded: true } : {}),
    };
  }

  /** Reset a node to PENDING and re-dispatch it through the normal path (no graph change). */
  async #redispatchNodeFresh(ctx: RunningContext, nodeId: string, reason: string): Promise<boolean> {
    const node = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return false;
    const inputData = ctx.state.nodeStates[nodeId]?.inputData ?? {};
    const ns = ctx.state.nodeStates[nodeId];
    if (ns) ns.status = 'PENDING';
    delete ctx.state.activeExecutions[nodeId];
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, { runId: ctx.runId, nodeId, reason });
    try {
      await this.#dispatchNode(ctx, node, { nodeId, priority: 0, insertedAt: new Date().toISOString(), inputData });
      void this.#tick(ctx);
      return true;
    } catch (err) {
      this.deps.logger.warn('engine.self_heal.redispatch_failed', { runId: ctx.runId, nodeId, error: (err as Error).message });
      return false;
    }
  }

  /**
   * Resolve the brain that grounds self-healing. A dedicated evaluator is best,
   * but Agentis must not block repairs just because no evaluator model is
   * configured: the connected orchestrator/specialists are already valid
   * reasoning runtimes.
   */
  #resolveSelfHealCompleter(
    ctx: RunningContext,
    node: WorkflowNode,
    prompt: string,
    error: string,
    cfg: SelfHealConfig,
  ): StructuredCompleter | null {
    const task = prompt || error || node.title;
    const dedicated = this.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'evaluation', {
      task,
      purpose: 'self_heal',
    }) ?? this.deps.evaluatorRuntime;
    if (dedicated && typeof (dedicated as { completeStructured?: unknown }).completeStructured === 'function') {
      return dedicated as unknown as StructuredCompleter;
    }

    const fallbacks: StructuredCompleter[] = [];
    for (const candidate of this.#selfHealAgentCandidates(ctx, node, cfg)) {
      const completer = this.#adapterCompleterForSelfHealAgent(ctx, candidate.agentId, {
        nodeId: node.id,
        task,
        preferredModel: candidate.preferredModel,
        label: candidate.label,
      });
      if (completer) fallbacks.push(completer);
    }
    return fallbacks.length === 0 ? null : fallbacks.length === 1 ? (fallbacks.at(0) ?? null) : new FallbackStructuredCompleter(fallbacks);
  }

  #selfHealAgentCandidates(
    ctx: RunningContext,
    node: WorkflowNode,
    cfg: SelfHealConfig,
  ): Array<{ agentId: string; preferredModel?: string; label: string }> {
    const candidates: Array<{ agentId: string; preferredModel?: string; label: string }> = [];
    const seen = new Set<string>();
    const add = (agentId: unknown, label: string, preferredModel?: string | null) => {
      if (typeof agentId !== 'string' || !agentId.trim() || seen.has(agentId)) return;
      seen.add(agentId);
      candidates.push({
        agentId,
        label,
        ...(preferredModel ? { preferredModel } : {}),
      });
    };

    const workspaceAgents = this.deps.db
      .select({
        id: schema.agents.id,
        role: schema.agents.role,
        status: schema.agents.status,
        isPaused: schema.agents.isPaused,
      })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ctx.workspaceId))
      .all();
    // Strict and inspectable: configured healer, then orchestrator. A failed
    // repair must never silently commandeer an unrelated workspace agent.
    if (cfg.healerAgentId) add(cfg.healerAgentId, 'self-heal configured healer');
    const orchestrator = workspaceAgents.find((agent) => agent.role === 'orchestrator' && !agent.isPaused)
      ?? workspaceAgents.find((agent) => agent.role === 'orchestrator');
    if (orchestrator) add(orchestrator.id, 'self-heal orchestrator runtime');

    return candidates;
  }

  #adapterCompleterForSelfHealAgent(
    ctx: RunningContext,
    agentId: string,
    args: { nodeId: string; task: string; preferredModel?: string; label: string },
  ): StructuredCompleter | null {
    const preferredModel = args.preferredModel ?? this.#agentConfiguredModel(agentId) ?? undefined;
    let adapter = this.deps.adapters.get(agentId)?.adapter;
    if (!adapter) {
      const resolved = this.deps.resolveAgentRuntime?.(ctx.workspaceId, agentId, args.task, preferredModel ?? null);
      if (resolved) {
        this.deps.adapters.register(agentId, resolved);
        adapter = resolved;
        this.deps.logger.info('engine.self_heal.runtime_bound', {
          runId: ctx.runId,
          nodeId: args.nodeId,
          agentId,
          adapterType: resolved.adapterType,
        });
      }
    }
    if (!adapter?.chat || adapter.capabilities?.().interactiveChat === false) return null;
    this.deps.logger.info('engine.self_heal.agent_runtime', {
      runId: ctx.runId,
      nodeId: args.nodeId,
      agentId,
      adapterType: adapter.adapterType,
      source: args.label,
    });
    return new AdapterStructuredCompleter(adapter, `${args.label}:${agentId}`, preferredModel);
  }

  /** Collect the outputs of nodes feeding into `nodeId` (read-only diagnosis context). */
  #upstreamOutputs(ctx: RunningContext, nodeId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const edge of ctx.graph.edges) {
      if (edge.target !== nodeId) continue;
      const data = ctx.state.nodeStates[edge.source]?.outputData;
      if (data) out[edge.source] = data;
    }
    return out;
  }

  #repairPlansFor(ctx: RunningContext, nodeId: string) {
    return ctx.state.selfHealIncidents?.[nodeId]?.plans ?? [];
  }

  #immutableRecoveryNodeIds(ctx: RunningContext, failedNodeId: string): string[] {
    return Object.values(ctx.state.nodeStates)
      .filter((state) => state.nodeId !== failedNodeId && (state.status === 'COMPLETED' || state.status === 'RUNNING'))
      .map((state) => state.nodeId);
  }

  #appendRepairPlan(
    ctx: RunningContext,
    node: WorkflowNode,
    plan: Omit<NonNullable<WorkflowSelfHealIncident['plans']>[number], 'id' | 'createdAt'>,
  ): NonNullable<WorkflowSelfHealIncident['plans']>[number] {
    const now = new Date().toISOString();
    const next = { ...plan, id: randomUUID(), createdAt: now };
    const current = ctx.state.selfHealIncidents?.[node.id];
    this.#recordSelfHealIncident(ctx, node, {
      incidentId: current?.incidentId ?? node.id,
      failureFingerprint: current?.failureFingerprint ?? recoveryFailureFingerprint(node.id, current?.error ?? ''),
      plans: [...(current?.plans ?? []), next],
      tier: next.tier,
      status: 'PLANNING',
    });
    return next;
  }

  #completeRepairPlan(
    ctx: RunningContext,
    node: WorkflowNode,
    planId: string,
    status: Extract<NonNullable<WorkflowSelfHealIncident['plans']>[number]['status'], 'applied' | 'rejected' | 'blocked' | 'rolled_back'>,
    checkpointId?: string,
  ): void {
    const current = ctx.state.selfHealIncidents?.[node.id];
    if (!current?.plans) return;
    const now = new Date().toISOString();
    this.#recordSelfHealIncident(ctx, node, {
      plans: current.plans.map((plan) => plan.id === planId ? { ...plan, status, checkpointId: checkpointId ?? plan.checkpointId, completedAt: now } : plan),
      checkpointId: checkpointId ?? current.checkpointId,
    });
  }

  #recordSelfHealIncident(
    ctx: RunningContext,
    node: WorkflowNode,
    update: Partial<WorkflowSelfHealIncident>,
  ): WorkflowSelfHealIncident {
    const now = new Date().toISOString();
    const current = ctx.state.selfHealIncidents?.[node.id];
    const status = update.status ?? current?.status ?? 'DIAGNOSING';
    const terminal = status === 'APPLIED' || status === 'BLOCKED' || status === 'EXHAUSTED';
    const incident: WorkflowSelfHealIncident = {
      ...current,
      incidentId: update.incidentId ?? current?.incidentId ?? node.id,
      nodeId: node.id,
      nodeTitle: node.title,
      status,
      mode: update.mode ?? current?.mode ?? 'guarded',
      attempt: update.attempt ?? current?.attempt ?? 0,
      maxAttempts: update.maxAttempts ?? current?.maxAttempts ?? 0,
      error: update.error ?? current?.error,
      diagnosis: update.diagnosis ?? current?.diagnosis,
      reason: update.reason ?? current?.reason,
      tier: update.tier ?? current?.tier,
      failureFingerprint: update.failureFingerprint ?? current?.failureFingerprint ?? recoveryFailureFingerprint(node.id, update.error ?? current?.error ?? ''),
      plans: update.plans ?? current?.plans,
      riskReason: update.riskReason ?? current?.riskReason,
      approvalId: update.approvalId ?? current?.approvalId,
      checkpointId: update.checkpointId ?? current?.checkpointId,
      resumeNodeId: update.resumeNodeId ?? current?.resumeNodeId,
      outcome: update.outcome ?? current?.outcome,
      startedAt: current?.startedAt ?? now,
      updatedAt: now,
      ...(terminal ? { completedAt: update.completedAt ?? current?.completedAt ?? now } : {}),
    };
    ctx.state.selfHealIncidents = { ...(ctx.state.selfHealIncidents ?? {}), [node.id]: incident };
    return incident;
  }

  async #blockSelfHeal(
    ctx: RunningContext,
    node: WorkflowNode,
    args: {
      mode: WorkflowRecoveryMode;
      attempt: number;
      maxAttempts: number;
      error: string;
      reason: string;
      diagnosis?: string;
      exhausted?: boolean;
    },
  ): Promise<SelfHealEngineResult> {
    const status = args.exhausted ? 'EXHAUSTED' : 'BLOCKED';
    this.#recordSelfHealIncident(ctx, node, {
      status,
      mode: args.mode,
      attempt: args.attempt,
      maxAttempts: args.maxAttempts,
      error: args.error,
      reason: args.reason,
      diagnosis: args.diagnosis,
      outcome: args.exhausted ? 'exhausted' : 'blocked',
    });
    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: args.exhausted ? 'self_heal.exhausted' : 'self_heal.blocked',
      nodeId: node.id,
      payload: {
        reason: args.reason,
        diagnosis: args.diagnosis,
        attempt: args.attempt,
        maxAttempts: args.maxAttempts,
      },
    }).catch(() => {});
    this.#audit(ctx, {
      nodeId: node.id,
      action: args.exhausted ? 'self_heal.exhausted' : 'self_heal.blocked',
      actorType: 'system',
      actorId: 'engine',
      outputSummary: args.diagnosis ? `${args.reason}: ${args.diagnosis}` : args.reason,
    });
    await this.#persistRun(ctx).catch(() => {});
    return { kind: 'none', reason: args.reason, diagnosis: args.diagnosis };
  }

  /** Turn a certified full graph into the one shared graph-patch representation. */
  #buildHealPatch(ctx: RunningContext, patchedGraph: WorkflowGraph, reason: string): WorkflowGraphPatch {
    void reason;
    return graphDiffPatch(ctx.graph, patchedGraph, ctx.state.graphRevision ?? 0);
  }

  /** Apply a certified heal patch (reuses applyGraphPatch: validate+persist+revision+audit), then re-run the node. */
  async #applyHealAndRedispatch(ctx: RunningContext, nodeId: string, patch: WorkflowGraphPatch, repairPlanId?: string): Promise<boolean> {
    const graphBefore = ctx.graph;
    const revisionBefore = ctx.state.graphRevision ?? 0;
    try {
      await this.applyGraphPatch({ runId: ctx.runId, patch });
    } catch (err) {
      this.deps.logger.warn('engine.self_heal.apply_failed', { runId: ctx.runId, nodeId, error: (err as Error).message });
      return false;
    }
    let checkpointId: string | undefined;
    if (repairPlanId) {
      const incident = Object.values(ctx.state.selfHealIncidents ?? {}).find((item) => item.plans?.some((plan) => plan.id === repairPlanId));
      if (incident) {
        checkpointId = randomUUID();
        try {
          await this.deps.db.insert(schema.workflowRepairCheckpoints).values({
            id: checkpointId,
            workspaceId: ctx.workspaceId,
            runId: ctx.runId,
            workflowId: ctx.workflowId || null,
            incidentId: incident.incidentId ?? incident.nodeId,
            planId: repairPlanId,
            revisionBefore,
            revisionAfter: ctx.state.graphRevision ?? revisionBefore + 1,
            graphBefore: graphBefore as unknown as object,
            graphAfter: ctx.graph as unknown as object,
            patch: patch as unknown as object,
          });
          const incidentNode = ctx.graph.nodes.find((node) => node.id === incident.nodeId) ?? {
            id: incident.nodeId,
            title: incident.nodeTitle ?? incident.nodeId,
          } as WorkflowNode;
          this.#completeRepairPlan(ctx, incidentNode, repairPlanId, 'applied', checkpointId);
        } catch (err) {
          this.deps.logger.warn('engine.self_heal.checkpoint_failed', { runId: ctx.runId, repairPlanId, error: (err as Error).message });
          return false;
        }
      }
    }
    // Reconciliation belongs beside the only repair executor. New topology gets
    // fresh pending state, while completed/in-flight nodes were rejected by the
    // planner before this point.
    for (const removedNodeId of patch.removeNodeIds) {
      const state = ctx.state.nodeStates[removedNodeId];
      // The failed node may still be marked RUNNING while #failNode invokes
      // recovery. Completed work is immutable; the failing execution is not.
      if (state?.status === 'COMPLETED') return false;
      delete ctx.state.nodeStates[removedNodeId];
      delete ctx.state.activeExecutions[removedNodeId];
      ctx.state.readyQueue = ctx.state.readyQueue.filter((item) => item.nodeId !== removedNodeId);
    }
    for (const added of patch.addNodes) {
      ctx.state.nodeStates[added.id] ??= { nodeId: added.id, status: 'PENDING' };
    }
    const patched = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (!patched) return false;
    const inputData = ctx.state.nodeStates[nodeId]?.inputData ?? {};
    // Reset the node so it re-runs through the ORIGINAL dispatch path
    // (#dispatchNode handles useRoleTools / session / adapter uniformly — calling
    // #dispatchAgentTask directly would skip routing + the tool-loop branch).
    const ns = ctx.state.nodeStates[nodeId];
    if (ns) ns.status = 'PENDING';
    else ctx.state.nodeStates[nodeId] = { nodeId, status: 'PENDING', inputData };
    delete ctx.state.activeExecutions[nodeId];
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, { runId: ctx.runId, nodeId, reason: 'self_heal_structural' });
    await this.#dispatchNode(ctx, patched, { nodeId, priority: 0, insertedAt: new Date().toISOString(), inputData });
    if (repairPlanId) this.#completeRepairPlan(ctx, patched, repairPlanId, 'applied', checkpointId);
    // Drive the settle pass — re-dispatch may originate outside the tick loop
    // (e.g. resolveApproval), where nothing else would transition the run.
    void this.#tick(ctx);
    return true;
  }

  /** Queue a structural heal patch for operator approval; pause the node (W7 approve mode). */
  async #proposeHealForApproval(
    ctx: RunningContext,
    node: WorkflowNode,
    patch: WorkflowGraphPatch,
    resumeNodeId: string,
    diagnosis: string,
    grounding: string,
    attempt: number,
    maxAttempts: number,
    riskReason?: string,
    repairPlanId?: string,
  ): Promise<boolean> {
    try {
      const approval = await this.deps.approvals.create({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        runId: ctx.runId,
        taskId: null,
        targetId: node.id,
        gatewayId: null,
        source: 'self_heal',
        title: `Confirm outward self-healing change for "${node.title}"`,
        summary: `${diagnosis}\n\nGrounding: ${grounding}\n\nWhy confirmation is needed: ${riskReason ?? 'The repair changes an outward or irreversible action.'}\n\nApprove to apply and resume.`,
        confidence: null,
        payload: {
          kind: 'graph_patch',
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          nodeId: node.id,
          nodeTitle: node.title,
          diagnosis,
          grounding,
          attempt,
          maxAttempts,
          patch,
          resumeNodeId,
          riskReason,
          repairPlanId,
        },
      });
      this.#pendingApprovals(ctx).set(approval.id, {
        kind: 'self_heal', targetId: node.id, healAction: 'graph_patch', healPatch: patch,
        healResumeNodeId: resumeNodeId, repairPlanId,
      });
      const ns = ctx.state.nodeStates[node.id];
      if (ns) ns.status = 'WAITING';
      delete ctx.state.activeExecutions[node.id];
      this.#recordSelfHealIncident(ctx, node, {
        status: 'AWAITING_APPROVAL',
        mode: 'guarded',
        attempt,
        maxAttempts,
        diagnosis,
        reason: grounding,
        riskReason,
        resumeNodeId,
        approvalId: approval.id,
        outcome: 'graph_patch_awaiting_approval',
      });
      await this.#persistRun(ctx);
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
        runId: ctx.runId,
        nodeId: node.id,
        reason: 'self_heal_approval',
        detail: diagnosis,
        approvalId: approval.id,
      });
      await this.deps.ledger.append({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        runId: ctx.runId,
        eventType: 'self_heal.approval_requested',
        nodeId: node.id,
        payload: { approvalId: approval.id, diagnosis, grounding, attempt, maxAttempts },
      }).catch(() => {});
      this.#audit(ctx, { nodeId: node.id, action: 'self_heal.approval_requested', actorType: 'system', actorId: 'engine', outputSummary: diagnosis });
      return true;
    } catch (err) {
      this.deps.logger.warn('engine.self_heal.approval_failed', { runId: ctx.runId, nodeId: node.id, error: (err as Error).message });
      return false;
    }
  }

  async #retryWithRepairContext(
    ctx: RunningContext,
    node: WorkflowNode,
    error: string,
    diagnosis: string,
    attempt: number,
    maxAttempts: number,
    mode: WorkflowRecoveryMode = 'bypass',
  ): Promise<boolean> {
    if (node.config.kind !== 'agent_task') return false;
    const inputData = ctx.state.nodeStates[node.id]?.inputData ?? {};
    const retryConfig: AgentTaskNodeConfig = {
      ...node.config,
      prompt:
        `${node.config.prompt}\n\n---\nSELF-HEALING RETRY (attempt ${attempt}/${maxAttempts}).\n` +
        `Failure: ${error}\nDiagnosis: ${diagnosis}\n` +
        'Repair the step while preserving the workflow intent. Do not fabricate missing source data.',
    };
    const retryNode: WorkflowNode = { ...node, config: retryConfig };
    const ns = ctx.state.nodeStates[node.id];
    if (ns) ns.status = 'PENDING';
    delete ctx.state.activeExecutions[node.id];
    this.#recordSelfHealIncident(ctx, node, {
      status: 'RETRYING',
      mode,
      attempt,
      maxAttempts,
      error,
      diagnosis,
      outcome: 'retrying',
    });
    await this.#persistRun(ctx).catch(() => {});
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, {
      runId: ctx.runId,
      nodeId: node.id,
      attempt,
      reason: 'self_heal_retry_with_repair_context',
    });
    try {
      await this.#dispatchNode(ctx, retryNode, {
        nodeId: node.id,
        priority: 0,
        insertedAt: new Date().toISOString(),
        inputData,
      });
      void this.#tick(ctx);
      return true;
    } catch (err) {
      await this.#failNode(ctx, node.id, (err as Error).message);
      return false;
    }
  }

  async #proposeRetryForApproval(
    ctx: RunningContext,
    node: WorkflowNode,
    error: string,
    diagnosis: string,
    attempt: number,
    maxAttempts: number,
  ): Promise<boolean> {
    if (node.config.kind !== 'agent_task') return false;
    try {
      const approval = await this.deps.approvals.create({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        runId: ctx.runId,
        taskId: null,
        targetId: node.id,
        gatewayId: null,
        source: 'self_heal',
        title: `Approve self-healing retry for "${node.title}"`,
        summary: `${diagnosis}\n\nThe agent can retry this step with the failure context attached. Approve to retry and resume.`,
        confidence: null,
        payload: {
          kind: 'retry_with_repair_context',
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          nodeId: node.id,
          nodeTitle: node.title,
          error,
          diagnosis,
          attempt,
          maxAttempts,
        },
      });
      this.#pendingApprovals(ctx).set(approval.id, {
        kind: 'self_heal',
        targetId: node.id,
        healAction: 'retry_with_repair_context',
        retryError: error,
        retryDiagnosis: diagnosis,
        retryAttempt: attempt,
        retryMaxAttempts: maxAttempts,
      });
      const ns = ctx.state.nodeStates[node.id];
      if (ns) ns.status = 'WAITING';
      delete ctx.state.activeExecutions[node.id];
      this.#recordSelfHealIncident(ctx, node, {
        status: 'AWAITING_APPROVAL',
        mode: 'guarded',
        attempt,
        maxAttempts,
        error,
        diagnosis,
        approvalId: approval.id,
        outcome: 'retry_awaiting_approval',
      });
      await this.#persistRun(ctx);
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
        runId: ctx.runId,
        nodeId: node.id,
        reason: 'self_heal_retry_approval',
        detail: diagnosis,
        approvalId: approval.id,
      });
      await this.deps.ledger.append({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        runId: ctx.runId,
        eventType: 'self_heal.retry_approval_requested',
        nodeId: node.id,
        payload: { approvalId: approval.id, diagnosis, attempt, maxAttempts },
      }).catch(() => {});
      this.#audit(ctx, { nodeId: node.id, action: 'self_heal.retry_approval_requested', actorType: 'system', actorId: 'engine', outputSummary: diagnosis });
      return true;
    } catch (err) {
      this.deps.logger.warn('engine.self_heal.retry_approval_failed', { runId: ctx.runId, nodeId: node.id, error: (err as Error).message });
      return false;
    }
  }

  async #tryLegacyAgentTaskSelfHealRetry(ctx: RunningContext, node: WorkflowNode, error: string): Promise<boolean> {
    if (node.config.kind !== 'agent_task' || !node.config.retryPolicy?.selfHeal) return false;
    const max = node.config.retryPolicy.maxSelfHealAttempts ?? 2;
    const attempts = selfHealAttemptCount(ctx, node.id);
    if (attempts >= max) return false;
    const nextAttempt = recordSelfHealAttempt(ctx, node.id);
    await this.#persistRun(ctx).catch(() => {});
    this.deps.logger.info('engine.self_heal.retry', {
      runId: ctx.runId,
      nodeId: node.id,
      attempt: nextAttempt,
      max,
    });
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, {
      runId: ctx.runId,
      nodeId: node.id,
      attempt: nextAttempt,
      reason: 'self_heal',
    });
    const inputData = ctx.state.nodeStates[node.id]?.inputData ?? {};
    const healConfig: AgentTaskNodeConfig = {
      ...node.config,
      prompt:
        `${node.config.prompt}\n\n---\nPREVIOUS ATTEMPT FAILED (attempt ${nextAttempt}/${max}).\n` +
        `Error: ${error}\nAnalyse the error and correct your output.`,
    };
    await this.#dispatchAgentTask(ctx, node, healConfig, inputData);
    return true;
  }

  #reflectHardNodeFailure(ctx: RunningContext, node: WorkflowNode, error: string): void {
    if (node.config.kind !== 'agent_task') return;
    if (this.deps.failureReflection) {
      const agentId = ctx.state.activeExecutions[node.id]?.executorRef ?? node.config.agentId;
      if (agentId) {
        this.deps.failureReflection.reflect({
          workspaceId: ctx.workspaceId,
          agentId,
          runId: ctx.runId,
          nodeTitle: node.title,
          prompt: node.config.prompt,
          error,
        });
      }
    }

    // Phase 4 - Feynman repair loop. We reach here when an agent_task has hard-
    // failed (self-heal disabled or exhausted). Record the failure for cross-run
    // counting, and enqueue a grounded reflection only when self-heal exhausted
    // or the same node keeps failing.
    if (this.deps.feynmanReflection && this.deps.brainQueue) {
      try {
        const fr = this.deps.feynmanReflection;
        const max = node.config.retryPolicy?.maxSelfHealAttempts ?? 2;
        const selfHealExhausted = Boolean(node.config.retryPolicy?.selfHeal)
          && selfHealAttemptCount(ctx, node.id) >= max;
        const agentId = ctx.state.activeExecutions[node.id]?.executorRef ?? node.config.agentId ?? null;
        const failureCount = fr.recordFailure({
          workspaceId: ctx.workspaceId,
          workflowId: ctx.workflowId,
          nodeId: node.id,
          runId: ctx.runId,
          agentId,
        });
        const trigger: FeynmanTrigger | null = selfHealExhausted
          ? 'self_heal_exhausted'
          : failureCount >= REPEAT_FAILURE_THRESHOLD
            ? 'repeated_failure'
            : null;
        if (trigger) {
          const inputData = ctx.state.nodeStates[node.id]?.inputData ?? null;
          this.deps.brainQueue.enqueue({
            workspaceId: ctx.workspaceId,
            itemType: 'feynman_reflection',
            priority: 'normal',
            payload: {
              workspaceId: ctx.workspaceId,
              runId: ctx.runId,
              workflowId: ctx.workflowId,
              nodeId: node.id,
              nodeTitle: node.title,
              agentId,
              scopeId: agentId,
              prompt: node.config.prompt,
              error,
              observations: inputData ? JSON.stringify(inputData).slice(0, 800) : null,
              trigger,
            },
          });
          this.deps.logger.info('engine.feynman.enqueued', { runId: ctx.runId, nodeId: node.id, trigger, failureCount });
        }
      } catch (err) {
        this.deps.logger.warn('engine.feynman.enqueue_failed', { runId: ctx.runId, nodeId: node.id, err: (err as Error).message });
      }
    }
  }

  async notifyTaskFailed(args: { runId: string; nodeId: string; error: string }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    if (ctx.state.status === 'PAUSED' || isTerminalRunStatus(ctx.state.status)) return;
    const swarm = parseSwarmTaskId(args.nodeId);
    if (swarm) {
      await this.#onSwarmSubtask(ctx, swarm.nodeId, swarm.index, null, args.error);
      return;
    }
    // W7 — autonomous self-healing on a hard node failure: diagnose + (when
    // Self-healing agent task (AGENTIS-PLATFORM-10X Â§A9): re-dispatch with the
    // Phase 4 — Feynman repair loop. We reach here when an agent_task has hard-
    await this.#failNode(ctx, args.nodeId, args.error);
    void this.#tick(ctx);
  }

  /**
   * LAYER 1: stream an agent's live reasoning / output / tool-call during a run.
   * Called by the adapter-event bridge (bootstrap) for `agent.thinking`,
   * `task.progress`, and `agent.tool_call`. Resolves the active node (so the UI
   * attributes the thought to the right step), publishes to the run + workspace
   * rooms in the SAME shape the frontend already consumes
   * (AGENT_TERMINAL_MESSAGE / AGENT_TERMINAL_TOOL_CALL), and appends to the
   * replayable tail. This is what makes a run's thinking visible everywhere.
   */
  notifyAgentActivity(args: {
    runId: string;
    agentId?: string;
    taskId?: string;
    kind: 'thinking' | 'text' | 'tool_call' | 'tool_result';
    text?: string;
    tool?: string;
    toolInput?: unknown;
    toolResult?: unknown;
  }): void {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    const nodeId = this.#activeNodeForAgent(ctx, args.agentId, args.taskId);
    const node = nodeId ? ctx.graph.nodes.find((n) => n.id === nodeId) : undefined;
    const agentName = args.agentId
      ? this.deps.db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, args.agentId)).get()?.name
      : undefined;
    const event = args.kind === 'tool_call' || args.kind === 'tool_result'
      ? REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL
      : REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE;
    const payload: Record<string, unknown> = {
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      workspaceId: ctx.workspaceId,
      agentId: args.agentId,
      agentName,
      nodeId,
      nodeTitle: node?.title,
      activityKind: args.kind,
      at: new Date().toISOString(),
      ...(args.text ? { message: args.text } : {}),
      ...(args.tool ? { tool: args.tool, args: args.toolInput } : {}),
      ...(args.toolResult !== undefined ? { result: args.toolResult } : {}),
    };
    // Run room only: the workspace-room copy is published by `publishAdapterRealtime`
    // (bootstrap). This adds the run-scoped delivery the canvas monitor needs, with
    // the CORRECT node attribution (resolved via activeExecutions, not the taskId),
    // plus the replayable tail.
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), event, payload);
    this.#appendActivityTail(ctx.runId, event, payload);
  }

  /** The node this agent/task is currently executing (for thought attribution). */
  #activeNodeForAgent(ctx: RunningContext, agentId?: string, taskId?: string): string | null {
    for (const [nodeId, exec] of Object.entries(ctx.state.activeExecutions)) {
      if (!exec) continue;
      if (taskId && exec.taskId === taskId) return nodeId;
      if (agentId && exec.executorRef === agentId) return nodeId;
    }
    // Fall back to the single active node if there's exactly one.
    const active = Object.keys(ctx.state.activeExecutions);
    return active.length === 1 ? active[0]! : null;
  }

  /** Append to the capped, in-memory replayable activity tail for a run. */
  #appendActivityTail(runId: string, event: string, payload: Record<string, unknown>): void {
    let tail = this.#runActivity.get(runId);
    if (!tail) { tail = []; this.#runActivity.set(runId, tail); }
    tail.push({ event, payload, emittedAt: new Date().toISOString() });
    if (tail.length > RUN_ACTIVITY_TAIL_CAP) tail.splice(0, tail.length - RUN_ACTIVITY_TAIL_CAP);
  }

  /** Recent activity for a run (back-fill for a surface opened mid-run). */
  getRunActivity(runId: string): RunActivityEnvelope[] {
    return this.#runActivity.get(runId) ?? [];
  }

  /**
   * Drop all in-memory state for a terminated run. The activity tail is capped
   * per-run but never expired on its own, so without this the #runActivity Map
   * grows unbounded across the process lifetime (one capped tail per run, kept
   * forever). Call this anywhere a run reaches a terminal status.
   */
  #disposeRunState(runId: string): void {
    this.#runs.delete(runId);
    this.#runActivity.delete(runId);
  }

  /** Resolve an agent's display name for conversation/activity attribution. */
  #agentName(agentId: string | null | undefined): string | undefined {
    if (!agentId) return undefined;
    return this.deps.db
      .select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.name;
  }

  /**
   * Apply a dynamic graph patch to a live run (V1-SPEC Â§6.6).
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
    }
    // The run snapshot is the immutable source for Inspect/history/replay. Keep
    // it current even when the repair is also promoted to the saved workflow.
    await this.deps.db
      .update(schema.workflowRuns)
      .set({ graphSnapshot: merged as unknown as object, updatedAt: new Date().toISOString() })
      .where(eq(schema.workflowRuns.id, run.id));

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
      summary: `Graph patched (${patch.reason}) â†’ revision ${newRevision}`,
      metadata: {
        patchId: patch.patchId,
        addNodes: patch.addNodes.length,
        updateNodes: patch.updateNodes.length,
        removeNodes: patch.removeNodeIds.length,
      },
    });

    return { newRevision };
  }

  /** Roll back the newest unapplied self-healing checkpoint without clobbering later edits. */
  async rollbackSelfHeal(args: { runId: string; checkpointId: string }): Promise<{ newRevision: number }> {
    const ctx = this.#runs.get(args.runId) ?? this.#ensureRecoveredCtx(args.runId);
    if (!ctx) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', `Run ${args.runId} not found`);
    const checkpoint = this.deps.db
      .select()
      .from(schema.workflowRepairCheckpoints)
      .where(and(eq(schema.workflowRepairCheckpoints.id, args.checkpointId), eq(schema.workflowRepairCheckpoints.runId, args.runId)))
      .get();
    if (!checkpoint || checkpoint.rolledBackAt) throw new AgentisError('RESOURCE_NOT_FOUND', 'Repair checkpoint is unavailable');
    if ((ctx.state.graphRevision ?? 0) !== checkpoint.revisionAfter) {
      throw new AgentisError('GRAPH_REVISION_CONFLICT', 'Only the latest graph repair can be rolled back safely');
    }
    const current = ctx.graph;
    const expected = checkpoint.graphAfter as unknown as WorkflowGraph;
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new AgentisError('GRAPH_REVISION_CONFLICT', 'The workflow changed after this repair; rollback would overwrite newer work');
    }
    const patch = graphDiffPatch(current, checkpoint.graphBefore as unknown as WorkflowGraph, ctx.state.graphRevision ?? 0);
    const result = await this.applyGraphPatch({ runId: args.runId, patch });
    const now = new Date().toISOString();
    await this.deps.db.update(schema.workflowRepairCheckpoints)
      .set({ rolledBackAt: now, updatedAt: now })
      .where(eq(schema.workflowRepairCheckpoints.id, checkpoint.id));
    const incident = Object.values(ctx.state.selfHealIncidents ?? {}).find((item) => item.plans?.some((plan) => plan.id === checkpoint.planId));
    if (incident) {
      const node = ctx.graph.nodes.find((candidate) => candidate.id === incident.nodeId) ?? {
        id: incident.nodeId,
        title: incident.nodeTitle ?? incident.nodeId,
      } as WorkflowNode;
      this.#completeRepairPlan(ctx, node, checkpoint.planId, 'rolled_back', checkpoint.id);
      this.#recordSelfHealIncident(ctx, node, { status: 'ROLLED_BACK', outcome: 'rolled_back', checkpointId: checkpoint.id, reason: 'The latest self-healing repair was rolled back by the operator.' });
      await this.#persistRun(ctx);
    }
    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId, ambientId: ctx.ambientId, runId: ctx.runId,
      eventType: 'self_heal.rolled_back', nodeId: incident?.nodeId,
      payload: { checkpointId: checkpoint.id, planId: checkpoint.planId },
    }).catch(() => {});
    return result;
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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Dispatch loop
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      const readiness = this.#dispatchReadiness(ctx, node.id);
      if (readiness.kind === 'waiting') {
        ctx.state.waitingInputs[node.id] = readiness.buffer;
        continue;
      }
      if (readiness.kind === 'skipped') {
        this.#skipUnreachable(ctx, node.id, readiness.reason);
        continue;
      }
      ctx.inflightDispatches += 1;
      void this.#dispatchNode(ctx, node, item)
        .then(() => {
          ctx.inflightDispatches -= 1;
          void this.#tick(ctx);
        })
        .catch(async (err) => {
          try {
            // Failure bookkeeping is part of the dispatch lifecycle. Keep this
            // chain in-flight until failed/skipped/error-edge state is durable.
            await this.#failNode(ctx, node.id, (err as Error).message);
          } finally {
            ctx.inflightDispatches -= 1;
          }
          await this.#tick(ctx);
        });
    }

    // Settle: if no active executions, no in-flight dispatch chains, no
    // waiting inputs left to receive, and ready queue is empty, the run is
    // done. The inflightDispatches counter prevents settling mid-dispatch
    // for passthrough nodes (trigger/merge/router/scratchpad/extension_task)
    // which never register in activeExecutions.
    if (
      ctx.state.readyQueue.length === 0 &&
      Object.keys(ctx.state.activeExecutions).length === 0 &&
      ctx.inflightDispatches === 0
    ) {
      if (ctx.budgetHalt) {
        this.#skipBlockedNodes(ctx, 'Skipped: phase budget exceeded');
        await this.#transitionRunStatus(ctx, 'FAILED');
        this.#disposeRunState(ctx.runId);
      } else if (ctx.state.failedNodeIds.length > 0) {
        this.#skipBlockedNodes(ctx, 'Skipped because an upstream node failed');
        await this.#transitionRunStatus(ctx, 'FAILED');
        this.#disposeRunState(ctx.runId);
      } else {
        // A run is still waiting if a downstream node is blocked on inputs OR a
        // node is itself parked WAITING (a checkpoint/phase-gate/agent_session
        // yield). The latter matters when the parked node is terminal â€” there is
        // no downstream waitingInput to hold the run open, so without this check
        // a parked terminal session would wrongly settle to COMPLETED.
        const stillWaiting =
          Object.values(ctx.state.waitingInputs).some((b) => b.requiredInputs.length > 0) ||
          Object.values(ctx.state.nodeStates).some((n) => n.status === 'WAITING');
        if (!stillWaiting) {
          await this.#transitionRunStatus(ctx, 'COMPLETED');
          this.#disposeRunState(ctx.runId);
        } else {
          await this.#transitionRunStatus(ctx, 'WAITING');
        }
      }
    }
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Per-node dispatch
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  #dispatchReadiness(
    ctx: RunningContext,
    nodeId: string,
  ): { kind: 'ready' } | { kind: 'waiting'; buffer: WorkflowRunState['waitingInputs'][string] } | { kind: 'skipped'; reason: string } {
    const nodeState = ctx.state.nodeStates[nodeId];
    if (!nodeState) return { kind: 'skipped', reason: 'Skipped: node state is missing' };
    if (nodeState.status !== 'PENDING') {
      return { kind: 'skipped', reason: `Skipped: node is already ${nodeState.status.toLowerCase()}` };
    }

    const incoming = ctx.graph.edges.filter((edge) => edge.target === nodeId);
    if (incoming.length === 0) return { kind: 'ready' };

    const requiredInputs: string[] = [];
    const receivedInputs: Record<string, unknown> = {};
    const scratchpad = this.deps.scratchpad.snapshotOf(ctx.runId);
    let blockedByCondition = false;

    for (const edge of incoming) {
      const sourceState = ctx.state.nodeStates[edge.source];
      if (edge.type === 'error') {
        if (
          sourceState?.status === 'FAILED'
          || (sourceState?.status === 'COMPLETED' && Boolean(sourceState.error))
        ) {
          receivedInputs[edge.source] = sourceState.outputData ?? {};
        } else if (sourceState && sourceState.status !== 'COMPLETED' && sourceState.status !== 'SKIPPED') {
          requiredInputs.push(edge.source);
        }
        continue;
      }

      if (sourceState?.status === 'COMPLETED') {
        if (shouldTraverseEdge(edge, sourceState.outputData ?? {}, scratchpad)) {
          receivedInputs[edge.source] = sourceState.outputData ?? {};
        } else {
          blockedByCondition = true;
        }
        continue;
      }

      if (!sourceState || (sourceState.status !== 'FAILED' && sourceState.status !== 'SKIPPED')) {
        requiredInputs.push(edge.source);
      }
    }

    const buffer = {
      requiredInputs: [...new Set(requiredInputs)],
      receivedInputs,
      sourceNodeIds: [...new Set(incoming.map((edge) => edge.source))],
    };

    // Nothing can ever feed this node (every upstream skipped / branch untaken
    // and none delivered) — it's unreachable regardless of join policy.
    if (buffer.requiredInputs.length === 0 && Object.keys(receivedInputs).length === 0) {
      return {
        kind: 'skipped',
        reason: blockedByCondition
          ? 'Skipped: branch condition not met'
          : 'Skipped: upstream path never produced an input',
      };
    }

    // Apply the node's join policy. A `merge` node may declare an OR-join
    // ('any' — fire on the first arrival) or a subset-join (string[]); every
    // other kind uses the default AND-join. When already satisfied at first
    // evaluation (an upstream completed before this node was dequeued), go
    // straight to ready instead of parking in waitingInputs.
    const node = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (this.#joinSatisfied(ctx, node, buffer)) {
      return { kind: 'ready' };
    }

    return { kind: 'waiting', buffer };
  }

  /**
   * Decide whether a waiting node's join gate is satisfied. The default is an
   * AND-join ('all'): every required input must have arrived. A `merge` node may
   * instead declare:
   *   - 'any'    → OR-join: fire on the FIRST arriving input (race / first-wins).
   *   - string[] → subset-join: fire once the listed sources have all arrived,
   *                or once no further inputs can arrive (fire with what we have
   *                rather than hang). Sources outside the list don't gate.
   * Every node kind other than `merge` always uses the AND-join.
   */
  #joinSatisfied(
    ctx: RunningContext,
    node: WorkflowNode | undefined,
    buf: { requiredInputs: string[]; receivedInputs: Record<string, unknown> },
  ): boolean {
    const policy = this.#resolveJoinPolicy(ctx, node).requiredInputs;
    if (policy === 'any') {
      return Object.keys(buf.receivedInputs).length > 0;
    }
    if (Array.isArray(policy)) {
      if (policy.length > 0 && policy.every((src) => src in buf.receivedInputs)) return true;
      // No listed source can still arrive → don't block the run forever.
      return buf.requiredInputs.length === 0;
    }
    return buf.requiredInputs.length === 0;
  }

  /**
   * Resolve the effective join behaviour for a node. Only `merge` nodes carry a
   * policy; everything else uses the defaults. A `merge` is usually the point
   * where a `parallel` fan-out reconverges, so — without forcing the user to
   * duplicate config — the merge INHERITS its nearest upstream `parallel` node's
   * `waitFor` / `onBranchError` / `mergeStrategy`. The merge's own `requiredInputs`
   * (when set to something other than the default `'all'`) always wins for the
   * join COUNT; the parallel only fills in the gaps. This is what makes a
   * `parallel` node's settings actually do something instead of being inert
   * canvas decoration.
   */
  #resolveJoinPolicy(
    ctx: RunningContext,
    node: WorkflowNode | undefined,
  ): {
    requiredInputs: 'all' | 'any' | string[];
    mergeStrategy: 'merge_keys' | 'collect_all' | 'first_non_null';
    onError: 'fail' | 'continue';
  } {
    if (node?.config.kind !== 'merge') {
      return { requiredInputs: 'all', mergeStrategy: 'merge_keys', onError: 'fail' };
    }
    const mergeCfg = node.config as MergeNodeConfig;
    const parallel = this.#parallelForMerge(ctx, mergeCfg, node.id);
    const requiredInputs = mergeCfg.requiredInputs !== 'all'
      ? mergeCfg.requiredInputs
      : parallel?.waitFor === 'first'
        ? 'any'
        : 'all';
    return {
      requiredInputs,
      mergeStrategy: parallel?.mergeStrategy ?? 'merge_keys',
      onError: parallel?.onBranchError === 'continue_with_results' ? 'continue' : 'fail',
    };
  }

  /**
   * The `parallel` whose policy governs a merge: the explicitly-bound
   * `parallelSourceId` when it resolves to a parallel node, otherwise the
   * nearest upstream parallel (heuristic). Explicit binding removes the
   * ambiguity in diamond / nested fan-ins.
   */
  #parallelForMerge(ctx: RunningContext, mergeCfg: MergeNodeConfig, mergeNodeId: string): ParallelNodeConfig | undefined {
    if (mergeCfg.parallelSourceId) {
      const named = ctx.graph.nodes.find((n) => n.id === mergeCfg.parallelSourceId);
      if (named?.config.kind === 'parallel') return named.config as ParallelNodeConfig;
      // Bound but unresolvable (stale id / not a parallel) → fall back, don't break.
    }
    return this.#nearestUpstreamParallel(ctx, mergeNodeId);
  }

  /** Nearest `parallel` ancestor of a node (BFS backward through edges), if any. */
  #nearestUpstreamParallel(ctx: RunningContext, startId: string): ParallelNodeConfig | undefined {
    const visited = new Set<string>([startId]);
    let frontier = ctx.graph.edges.filter((e) => e.target === startId).map((e) => e.source);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (visited.has(id)) continue;
        visited.add(id);
        const n = ctx.graph.nodes.find((nn) => nn.id === id);
        if (n?.config.kind === 'parallel') return n.config as ParallelNodeConfig;
        for (const e of ctx.graph.edges) if (e.target === id) next.push(e.source);
      }
      frontier = next;
    }
    return undefined;
  }

  /**
   * Re-evaluate a waiting node's join gate after one of its incoming edges
   * resolved (delivered an input, was dropped as an untaken branch, or the
   * source was skipped). Promotes the node to the ready queue when its join
   * policy is satisfied, or skip-cascades it when it can never be fed. Replaces
   * the duplicated "if requiredInputs is empty" promote/skip blocks so the
   * non-default join policies ('any' / subset) are honored everywhere a buffer
   * is drained — and fixes the latent AND-join hang where a merge fed by both a
   * success edge and a (dropped) error edge could end up with no required inputs
   * left yet never get promoted.
   */
  #promoteOrSkipTarget(ctx: RunningContext, targetId: string, skipReason: string): void {
    const buf = ctx.state.waitingInputs[targetId];
    if (!buf) return;
    const node = ctx.graph.nodes.find((n) => n.id === targetId);
    if (this.#joinSatisfied(ctx, node, buf)) {
      if (Object.keys(buf.receivedInputs).length === 0) {
        // Satisfied only because nothing more can arrive, and nothing did.
        this.#skipUnreachable(ctx, targetId, skipReason);
        return;
      }
      ctx.state.readyQueue.push({
        nodeId: targetId,
        priority: 0,
        insertedAt: new Date().toISOString(),
        inputData: mergeBufferedInputs(buf, this.#resolveJoinPolicy(ctx, node).mergeStrategy),
      });
      delete ctx.state.waitingInputs[targetId];
      return;
    }
    // Still waiting on inputs that can yet arrive. Only when none can — and none
    // did — is the node unreachable.
    if (buf.requiredInputs.length === 0 && Object.keys(buf.receivedInputs).length === 0) {
      this.#skipUnreachable(ctx, targetId, skipReason);
    }
  }

  async #dispatchNode(
    ctx: RunningContext,
    node: WorkflowNode,
    item: ReadyQueueItem,
  ): Promise<void> {
    // Infinite-cycle backstop (masterplan 1.4): cap how many times any single
    // node may be dispatched in one run. An author-wired retry cycle, a runaway
    // self-heal/retry, or a planner-spliced loop could otherwise re-dispatch a
    // node without bound, burning unlimited LLM/IO cost. The ceiling is generous;
    // legit retries cap far lower. Hitting it fails the RUN (not a retryable node
    // failure) so it cannot itself re-enter the cycle.
    const dispatchCounts = this.#nodeDispatchCounts(ctx);
    const dispatchCount = (dispatchCounts.get(node.id) ?? 0) + 1;
    dispatchCounts.set(node.id, dispatchCount);
    const ceiling = nodeDispatchCeiling();
    if (dispatchCount > ceiling) {
      const ns = ctx.state.nodeStates[node.id];
      if (ns) {
        ns.status = 'FAILED';
        ns.error = `node dispatch ceiling exceeded (${ceiling}) — likely an infinite cycle`;
      }
      delete ctx.state.activeExecutions[node.id];
      this.deps.logger.warn('engine.node_dispatch_ceiling', { runId: ctx.runId, nodeId: node.id, count: dispatchCount, ceiling });
      await this.#transitionRunStatus(ctx, 'FAILED');
      return;
    }

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

    // NATIVE-ADVANCEMENT Proposal 4: pure node kinds (transform, filter, …) are
    // resolved by the handler registry instead of this switch. They re-read the
    // RAW config (not the template-resolved one) + the template context.
    const pureHandler = this.#nodeHandlers.get(node.config.kind);
    if (pureHandler) {
      const result = pureHandler.execute(node.config, { inputData: item.inputData, tctx });
      await this.#completeNode(ctx, node.id, result);
      return;
    }

    switch (node.config.kind) {
      case 'trigger': {
        // Triggers are pure pass-throughs at run time â€” they were the seed.
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
      case 'human_input': {
        await this.#executeHumanInput(ctx, node, resolvedConfig as HumanInputNodeConfig, item.inputData);
        return;
      }
      case 'extension_task': {
        const result = await this.#executeExtensionTask(ctx, node, resolvedConfig as ExtensionTaskNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'knowledge': {
        const result = await this.#executeKnowledgeNode(ctx, resolvedConfig as KnowledgeNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'knowledge_ingest': {
        const result = await this.#executeKnowledgeIngestNode(ctx, resolvedConfig as KnowledgeIngestNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'agent_task': {
        // SPECIALISTS-10X demand router: when the task names no concrete
        // specialist, score + select one (and record an explainable decision)
        // instead of silently dispatching a generic agent.
        const agentCfg = await this.#maybeRouteSpecialist(ctx, node, resolvedConfig as AgentTaskNodeConfig);
        // SMARTER-AGENTS-10X: a role/capability-resolved specialist runs as a
        // full persistent AgentSession by DEFAULT — working memory, sub-agent
        // delegation, and zero-cost yield/sleep — not a one-shot completion. This
        // is the autonomy unlock: agent_task and agent_session converge unless the
        // node opts out or an explicitly-bound agent owns its own runtime.
        if (this.#shouldRunAsSession(ctx, agentCfg)) {
          await this.#runAgentSession(ctx, node, agentTaskAsSession(agentCfg), item.inputData);
          return;
        }
        // Â§2.2 agentic tool-use loop: when the session runtime is unavailable (no
        // evaluation model wired), run in-process against the role-scoped tool
        // runtime and complete synchronously. Otherwise fall through to the
        // external-adapter dispatch (async completion).
        if (await this.#maybeRunAgentToolLoop(ctx, node, agentCfg, item.inputData)) return;
        await this.#dispatchAgentTask(ctx, node, agentCfg, item.inputData);
        return; // adapter event will call notifyTaskCompleted
      }
      case 'agent_session': {
        await this.#runAgentSession(ctx, node, resolvedConfig as AgentSessionNodeConfig, item.inputData);
        return; // session yields/completion resolve the node async
      }
      case 'dynamic_swarm': {
        await this.#runDynamicSwarm(ctx, node, resolvedConfig as DynamicSwarmNodeConfig, item.inputData);
        return;
      }
      case 'planner': {
        await this.#runPlanner(ctx, node, resolvedConfig as PlannerNodeConfig, item.inputData);
        return;
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
      // transform + filter are handled by the node handler registry above.
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
        const integrationConfig = resolvedConfig as IntegrationNodeConfig;
        const result = await this.#executeIntegration(ctx, node, integrationConfig, item.inputData);
        const receipt = buildIntegrationDeliveryReceipt(
          integrationConfig.integrationId,
          integrationConfig.operationId,
          integrationConfig.inputs ?? {},
        );
        if (receipt) {
          ctx.state.nodeStates[node.id]!.deliveryReceipt = {
            ...receipt,
            capturedAt: new Date().toISOString(),
          };
        }
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'mcp': {
        const result = await this.#executeMcp(ctx, node, resolvedConfig as McpNodeConfig);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'data_query': {
        const result = this.#executeDataQuery(ctx, resolvedConfig as DataQueryNodeConfig);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'data_mutate': {
        const result = this.#executeDataMutate(ctx, resolvedConfig as DataMutateNodeConfig);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'aggregate_window': {
        const result = this.#executeAggregateWindow(ctx, node, resolvedConfig as AggregateWindowNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'http_request': {
        const result = await this.#executeHttpRequest(ctx, node, resolvedConfig as HttpRequestNodeConfig, item.idempotencyKey);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'error_trigger': {
        // Entry node for error-handler workflows. At run time it is a pure
        // passthrough — the failure payload arrives as the run's seed inputs.
        await this.#completeNode(ctx, node.id, item.inputData);
        return;
      }
      case 'stop_error': {
        const cfg = resolvedConfig as StopErrorNodeConfig;
        throw new AgentisError('WORKFLOW_STOPPED', cfg.errorMessage || 'Workflow stopped by stop_error node', {
          details: cfg.errorCode ? { errorCode: cfg.errorCode } : undefined,
        });
      }
      case 'code': {
        const result = await this.#executeCode(ctx, node, resolvedConfig as CodeNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'spreadsheet': {
        const result = await this.#executeSpreadsheet(node, resolvedConfig as SpreadsheetNodeConfig, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'graphql': {
        const result = await this.#executeGraphQl(ctx, node, resolvedConfig as GraphQlNodeConfig);
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
      case 'converge': {
        await this.#dispatchConverge(ctx, node, resolvedConfig as ConvergeNodeConfig, item.inputData, tctx);
        return; // iterations resolve the node async
      }
      case 'parallel': {
        // Parallel is a pure passthrough at dispatch time — fan-out happens via
        // the regular edge mechanism (every outgoing edge fires concurrently).
        // The JOIN itself runs on the downstream `merge`, which INHERITS this
        // node's `waitFor` / `onBranchError` / `mergeStrategy` (see
        // `#resolveJoinPolicy` / `#nearestUpstreamParallel`): `waitFor: 'first'`
        // makes the merge an OR-join, `onBranchError: 'continue_with_results'`
        // absorbs a failed branch so the merge still produces survivor output,
        // and `mergeStrategy` controls how branch outputs are combined.
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

  async #executeExtensionTask(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ExtensionTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const extensionInput = mapInputs(config.inputMapping, inputData, ctx.scratchpad?.snapshot ?? {});
    const result = await this.deps.extensions.execute({
      workspaceId: ctx.workspaceId,
      extensionId: config.extensionId,
      extensionSlug: config.extensionSlug,
      operationName: config.operationName,
      version: config.version,
      runId: ctx.runId,
      taskId: node.id,
      input: extensionInput,
      scratchpadSnapshot: ctx.scratchpad?.snapshot ?? {},
    });

    if (!result.ok) {
      throw new AgentisError(
        result.errorCode === 'EXTENSION_TIMEOUT' ? 'EXTENSION_TIMEOUT' : 'INTERNAL_ERROR',
        `Extension ${config.extensionId ?? config.extensionSlug ?? node.id} failed: ${result.message}`,
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
      : this.deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId, { scopeId: ctx.workflowId, includeWorkspace: true });
    const perBaseTopK = config.knowledgeBaseId ? topK : Math.max(topK, 5);

    const batches = await Promise.all(bases
      .map(async (base) => (await this.deps.knowledgeBases!.search({
        workspaceId: ctx.workspaceId,
        knowledgeBaseId: base.id,
        query,
        topK: perBaseTopK,
        retrievalMode: config.retrievalMode ?? 'contextual',
      })).map((hit) => ({
        ...hit,
        knowledgeBaseId: base.id,
        knowledgeBaseName: base.name,
      }))));
    const results = batches
      .flat()
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
   * knowledge_ingest — write-side twin of `knowledge`. Routes upstream content
   * into the same `KnowledgeBaseService` the retrieval node reads from, so a
   * workflow's output becomes recallable by future agents and `knowledge` nodes.
   * No bespoke ingestion logic: it delegates to `addDocument`, the same path the
   * Brain UI uses.
   */
  async #executeKnowledgeIngestNode(
    ctx: RunningContext,
    config: KnowledgeIngestNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.knowledgeBases) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'knowledge_ingest node present but KnowledgeBaseService not wired');
    }

    const content = stringifyKnowledgeContent(
      config.contentPath ? lookupPath(inputData, config.contentPath) : (config.content ?? inputData),
    ).trim();
    if (!content) throw new AgentisError('VALIDATION_FAILED', 'knowledge_ingest node has no content to store');

    const nameValue = config.documentNamePath
      ? lookupPath(inputData, config.documentNamePath)
      : config.documentName;
    const name = (typeof nameValue === 'string' && nameValue.trim())
      ? nameValue.trim()
      : `Workflow ${ctx.workflowId} — ${new Date().toISOString()}`;

    // Resolve a target base without friction: explicit id → first existing → create one.
    let knowledgeBaseId = config.knowledgeBaseId;
    if (knowledgeBaseId) {
      this.deps.knowledgeBases.getKnowledgeBase(ctx.workspaceId, knowledgeBaseId);
    } else {
      const existing = this.deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId, { scopeId: ctx.workflowId });
      const workflow = this.deps.db.select({ title: schema.workflows.title })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, ctx.workspaceId), eq(schema.workflows.id, ctx.workflowId)))
        .get();
      knowledgeBaseId = existing[0]?.id
        ?? this.deps.knowledgeBases.createKnowledgeBase({
          workspaceId: ctx.workspaceId,
          scopeId: ctx.workflowId,
          name: config.knowledgeBaseName?.trim() || workflow?.title?.trim() || 'Workflow Knowledge',
        }).id;
    }

    const document = await this.deps.knowledgeBases.addDocument({
      workspaceId: ctx.workspaceId,
      knowledgeBaseId,
      name,
      mimeType: config.mimeType,
      content,
    });

    return {
      knowledgeBaseId,
      documentId: document.id,
      name: document.name,
      chunks: document.chunks,
      mimeType: document.mimeType,
      status: document.status,
    };
  }

  /**
   * §2.2 agentic tool-use loop — now the DEFAULT execution for `agent_task`.
   *
   * Any agent task whose specialist has a tool manifest (platform role tools, or
   * the universal default toolbox for custom/generated roles) runs a bounded
   * think→act→observe loop in-process against the role-scoped, manifest-enforced
   * tool runtime, completing the node synchronously while STREAMING its reasoning
   * and tool calls into the run activity spine. This is what turns a specialist
   * from a single fire-and-forget completion into a real, tool-using agent.
   *
   * Returns false (→ single external-adapter dispatch) only when: the workspace
   * has no tool runtime / evaluation model wired, the task explicitly opts out
   * (`useRoleTools: false` — for a pure one-shot transform), or the resolved
   * specialist genuinely has no tools.
   *
   * Agentic harness adapters (marker_protocol, mcp_native, session_event) keep
   * their own loop; the platform loop upgrades inherited/toolless runtimes.
   */
  /**
   * When an `agent_task` is underspecified (no explicit agent and only a generic
   * role), consult the SpecialistDemandRouter for a scored, explainable role
   * selection instead of falling back to a bare `specialist`. Records the
   * decision as a conversation-theater event so the operator sees WHY this
   * specialist was chosen. No-op when the router is unwired or the task already
   * names a concrete specialist.
   */
  async #maybeRouteSpecialist(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
  ): Promise<AgentTaskNodeConfig> {
    // Manager-owned org structure: a workflow owned by a specialist (or belonging
    // to a subdomain that specialist runs) auto-dispatches its unpinned tasks to
    // that specialist — deterministic, and independent of the demand router. The
    // manager fallback ('domain') is NOT applied here: a manager delegates, it
    // doesn't execute the leaf task.
    if (!config.agentId && ctx.workflowId) {
      const responsible = resolveResponsibleSpecialist(this.deps.db, ctx.workspaceId, { workflowId: ctx.workflowId });
      if (responsible && responsible.via !== 'domain' && this.#agentHasConnectedRuntime(responsible.agentId)) {
        this.deps.activity.record({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
          userId: ctx.userId,
          eventType: 'specialist.routed',
          actorType: 'system',
          actorId: 'responsibility',
          entityType: 'run',
          entityId: ctx.runId,
          summary: `Routed to the specialist responsible for this workflow (${responsible.via}).`,
          metadata: { runId: ctx.runId, nodeId: node.id, agentId: responsible.agentId, via: responsible.via },
        });
        return { ...config, agentId: responsible.agentId };
      }
    }
    if (!this.deps.specialistRouter || config.agentId) return config;
    const GENERIC_ROLES = new Set(['specialist', 'agent', 'worker', '']);
    const hasConcreteRole = config.agentRole
      && isAgentRole(config.agentRole)
      && !GENERIC_ROLES.has(normalizeRole(config.agentRole));
    if (hasConcreteRole) return config;
    const task = `${node.title}\n${config.prompt ?? ''}`.trim();
    if (!task) return config;
    try {
      const decision = await this.deps.specialistRouter.request(ctx.workspaceId, ctx.userId, {
        task,
        callerAgentId: null,
        workflowId: ctx.workflowId,
        runId: ctx.runId,
        materialize: true,
        createRun: false,
      });
      if (!decision.selectedRole) return config;
      this.deps.activity.record({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        eventType: 'specialist.routed',
        actorType: 'system',
        actorId: 'router',
        entityType: 'run',
        entityId: ctx.runId,
        summary: decision.explanation,
        metadata: {
          runId: ctx.runId,
          nodeId: node.id,
          role: decision.selectedRole,
          topology: decision.topology,
          score: decision.score,
          traceId: decision.traceId,
        },
      });
      return { ...config, agentRole: decision.selectedRole as AgentRole };
    } catch (err) {
      this.deps.logger.warn('specialist.route_failed', {
        runId: ctx.runId,
        nodeId: node.id,
        error: (err as Error).message,
      });
      return config;
    }
  }

  /**
   * Decide whether an `agent_task` should run as a full persistent AgentSession
   * (the SMARTER-AGENTS-10X default) rather than a bounded tool loop / one-shot
   * dispatch. A session gives the specialist working memory, sub-agent
   * delegation, and yield/sleep — the autonomy the platform promises.
   *
   * Defaults ON when the session runtime is wired, UNLESS:
   *  - the node explicitly opts out (`useSession:false` or `useRoleTools:false`,
   *    for a deterministic one-shot transform), or
   *  - an explicit `agentId` is bound to a connected runtime (its own adapter or
   *    CLI harness owns the loop — never downgrade it to the shared session LLM).
   */
  #shouldRunAsSession(ctx: RunningContext, config: AgentTaskNodeConfig): boolean {
    if (!this.deps.sessions || !this.deps.sessionRuntime) return false;
    // A session needs a resolvable model for this workspace (Settings → env →
    // first connected agent). With none, degrade cleanly to the tool loop /
    // single-shot dispatch rather than failing the node at its first step.
    if (!this.deps.sessionRuntime.canRun(ctx.workspaceId)) return false;
    if (config.useSession === true) return true;
    if (config.useSession === false) return false;
    if (config.useRoleTools === false) return false;
    if (config.agentId && this.#agentHasConnectedRuntime(config.agentId)) return false;
    return true;
  }

  async #maybeRunAgentToolLoop(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<boolean> {
    // Explicit opt-out for a deterministic one-shot transform task.
    if (config.useRoleTools === false) return false;
    // The loop needs a structured-LLM (evaluation role) + the tool runtime. When
    // unwired (e.g. minimal test engines), fall through to single-shot dispatch.
    const toolLoopLlm = this.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'evaluation', { task: config.prompt, purpose: 'agent_tool_loop' }) ?? this.deps.evaluatorRuntime;
    if (!this.deps.agentTools || !toolLoopLlm) return false;

    const resolved = this.#resolveAgentForToolLoop(ctx, config);
    if (!resolved) return false;
    const { agentId, role } = resolved;

    // Defer to an agentic CLI harness (Codex / Claude Code) bound to this agent: it
    // runs its OWN superior tool loop via dispatch. The in-engine loop exists to fix
    // the single-completion *inherited* runtime (the toolless default) — never to
    // downgrade an agent deliberately bound to a powerful coding harness.
    const boundForwarding = agentId
      ? this.deps.adapters.get(agentId)?.adapter.capabilities?.().toolForwarding
      : undefined;
    if (boundForwarding === 'mcp_native' || boundForwarding === 'marker_protocol') return false;

    const def = this.#specialistDef(ctx, role);
    const tools = effectiveSpecialistTools(def);
    if (tools.length === 0) return false;

    // Conversation theater: the work hand-off (workflow → specialist) on the loop
    // path too, so collaboration is recorded regardless of execution path.
    this.#recordSpecialistAssignment(ctx, node, agentId, config.prompt);

    const preambleResult = await this.#withWorkspaceContext(ctx, '', def.systemPrompt, '', agentId);
    const preamble = preambleResult.prompt;
    const inputBlock = Object.keys(inputData).length > 0 ? `\n\nINPUT:\n${safeJson(inputData)}` : '';

    // Phase 2/3A/4 — dynamic capability surface. Bridged MCP tools (computer-use,
    // browser, any operator-mounted server) are offered alongside the static
    // manifest, and the bound runtime's native affordances are surfaced so the
    // agent knows its real powers instead of describing what it would do.
    const extraTools = (await this.deps.agentTools.listBridgedTools(ctx.workspaceId)).map((spec) => ({
      id: spec.id,
      description: spec.provides ? `${spec.description} [grants ${spec.provides}]` : spec.description,
    }));
    const liveAffordances = agentId ? this.deps.adapters.capabilities(agentId)?.affordances ?? {} : {};
    const runtimeAffordances = (Object.keys(liveAffordances) as AgentAffordance[])
      .filter((key) => liveAffordances[key] === true)
      .map(affordanceLabel);

    const loop = new AgentToolLoop({
      runtime: this.deps.agentTools,
      llm: toolLoopLlm,
      logger: this.deps.logger,
    });
    const result = await loop.run({
      workspaceId: ctx.workspaceId,
      role,
      task: `${config.prompt}${agentOutputContractPrompt(config.outputKeys)}${inputBlock}`,
      systemPreamble: preamble,
      tools,
      ...(extraTools.length > 0 ? { extraTools } : {}),
      ...(runtimeAffordances.length > 0 ? { runtimeAffordances } : {}),
      maxSteps: config.maxToolSteps,
      workflowId: ctx.workflowId,
      agentId,
      // Stream the agent's live reasoning + tool use into the run room (the
      // immersive monitor/triage/canvas all read this), correctly attributed to
      // this node via taskId=node.id.
      onStep: (step) => {
        if (step.phase === 'thinking' && step.thought) {
          this.notifyAgentActivity({ runId: ctx.runId, agentId, taskId: node.id, kind: 'thinking', text: step.thought });
        } else if (step.phase === 'tool_call' && step.tool) {
          this.notifyAgentActivity({ runId: ctx.runId, agentId, taskId: node.id, kind: 'tool_call', tool: step.tool, toolInput: step.args });
        } else if (step.phase === 'tool_result' && step.tool) {
          this.notifyAgentActivity({ runId: ctx.runId, agentId, taskId: node.id, kind: 'tool_result', tool: step.tool, toolResult: step.error ? { error: step.error } : step.observation });
        }
      },
      ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
    });

    if (ctx.abortController?.signal.aborted || ctx.state.status === 'CANCELLED') return true;

    if (result.error && (result.stoppedReason === 'no_decision' || !result.output)) {
      // Recoverable (out-of-credits) errors pause; everything else fails honestly.
      await this.#failNode(ctx, node.id, result.error);
      return true;
    }

    this.#audit(ctx, {
      nodeId: node.id,
      action: 'agent.tool_loop',
      actorType: 'agent',
      actorId: role,
      outputSummary: `${result.stoppedReason}: ${result.toolCalls} tool call(s)`,
    });
    const output = {
      output: result.output,
      toolCalls: result.toolCalls,
      steps: result.steps.length,
      stoppedReason: result.stoppedReason,
    };
    this.#recordSpecialistResult(ctx, node, agentId, output);
    await this.#completeNode(ctx, node.id, output);
    return true;
  }

  /** Resolve the identity the platform tool loop should run as, or defer. */
  #resolveAgentForToolLoop(
    ctx: RunningContext,
    config: AgentTaskNodeConfig,
  ): { agentId?: string; role: AgentRole } | null {
    if (!this.#toolLoopSatisfiesRequirements(config.requires)) return null;

    const validRole = config.agentRole && isAgentRole(config.agentRole) ? config.agentRole : undefined;
    const roleForAgent = (agentId?: string): AgentRole => {
      return (validRole ?? normalizeRole(this.#agentRole(agentId) ?? 'specialist')) as AgentRole;
    };
    const shouldDeferToAdapter = (agentId?: string): boolean => {
      return Boolean(
        agentId
          && this.#agentHasOwnAgenticRuntime(agentId)
          && this.#agentSatisfiesRequirements(agentId, config.requires),
      );
    };

    if (config.agentId) {
      if (shouldDeferToAdapter(config.agentId)) return null;
      return { agentId: config.agentId, role: roleForAgent(config.agentId) };
    }

    if (validRole && this.deps.specialists) {
      const agentId = this.deps.specialists.ensureRole(ctx.workspaceId, ctx.userId, validRole);
      if (shouldDeferToAdapter(agentId)) return null;
      return { agentId, role: validRole };
    }

    const fallback = this.#resolveConnectedFallbackAgent(
      ctx.workspaceId,
      config.capabilityTags ?? [],
      config.requires,
      validRole,
    );
    if (fallback) {
      if (shouldDeferToAdapter(fallback)) return null;
      return { agentId: fallback, role: roleForAgent(fallback) };
    }

    return { role: (validRole ?? 'specialist') as AgentRole };
  }

  /** Conversation-theater: record a workflow -> specialist work hand-off. */
  #recordSpecialistAssignment(ctx: RunningContext, node: WorkflowNode, agentId: string | undefined, instruction?: string): void {
    this.deps.activity.record({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      eventType: 'agent.task_assigned',
      actorType: 'agent',
      actorId: agentId ?? null,
      entityType: 'run',
      entityId: ctx.runId,
      summary: `${this.#agentName(agentId) ?? 'Specialist'} ← “${node.title}”`,
      metadata: { runId: ctx.runId, workflowId: ctx.workflowId, nodeId: node.id, instruction: instruction?.slice(0, 400) },
    });
  }

  /** Conversation-theater: record a specialist → workflow result. */
  #recordSpecialistResult(ctx: RunningContext, node: WorkflowNode, agentId: string | undefined, output: Record<string, unknown>): void {
    this.deps.activity.record({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      eventType: 'agent.task_completed',
      actorType: 'agent',
      actorId: agentId ?? null,
      entityType: 'run',
      entityId: ctx.runId,
      summary: `${this.#agentName(agentId) ?? 'Specialist'} → finished “${node.title}”`,
      metadata: { runId: ctx.runId, workflowId: ctx.workflowId, nodeId: node.id, outputPreview: safeJson(output).slice(0, 300) },
    });
  }

  /** Resolve an agent's functional role slug from the DB. */
  #agentRole(agentId: string | null | undefined): string | undefined {
    if (!agentId) return undefined;
    return this.deps.db
      .select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.role ?? undefined;
  }

  #findAgentByRole(workspaceId: string, role: string): string | null {
    return this.deps.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, role)))
      .get()?.id ?? null;
  }

  /**
   * Registry-aware specialist resolution for system-prompt injection. Resolves
   * a role string to a full definition without ever throwing: built-in platform
   * role → workspace agent library (custom/generated) → synthesized generic
   * specialist. This is what lets a workflow reference a custom `agentRole`
   * (e.g. `frontend_architect`) and still get a coherent persona at dispatch.
   */
  #specialistDef(ctx: RunningContext, role: AgentRole): SpecialistDefinition {
    return (
      this.deps.specialists?.defForRole(ctx.workspaceId, role)
      ?? specialistForRole(role, null)
      ?? genericSpecialist(role)
    );
  }

  async #dispatchAgentTask(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    if (config.agentId && !this.deps.adapters.get(config.agentId)) {
      const runtimePin = stringValue(config.modelOverride) ?? this.#agentConfiguredModel(config.agentId);
      const runtime = this.deps.resolveAgentRuntime?.(ctx.workspaceId, config.agentId, config.prompt, runtimePin);
      if (runtime) {
        this.deps.adapters.register(config.agentId, runtime);
        this.deps.logger.info('engine.agent_task.runtime_bound', { runId: ctx.runId, agentId: config.agentId, nodeId: node.id, phase: 'pre_resolve' });
      }
    }
    const resolved = this.#resolveAgentForNode(ctx, {
      explicitAgentId: config.agentId,
      role: config.agentRole,
      capabilityTags: config.capabilityTags,
      requires: config.requires,
      label: `agent_task node ${node.id}`,
    });
    const agentId = resolved.agentId;
    const rolePrompt = resolved.role ? this.#specialistDef(ctx, resolved.role).systemPrompt : undefined;
    // The task id MUST be the node id: adapters echo `task.taskId` on completion and
    // the bridge maps it straight back to the node (bootstrap: "taskId carries node
    // binding in V1"). A random uuid here silently broke completion mapping — the
    // model would run but the node would hang RUNNING forever because
    // notifyTaskCompleted({ nodeId: <uuid> }) never matched a real node.
    const taskId = node.id;
    ctx.state.activeExecutions[node.id] = {
      taskId,
      nodeId: node.id,
      executorType: 'agent',
      executorRef: agentId,
      startedAt: new Date().toISOString(),
    };

    // Compose the system preamble: role identity (Layer 2) â†’ workspace context
    // (Layer 1) â†’ agent memory (Â§G11) â†’ the task
    // prompt. No agent call starts from zero (Principle #2).
    const contextResult = await this.#withWorkspaceContext(
      ctx,
      `${config.prompt}${agentOutputContractPrompt(config.outputKeys)}`,
      rolePrompt,
      '',
      agentId,
    );
    const prompt = contextResult.prompt;

    // LAYER 0: ensure the agent has a working brain. Specialists are minted
    // `offline` with no adapter; without this, dispatch hits a dead http stub and
    // the node hangs with zero model consumption. Lazily bind the workspace's
    // default model runtime (bound to this agent id) so the task actually runs and
    // streams real thoughts. Registered once — its events flow through the normal
    // AdapterManager → engine pipeline.
    if (!this.deps.adapters.get(agentId)) {
      const runtimePin = stringValue(config.modelOverride) ?? this.#agentConfiguredModel(agentId);
      const runtime = this.deps.resolveAgentRuntime?.(ctx.workspaceId, agentId, config.prompt, runtimePin);
      if (runtime) {
        this.deps.adapters.register(agentId, runtime);
        this.deps.logger.info('engine.agent_task.runtime_bound', { runId: ctx.runId, agentId, nodeId: node.id });
      }
    }

    // CONVERSATION THEATER: record the work hand-off (workflow → specialist).
    this.#recordSpecialistAssignment(ctx, node, agentId, config.prompt);

    const routing = this.#routeAgentTaskModel(ctx, agentId, config, contextResult.preferredModel);
    const preferredModel = routing.selectedModel ?? contextResult.preferredModel;
    this.deps.logger.info('engine.agent_task.model_routed', {
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      nodeId: node.id,
      agentId,
      taskClass: routing.taskClass,
      selectedModel: routing.selectedModel,
      modelTier: routing.modelTier,
      explicitPin: routing.explicitPin,
      reason: routing.reason,
      alternatives: routing.alternatives.slice(0, 4),
    });

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
      abilities: contextResult.abilities,
      abilityEnv: contextResult.abilityEnv,
      preferredModel,
      // Run-scoped cancellation: Stop aborts this so the in-flight model call ends.
      ...(ctx.abortController ? { signal: ctx.abortController.signal } : {}),
    }, agentId);
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Persistent agent sessions (SMARTER-AGENTS-10X Â§VIâ€“IX)
  //
  // An `agent_session` node is a parallel execution path to `agent_task`. The
  // engine owns orchestration: it seeds a DB-backed session, drives the
  // cognitive loop via AgentSessionRuntime, and on a YIELD parks the session
  // (the node leaves `activeExecutions`, its nodeState goes WAITING, the run
  // settles to WAITING like a checkpoint). Wake signals â€” a fired event, an
  // elapsed timer, an approval decision â€” re-open the node and re-advance.
  // Delegation is resolved synchronously inline (bounded by
  // SESSION_MAX_DELEGATION_DEPTH) so it never needs cross-tick parking.
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  #routeAgentTaskModel(
    ctx: RunningContext,
    agentId: string,
    config: AgentTaskNodeConfig,
    contextPreferredModel: string | null,
  ) {
    const row = this.deps.db
      .select({
        adapterType: schema.agents.adapterType,
        runtimeModel: schema.agents.runtimeModel,
        config: schema.agents.config,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .get();
    const registration = this.deps.adapters.get(agentId);
    const explicitNodeModel = stringValue(config.modelOverride);
    const explicitAgentModel = agentConfiguredModel(row);
    const runtime = registration?.adapter.adapterType ?? row?.adapterType ?? null;
    return routeModelForTask({
      task: config.prompt,
      purpose: 'agent_task',
      runtime,
      explicitModel: explicitNodeModel ?? explicitAgentModel,
      currentModel: contextPreferredModel,
      candidateModels: contextPreferredModel ? [{ model: contextPreferredModel, runtime, source: 'agent_config' }] : [],
      requiredAffordances: [
        ...(config.capabilityTags ?? []),
        ...(config.requires ? requiredAffordanceKeys(config.requires) : []),
      ].map(String),
    });
  }

  #agentConfiguredModel(agentId: string): string | null {
    const row = this.deps.db
      .select({ runtimeModel: schema.agents.runtimeModel, config: schema.agents.config })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .get();
    return agentConfiguredModel(row);
  }

  async #runAgentSession(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentSessionNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.sessions || !this.deps.sessionRuntime) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `agent_session node ${node.id} present but session runtime not wired`);
    }
    const { agentId, role } = this.#resolveSessionAgent(ctx, config.agentId, config.agentRole, config.capabilityTags, config.requires, node.id);
    const persona = config.persona || (role ? this.#specialistDef(ctx, role).systemPrompt : '');
    const runContextResult = await this.#withWorkspaceContext(ctx, config.prompt, undefined, '', agentId);
    const runContextBlock = runContextResult.prompt;
    const scoped = config.inputKeys.length > 0 ? pickKeys(inputData, config.inputKeys) : inputData;
    const promptWithContract = `${config.prompt}${agentOutputContractPrompt(config.outputKeys)}`;
    const taskBlock = Object.keys(scoped).length > 0
      ? `${promptWithContract}\n\nINPUT:\n${safeJson(scoped)}`
      : promptWithContract;
    // (runId, nodeId)-keyed so a woken node reuses its persistent identity.
    const session = this.deps.sessions.getOrCreate({
      agentId,
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      nodeId: node.id,
      personaBlock: persona,
      taskBlock,
    });
    const runCtx: SessionRunContext = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: ctx.runId,
      nodeId: node.id,
      agentId,
      workflowId: ctx.workflowId,
      planId: ctx.planId,
      role,
      runContextBlock,
      maxSteps: config.maxSteps,
    };
    if (ctx.planId && this.deps.plans) {
      this.deps.plans.bindSession(ctx.workspaceId, ctx.userId, ctx.planId, session.id);
    }
    this.#openSession(ctx, node, session.id);
    void this.#driveSession(ctx, node, session.id, runCtx);
  }

  /** Hold the session node open with a synthetic active execution. */
  #openSession(ctx: RunningContext, node: WorkflowNode, sessionId: string): void {
    ctx.state.activeExecutions[node.id] = {
      taskId: `session:${node.id}`,
      nodeId: node.id,
      executorType: 'session',
      executorRef: sessionId,
      startedAt: new Date().toISOString(),
    };
  }

  /** Drive a session to its next non-delegate outcome, then resolve the node. */
  async #driveSession(ctx: RunningContext, node: WorkflowNode, sessionId: string, runCtx: SessionRunContext): Promise<void> {
    try {
      const outcome = await this.#advanceSessionLoop(ctx, node, sessionId, runCtx);
      await this.#onSessionOutcome(ctx, node, sessionId, runCtx, outcome);
    } catch (err) {
      this.deps.sessions?.fail(sessionId, (err as Error).message);
      await this.#failNode(ctx, node.id, (err as Error).message);
      void this.#tick(ctx);
    }
  }

  /**
   * Advance the session, resolving any `delegate` yields synchronously inline
   * (a nested session advanced to terminal, its result injected as the tool
   * response). Returns the first non-delegate outcome.
   */
  async #advanceSessionLoop(ctx: RunningContext, node: WorkflowNode, sessionId: string, runCtx: SessionRunContext): Promise<SessionOutcome> {
    let outcome = await this.deps.sessionRuntime!.advance(sessionId, runCtx);
    while (outcome.kind === 'suspended' && (outcome.yield.kind === 'delegate' || outcome.yield.kind === 'delegate_team')) {
      const y = outcome.yield;
      const payload = y.kind === 'delegate'
        ? await this.#runDelegate(ctx, node, sessionId, runCtx, y)
        : await this.#runDelegateTeam(ctx, node, sessionId, runCtx, y);
      this.deps.sessionRuntime!.injectWake(sessionId, y.toolCallId, payload);
      outcome = await this.deps.sessionRuntime!.advance(sessionId, runCtx);
    }
    return outcome;
  }

  /**
   * W3 — run a TEAM of delegates in PARALLEL, await all, and return the array of
   * results for the parent to synthesize. Each member reuses #runDelegate (depth
   * guard, grant attenuation, on-demand specialist creation all apply per member).
   */
  async #runDelegateTeam(
    ctx: RunningContext,
    node: WorkflowNode,
    parentSessionId: string,
    parentRunCtx: SessionRunContext,
    y: Extract<SessionYield, { kind: 'delegate_team' }>,
  ): Promise<unknown> {
    const results = await Promise.all(
      y.members.map(async (m, index) => {
        const single: Extract<SessionYield, { kind: 'delegate' }> = { kind: 'delegate', toolCallId: `${y.toolCallId}::${index}`, ...m };
        const result = await this.#runDelegate(ctx, node, parentSessionId, parentRunCtx, single);
        return { role: m.role, ...(result as Record<string, unknown>) };
      }),
    );
    return { ok: true, team: results };
  }

  /** Run a delegated subtask as a child session, synchronously, to terminal. */
  async #runDelegate(
    ctx: RunningContext,
    node: WorkflowNode,
    parentSessionId: string,
    parentRunCtx: SessionRunContext,
    y: Extract<SessionYield, { kind: 'delegate' }>,
  ): Promise<unknown> {
    const parent = this.deps.sessions!.get(parentSessionId);
    const depth = (parent?.delegationDepth ?? 0) + 1;
    if (depth > CONSTANTS.SESSION_MAX_DELEGATION_DEPTH) {
      return { ok: false, error: `delegation depth limit (${CONSTANTS.SESSION_MAX_DELEGATION_DEPTH}) reached â€” handle this subtask yourself` };
    }
    const resolved = await this.#resolveDelegateAgent(ctx, node, parentRunCtx.agentId, y);
    if (!resolved) {
      return { ok: false, error: `no agent available for role '${y.role}'. Create it first or pass create_if_missing/temporary.` };
    }
    const { agentId } = resolved;
    const child = this.deps.sessions!.create({
      agentId,
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      nodeId: `${node.id}::delegate::${y.toolCallId}`,
      personaBlock: this.#specialistDef(ctx, y.role).systemPrompt,
      taskBlock: y.task,
      parentSessionId,
      delegationDepth: depth,
    });
    // CONVERSATION THEATER: one agent handing a sub-task to another (A2A delegation).
    const fromAgentId = parent?.agentId;
    this.deps.activity.record({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      eventType: 'agent.delegated',
      actorType: 'agent',
      actorId: fromAgentId ?? agentId,
      entityType: 'run',
      entityId: ctx.runId,
      summary: `${this.#agentName(fromAgentId) ?? 'Agent'} → ${this.#agentName(agentId) ?? y.role}: ${y.task.slice(0, 120)}`,
      metadata: {
        runId: ctx.runId,
        fromAgentId,
        toAgentId: agentId,
        role: y.role,
        task: y.task.slice(0, 400),
        ...(resolved.created ? { created: true } : {}),
        ...(resolved.instanceId ? { specialistInstanceId: resolved.instanceId, temporary: Boolean(y.temporary) } : {}),
      },
    });
    // Attenuate the parent's delegation scope against what it granted this
    // delegate (§8). The child can only ever narrow — never widen — its parent's
    // tool scope. A top-level session with no grant + no request stays
    // unrestricted, preserving existing behavior.
    const grant = attenuateGrant(parentRunCtx.grant, { tools: y.allowedTools, paths: y.allowedPaths, maxTokens: y.maxTokens }, depth);
    const childRunContext = await this.#withWorkspaceContext(ctx, y.task, undefined, '', agentId);
    const childCtx: SessionRunContext = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: ctx.runId,
      nodeId: node.id,
      agentId,
      workflowId: ctx.workflowId,
      planId: parentRunCtx.planId ?? ctx.planId,
      role: y.role,
      runContextBlock: childRunContext.prompt,
      ...(grant ? { grant } : {}),
    };
    const outcome = await this.#advanceSessionLoop(ctx, node, child.id, childCtx);
    if (outcome.kind === 'completed' || outcome.kind === 'max_steps') return { ok: true, result: outcome.output };
    if (outcome.kind === 'failed') return { ok: false, error: outcome.error };
    // A delegated child cannot park (no cross-tick wake path for sub-sessions).
    return { ok: false, error: 'delegated sub-agent attempted a non-delegate yield (await/sleep/approval), which is unsupported inside synchronous delegation' };
  }

  async #resolveDelegateAgent(
    ctx: RunningContext,
    node: WorkflowNode,
    parentAgentId: string,
    y: Extract<SessionYield, { kind: 'delegate' }>,
  ): Promise<{ agentId: string; created?: boolean; instanceId?: string } | null> {
    const role = normalizeRole(y.role);
    let agentId = this.deps.specialists?.resolveRole(ctx.workspaceId, role) ?? this.#findAgentByRole(ctx.workspaceId, role);
    let created = false;
    let def: SpecialistDefinition | null = null;

    if (!agentId && (y.createIfMissing || y.temporary)) {
      if (!this.deps.specialists) return null;
      const authored = await this.deps.specialists.authorSpecialist(ctx.workspaceId, ctx.userId, {
        role,
        name: y.name,
        description: `Specialist delegated from workflow node "${node.title || node.id}".`,
        instructions: y.instructions ?? y.task,
        source: 'generated',
      });
      agentId = authored.agentId;
      created = authored.created;
      def = authored.def;
    }

    if (!agentId) return null;

    def ??= this.#specialistDef(ctx, role);
    const profile = this.deps.specialistProfiles?.ensureFromDef(ctx.workspaceId, def, ctx.userId);
    const leaseMinutes = y.temporary ? Math.max(1, Math.min(y.leaseMinutes ?? 60, 24 * 60)) : undefined;
    const instanceId = this.deps.specialistRuntime?.ensureInstance({
      workspaceId: ctx.workspaceId,
      role,
      agentId,
      profileId: profile?.id ?? null,
      mode: y.temporary ? 'ephemeral' : 'durable',
      parentAgentId,
      reportsTo: parentAgentId,
      leaseExpiresAt: leaseMinutes ? new Date(Date.now() + leaseMinutes * 60_000).toISOString() : null,
    });

    return { agentId, ...(created ? { created } : {}), ...(instanceId ? { instanceId } : {}) };
  }

  async #onSessionOutcome(
    ctx: RunningContext,
    node: WorkflowNode,
    sessionId: string,
    runCtx: SessionRunContext,
    outcome: SessionOutcome,
  ): Promise<void> {
    switch (outcome.kind) {
      case 'completed':
      case 'max_steps':
        {
          const completedOutput = await this.#completeNode(ctx, node.id, outcome.output);
          if (!completedOutput) return;
          this.#enqueueSuccessfulBrainCapture(ctx, node.id, completedOutput, runCtx.agentId);
        }
        void this.#tick(ctx);
        return;
      case 'failed':
        await this.#failNode(ctx, node.id, outcome.error);
        void this.#tick(ctx);
        return;
      case 'suspended':
        await this.#parkSession(ctx, node, sessionId, runCtx, outcome.yield);
        return;
    }
  }

  /**
   * Park a yielded session: release the node (so the run settles to WAITING,
   * mirroring the checkpoint gate) and register the wake condition. Delegation
   * never reaches here â€” it is resolved inline by #advanceSessionLoop.
   */
  async #parkSession(ctx: RunningContext, node: WorkflowNode, sessionId: string, runCtx: SessionRunContext, y: SessionYield): Promise<void> {
    delete ctx.state.activeExecutions[node.id];
    const ns = ctx.state.nodeStates[node.id];
    if (ns) ns.status = 'WAITING';

    switch (y.kind) {
      case 'await_event': {
        const list = this.#sessionWaiters(ctx).get(y.event) ?? [];
        list.push({ sessionId, nodeId: node.id, toolCallId: y.toolCallId, runCtx });
        this.#sessionWaiters(ctx).set(y.event, list);
        break;
      }
      case 'sleep_until': {
        const remaining = Math.max(0, Date.parse(y.untilIso) - Date.now());
        const timer = setTimeout(() => {
          void this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { sleptUntil: y.untilIso });
        }, remaining);
        timer.unref?.();
        break;
      }
      case 'run_workflow': {
        // W4 — run a saved workflow as a subroutine and wake this session with its
        // result. Reuses SubflowExecutor (child-run lifecycle + completion bridge).
        if (!this.deps.subflows) {
          await this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { ok: false, error: 'workflow-as-tool is not available on this deployment' });
          break;
        }
        try {
          await this.deps.subflows.start({
            parentRunId: ctx.runId,
            // Colon-free: the subflow pending-key is `parentRunId:parentNodeId`
            // and is split on ':', so the synthetic id must contain no colons.
            parentNodeId: `${node.id}__wf__${y.toolCallId}`.replace(/:/g, '_'),
            workspaceId: ctx.workspaceId,
            ambientId: ctx.ambientId,
            userId: ctx.userId,
            childWorkflowId: y.workflowId,
            inputs: y.inputs ?? {},
            resumeParent: async (output) => { await this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { ok: true, result: output }); },
            failParent: async (msg) => { await this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { ok: false, error: msg }); },
            startChildRun: async (childArgs) => { const handle = await this.startRun(childArgs); return { runId: handle.runId }; },
          });
        } catch (err) {
          await this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, { ok: false, error: (err as Error).message });
        }
        break;
      }
      case 'build_workflow': {
        // W4 — author + persist a new saved workflow (validated). The wake is
        // deferred to a microtask so it runs AFTER #parkSession settles (mirrors
        // the async resolution of the other yields).
        let payload: Record<string, unknown>;
        try {
          const graph = normalizeWorkflowGraph(this.deps.db, ctx.workspaceId, y.graph as unknown as WorkflowGraph).graph;
          validateWorkflowGraph(graph, { strict: true });
          const workflowId = randomUUID();
          this.deps.db.insert(schema.workflows).values({
            id: workflowId, workspaceId: ctx.workspaceId, ambientId: ctx.ambientId,
            userId: ctx.userId, title: y.title.slice(0, 200), graph: graph as unknown as object, settings: {},
          }).run();
          payload = { ok: true, workflowId, title: y.title };
        } catch (err) {
          payload = { ok: false, error: `invalid workflow: ${(err as Error).message}` };
        }
        queueMicrotask(() => { void this.#wakeSession(ctx, node, sessionId, runCtx, y.toolCallId, payload); });
        break;
      }
      case 'request_approval': {
        const approval = await this.deps.approvals.create({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId,
          userId: ctx.userId,
          runId: ctx.runId,
          taskId: null,
          targetId: node.id,
          gatewayId: null,
          source: 'checkpoint',
          title: y.title || 'Agent approval',
          summary: y.summary || `Agent session paused for approval in run ${ctx.runId}`,
          confidence: null,
        });
        this.#pendingApprovals(ctx).set(approval.id, { kind: 'session', targetId: node.id, sessionId, toolCallId: y.toolCallId, runCtx });
        break;
      }
      case 'delegate':
        return; // unreachable â€” resolved inline
    }

    await this.#persistRun(ctx);
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
      runId: ctx.runId,
      nodeId: node.id,
      reason: y.kind,
    });
    void this.#tick(ctx);
  }

  /** Re-open a parked session, inject the awaited result, and re-advance it. */
  async #wakeSession(
    ctx: RunningContext,
    node: WorkflowNode,
    sessionId: string,
    runCtx: SessionRunContext,
    toolCallId: string,
    payload: unknown,
  ): Promise<void> {
    const session = this.deps.sessions?.get(sessionId);
    if (!session || session.status !== 'waiting') return; // already woken / terminal
    this.deps.sessionRuntime!.injectWake(sessionId, toolCallId, payload);
    const ns = ctx.state.nodeStates[node.id];
    if (ns) ns.status = 'RUNNING';
    this.#openSession(ctx, node, sessionId);
    await this.#driveSession(ctx, node, sessionId, runCtx);
  }

  #sessionWaiters(ctx: RunningContext): Map<string, SessionWaiter[]> {
    if (!ctx.sessionWaiters) ctx.sessionWaiters = new Map();
    return ctx.sessionWaiters;
  }

  /**
   * Public wake entry-point for `await_event` yields. A trigger, webhook, or a
   * peer node calls this with a run-scoped event name; every session parked on
   * that name resumes with the payload.
   */
  async notifySessionEvent(args: { runId: string; event: string; payload?: unknown }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) return;
    const waiters = ctx.sessionWaiters?.get(args.event);
    if (!waiters || waiters.length === 0) return;
    ctx.sessionWaiters!.delete(args.event);
    for (const w of waiters) {
      const node = ctx.graph.nodes.find((n) => n.id === w.nodeId);
      if (!node) continue;
      await this.#wakeSession(ctx, node, w.sessionId, w.runCtx, w.toolCallId, { event: args.event, payload: args.payload ?? null });
    }
  }

  /** Resolve an agent identity for a session from explicit id â†’ role â†’ capability tags. */
  #resolveSessionAgent(
    ctx: RunningContext,
    explicitAgentId: string | undefined,
    role: AgentRole | undefined,
    capabilityTags: string[] | undefined,
    requires: AgentRequirements | undefined,
    label: string,
  ): { agentId: string; role?: AgentRole } {
    // agent_session nodes are driven by the shared AgentSessionRuntime adapter,
    // not by a per-agent AdapterManager runtime — so the resolved identity needs
    // only to exist (persona/memory/scoping), never its own connected runtime.
    return this.#resolveAgentForNode(ctx, { explicitAgentId, role, capabilityTags, requires, label, executorProvided: true });
  }

  #resolveAgentForNode(
    ctx: RunningContext,
    args: {
      explicitAgentId?: string;
      role?: AgentRole;
      capabilityTags?: string[];
      requires?: AgentRequirements;
      label: string;
      /**
       * When true a dedicated executor (the AgentSessionRuntime's shared session
       * adapter) drives the node, so the resolved agent is an identity only and
       * need NOT have a connected AdapterManager runtime. Dispatch nodes
       * (`agent_task`/`agent_swarm`) leave this false and still require one.
       */
      executorProvided?: boolean;
    },
  ): { agentId: string; role?: AgentRole } {
    const validRole = args.role && isAgentRole(args.role) ? args.role : undefined;
    const hasRuntime = (id: string): boolean => Boolean(args.executorProvided) || this.#agentHasConnectedRuntime(id);
    if (args.explicitAgentId) {
      const explicitReady = hasRuntime(args.explicitAgentId)
        && this.#agentSatisfiesRequirements(args.explicitAgentId, args.requires);
      if (explicitReady) {
        return { agentId: args.explicitAgentId, role: validRole };
      }
      if (!this.#isSoftPinnedSpecialist(args.explicitAgentId)) {
        this.#assertAgentSatisfiesRequirements(args.explicitAgentId, args.requires, args.label);
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          `${args.label}: pinned agent ${args.explicitAgentId} has no connected runtime`,
        );
      }
    }
    if (validRole && this.deps.specialists) {
      const id = this.deps.specialists.ensureRole(ctx.workspaceId, ctx.userId, validRole);
      if (id && hasRuntime(id) && this.#agentSatisfiesRequirements(id, args.requires)) {
        return { agentId: id, role: validRole };
      }
    }
    const fallback = this.#resolveConnectedFallbackAgent(
      ctx.workspaceId,
      args.capabilityTags ?? [],
      args.requires,
      validRole,
    );
    if (fallback) return { agentId: fallback, role: validRole };
    const requirements = describeAgentRequirements(args.requires);
    throw new AgentisError(
      'WORKFLOW_GRAPH_INVALID',
      requirements
        ? `${args.label}: could not resolve an agent satisfying ${requirements} (no agentId, resolvable role, or capability match)`
        : `${args.label}: could not resolve an agent (no agentId, resolvable role, or capability match)`,
    );
  }

  #assertAgentSatisfiesRequirements(agentId: string, requires: AgentRequirements | undefined, label: string): void {
    if (!hasAgentRequirements(requires)) return;
    if (this.#agentSatisfiesRequirements(agentId, requires)) return;
    throw new AgentisError(
      'WORKFLOW_GRAPH_INVALID',
      `${label}: agent ${agentId} does not satisfy required affordances (${describeAgentRequirements(requires)})`,
    );
  }

  #agentSatisfiesRequirements(agentId: string, requires: AgentRequirements | undefined): boolean {
    if (!hasAgentRequirements(requires)) return true;
    const capabilities = this.deps.adapters.capabilities(agentId);
    return adapterSatisfiesRequirements(capabilities, requires);
  }

  #toolLoopSatisfiesRequirements(requires: AgentRequirements | undefined): boolean {
    if (!hasAgentRequirements(requires)) return true;
    return requiredAffordanceKeys(requires).every((key) => key === 'fileSystem');
  }

  #agentHasOwnAgenticRuntime(agentId: string): boolean {
    const forwarding = this.deps.adapters.capabilities(agentId)?.toolForwarding;
    return forwarding === 'marker_protocol'
      || forwarding === 'mcp_native'
      || forwarding === 'session_event';
  }

  #agentHasConnectedRuntime(agentId: string): boolean {
    return Boolean(this.deps.adapters.get(agentId));
  }

  #isSoftPinnedSpecialist(agentId: string): boolean {
    try {
      const row = this.deps.db
        .select({ config: schema.agents.config })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();
      const config = row?.config;
      return Boolean(
        config
          && typeof config === 'object'
          && !Array.isArray(config)
          && (config as Record<string, unknown>).specialist === true,
      );
    } catch {
      return false;
    }
  }

  /**
   * `dynamic_swarm` (Â§VII): a planner decomposes a goal into independent tasks
   * at runtime; the engine runs them as worker sessions with bounded
   * parallelism and merges per `mergeStrategy`. Each worker runs to terminal â€”
   * a worker that parks is treated as a failure (no cross-tick wake for
   * pooled workers).
   */
  async #runDynamicSwarm(
    ctx: RunningContext,
    node: WorkflowNode,
    config: DynamicSwarmNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.sessions || !this.deps.sessionRuntime) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `dynamic_swarm node ${node.id} present but session runtime not wired`);
    }
    const plannerRole = (config.plannerRole && isAgentRole(config.plannerRole) ? config.plannerRole : 'planner') as AgentRole;
    const tasks = await this.#planTaskList(ctx, config.goal, plannerRole, Math.max(1, config.maxTasks), inputData);
    if (tasks.length === 0) {
      await this.#completeNode(ctx, node.id, { [config.outputKey]: [], count: 0, tasks: [] });
      return;
    }
    const maxParallel = Math.min(Math.max(config.maxParallel || 1, 1), 16);
    const results: Record<string, unknown>[] = new Array(tasks.length);
    const failures: string[] = [];
    let cursor = 0;
    let stop = false;
    const worker = async (): Promise<void> => {
      while (!stop && cursor < tasks.length) {
        const idx = cursor++;
        const taskText = tasks[idx];
        if (!taskText) continue;
        try {
          const out = await this.#runWorkerSession(ctx, node, `${node.id}::dyn::${idx}`, config.agentRole, config.capabilityTags, config.requires, taskText);
          results[idx] = out;
          if (config.mergeStrategy === 'first_success') stop = true;
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxParallel, tasks.length) }, () => worker()));
    const collected = results.filter((r): r is Record<string, unknown> => Boolean(r));
    if (collected.length === 0) {
      await this.#failNode(ctx, node.id, `dynamic_swarm: all ${tasks.length} worker(s) failed (${failures[0] ?? 'unknown'})`);
      void this.#tick(ctx);
      return;
    }
    const merged = config.mergeStrategy === 'first_success'
      ? { [config.outputKey]: [collected[0]], count: 1, strategy: 'first_success', tasks }
      : { [config.outputKey]: collected, count: collected.length, tasks };
    await this.#completeNode(ctx, node.id, merged);
    void this.#tick(ctx);
  }

  /**
   * `planner` (Â§VII): a planner agent decomposes a goal, then SPLICES the plan
   * into the live run as a chain of `agent_session` worker nodes via a validated
   * graph patch — so the operator watches the plan materialize on the canvas and
   * each step executes through the normal engine tick (full memory + delegation).
   * If the splice cannot validate (e.g. the planner was a terminal node), it
   * falls back to deterministic inline-sequential execution.
   */
  async #runPlanner(
    ctx: RunningContext,
    node: WorkflowNode,
    config: PlannerNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.sessions || !this.deps.sessionRuntime) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `planner node ${node.id} present but session runtime not wired`);
    }
    const plannerRole = (config.agentRole && isAgentRole(config.agentRole) ? config.agentRole : 'planner') as AgentRole;
    const scoped = config.inputKeys.length > 0 ? pickKeys(inputData, config.inputKeys) : inputData;
    const steps = await this.#planTaskList(ctx, config.goal, plannerRole, config.maxNodes ?? 8, scoped);
    if (steps.length === 0) {
      await this.#completeNode(ctx, node.id, { plan: [], results: [] });
      void this.#tick(ctx);
      return;
    }
    const workerRole = config.workerRole && isAgentRole(config.workerRole) ? config.workerRole : plannerRole;

    // Preferred: rewrite the live graph so the plan becomes real, observable,
    // independently-replayable nodes the engine runs itself.
    try {
      const spliced = await this.#splicePlanIntoGraph(ctx, node, steps, workerRole);
      await this.#completeNode(ctx, node.id, {
        plan: steps,
        generatedNodes: spliced.count,
        planRevision: spliced.newRevision,
        mode: 'live_graph',
      });
      void this.#tick(ctx);
      return;
    } catch (err) {
      this.deps.logger.warn('planner.splice_failed_fallback_sequential', {
        runId: ctx.runId,
        nodeId: node.id,
        error: (err as Error).message,
      });
    }

    // Fallback: inline sequential execution (no live graph edit).
    const results: Array<{ step: string; output: Record<string, unknown> }> = [];
    let accumulated: Record<string, unknown> = { ...scoped };
    for (let i = 0; i < steps.length; i += 1) {
      const stepText = steps[i]!;
      const task = `${stepText}\n\nPRIOR RESULTS:\n${safeJson(accumulated)}`;
      let out: Record<string, unknown>;
      try {
        out = await this.#runWorkerSession(ctx, node, `${node.id}::plan::${i}`, workerRole, [], undefined, task);
      } catch (err) {
        await this.#failNode(ctx, node.id, `planner step ${i + 1}/${steps.length} failed: ${(err as Error).message}`);
        void this.#tick(ctx);
        return;
      }
      results.push({ step: stepText, output: out });
      accumulated = { ...accumulated, [`step_${i + 1}`]: out };
    }
    await this.#completeNode(ctx, node.id, { plan: steps, results, mode: 'inline_sequential', ...accumulated });
    void this.#tick(ctx);
  }

  /**
   * Splice a decomposed plan into the running graph: one `agent_session` node per
   * step, chained planner → step1 → … → stepN, with the planner's original
   * successors re-routed to hang off the final step. Emits canvas placement
   * events so the new nodes animate in live. Throws (→ caller fallback) if the
   * resulting graph fails validation.
   */
  async #splicePlanIntoGraph(
    ctx: RunningContext,
    node: WorkflowNode,
    steps: string[],
    workerRole: AgentRole,
  ): Promise<{ count: number; newRevision: number }> {
    const base = ctx.state.graphRevision;
    const outgoing = ctx.graph.edges.filter((e) => e.source === node.id);
    const pos = node.position ?? { x: 0, y: 0 };
    const addNodes: WorkflowNode[] = [];
    const addEdges: WorkflowEdge[] = [];
    let prevId = node.id;
    steps.forEach((stepText, i) => {
      const stepId = `${node.id}__plan_${i + 1}`;
      addNodes.push({
        id: stepId,
        type: 'agent_session',
        title: `Plan ${i + 1}/${steps.length}`,
        position: { x: pos.x + (i + 1) * 280, y: pos.y },
        config: {
          kind: 'agent_session',
          agentRole: workerRole,
          prompt: stepText,
          inputKeys: [],
          outputKeys: [],
          capabilityTags: [],
        },
      });
      addEdges.push({ id: `${node.id}__plan_e_${i}`, source: prevId, target: stepId, type: 'default' });
      prevId = stepId;
    });
    // Re-route the planner's former successors onto the tail of the plan chain.
    outgoing.forEach((e, i) => {
      addEdges.push({
        id: `${node.id}__plan_join_${i}`,
        source: prevId,
        target: e.target,
        ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
        type: 'default',
      });
    });
    const patch: WorkflowGraphPatch = {
      patchId: randomUUID(),
      reason: 'planner_replan',
      baseGraphRevision: base,
      addNodes,
      updateNodes: [],
      removeNodeIds: [],
      addEdges,
      removeEdgeIds: outgoing.map((e) => e.id),
    };
    const { newRevision } = await this.applyGraphPatch({ runId: ctx.runId, patch });
    for (const n of addNodes) {
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CANVAS_NODE_PLACED, {
        runId: ctx.runId, nodeId: n.id, node: n,
      });
    }
    for (const e of addEdges) {
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CANVAS_EDGE_CONNECTED, {
        runId: ctx.runId, edgeId: e.id, edge: e,
      });
    }
    return { count: addNodes.length, newRevision };
  }

  /** Run one worker session to terminal and return its output (throws on park/fail). */
  async #runWorkerSession(
    ctx: RunningContext,
    node: WorkflowNode,
    sessionNodeId: string,
    role: AgentRole | undefined,
    capabilityTags: string[] | undefined,
    requires: AgentRequirements | undefined,
    task: string,
  ): Promise<Record<string, unknown>> {
    const { agentId, role: resolved } = this.#resolveSessionAgent(ctx, undefined, role, capabilityTags, requires, sessionNodeId);
    const session = this.deps.sessions!.create({
      agentId,
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      nodeId: sessionNodeId,
      personaBlock: resolved ? this.#specialistDef(ctx, resolved).systemPrompt : '',
      taskBlock: task,
    });
    const runContextResult = await this.#withWorkspaceContext(ctx, task, undefined, '', agentId);
    const runContextBlock = runContextResult.prompt;
    const runCtx: SessionRunContext = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: ctx.runId,
      nodeId: node.id,
      agentId,
      workflowId: ctx.workflowId,
      planId: ctx.planId,
      role: resolved,
      runContextBlock,
    };
    const outcome = await this.#advanceSessionLoop(ctx, node, session.id, runCtx);
    if (outcome.kind === 'completed' || outcome.kind === 'max_steps') {
      this.#enqueueSuccessfulBrainCapture(ctx, sessionNodeId, outcome.output, agentId, { task });
      return outcome.output;
    }
    if (outcome.kind === 'failed') throw new AgentisError('INTERNAL_ERROR', outcome.error);
    throw new AgentisError('INTERNAL_ERROR', 'worker session yielded (await/sleep/approval), unsupported in this context');
  }

  /** Run a planner session and parse its JSON task list (bounded by `max`). */
  async #planTaskList(
    ctx: RunningContext,
    goal: string,
    plannerRole: AgentRole,
    max: number,
    inputData: Record<string, unknown>,
  ): Promise<string[]> {
    const { agentId } = this.#resolveSessionAgent(ctx, undefined, plannerRole, [], undefined, 'planner');
    const contextBlock = Object.keys(inputData).length > 0 ? `\n\nCONTEXT:\n${safeJson(inputData)}` : '';
    const task =
      `Decompose this goal into at most ${max} independent subtasks.\n` +
      `Goal: ${goal}${contextBlock}\n\n` +
      `Reply by calling complete_task with output set to a JSON array of strings â€” ` +
      `each string a self-contained subtask. No prose.`;
    const session = this.deps.sessions!.create({
      agentId,
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      nodeId: `planner::${randomUUID()}`,
      personaBlock: this.#specialistDef(ctx, plannerRole).systemPrompt,
      taskBlock: task,
    });
    const runContextResult = await this.#withWorkspaceContext(ctx, task, undefined, '', agentId);
    const runCtx: SessionRunContext = {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      runId: ctx.runId,
      nodeId: 'planner',
      agentId,
      workflowId: ctx.workflowId,
      planId: ctx.planId,
      role: plannerRole,
      runContextBlock: runContextResult.prompt,
      maxSteps: 6,
    };
    const outcome = await this.deps.sessionRuntime!.advance(session.id, runCtx);
    const text = (outcome.kind === 'completed' || outcome.kind === 'max_steps') ? extractPlanText(outcome.output) : '';
    return parseTaskList(text, max);
  }

  /**
   * Compose an agent prompt's system preamble: optional role identity, then the
   * workspace context block (Layer 1), the agent's personal memory (Â§G11), then
   * the task prompt. Best effort: a context-read failure must never block a
   * dispatch.
   */
  async #withWorkspaceContext(
    ctx: RunningContext,
    prompt: string,
    rolePrompt?: string,
    skillBlock?: string,
    agentId?: string
  ): Promise<{
    prompt: string;
    abilities: { id: string; name: string; version: string; mode: 'compiled' | 'static' }[];
    abilityEnv: Record<string, string>;
    preferredModel: string | null;
  }> {
    // Authored workspace context (the operator "charter") and knowledge-base
    // passages are no longer injected as a separate block: they are atoms in
    // the DB brain now, surfaced by `brainBlock` below — the charter via the
    // always-on constitutional tier, KB passages via relevance retrieval. A
    // separate block would double-inject them.
    const block = '';
    let agentIdentityBlock = '';
    if (agentId) {
      try {
        agentIdentityBlock = renderAgentIdentityBlock(loadAgentIdentitySnapshot(this.deps.db, ctx.workspaceId, agentId)) ?? '';
      } catch (err) {
        this.deps.logger.warn('engine.agent_identity.failed', { runId: ctx.runId, agentId, err: (err as Error).message });
      }
    }
    let brainBlock = '';
    if (this.deps.sharedIntelligence) {
      try {
        // §C7 — App-owned runs recall the UNION of the App's brain and the
        // operating agent's own memory (neither is amnesic to the other); a
        // plain run just recalls the agent's scope. Workspace-shared atoms come
        // through either pass.
        const appScopeId = this.#appScopeId(ctx.workspaceId, ctx.workflowId);
        const recallScopes = [appScopeId, agentId].filter((s): s is string => Boolean(s));
        const brain = await this.deps.sharedIntelligence.buildDispatchContext({
          workspaceId: ctx.workspaceId,
          scopeId: appScopeId ?? agentId ?? null,
          scopeIds: recallScopes.length > 0 ? Array.from(new Set(recallScopes)) : undefined,
          agentId: agentId ?? null,
          runId: ctx.runId,
          taskDescription: prompt,
          limit: 8,
        });
        if (brain.block) brainBlock = `<workspace_brain>\n${brain.block}\n</workspace_brain>`;
      } catch (err) {
        this.deps.logger.warn('engine.shared_brain_context.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }
    let peerContext = '';
    if (this.deps.peerProfiles) {
      try {
        const observerScope = agentId ?? 'global';
        const instructions = this.deps.peerProfiles.renderSystemInstructions(ctx.workspaceId, 'user', ctx.userId, observerScope);
        const facts = this.deps.peerProfiles.renderContextFacts(ctx.workspaceId, 'user', ctx.userId, observerScope);
        const parts = [instructions, facts.length > 0 ? `PEER CARD FACTS\n${facts.map((fact) => `- ${fact}`).join('\n')}` : ''].filter(Boolean);
        if (parts.length > 0) peerContext = `<peer_context>\n${parts.join('\n\n')}\n</peer_context>`;
      } catch (err) {
        this.deps.logger.warn('engine.peer_context.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }
    // §G11 — the dispatched agent's personal memory. It now lives in the
    // canonical brain (memory_episodes, scope_id = agentId) and is already
    // surfaced by `brainBlock` above (buildDispatchContext retrieves scope
    // "both" = workspace + this agent's scope). No separate injection — that
    // would double-inject the same atoms.
    const agentMemory = '';
    let personalBrain = '';
    if (agentId && this.deps.personalBrain) {
      try {
        personalBrain = await this.deps.personalBrain.contextForAgent(ctx.userId, agentId, prompt);
      } catch (err) {
        this.deps.logger.warn('engine.personal_brain.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }
    let spaceContext = '';
    if (agentId && this.deps.db) {
      try {
        const spaceRow = this.deps.db
          .select({
             name: schema.spaces.name,
             description: schema.spaces.description,
             managerId: schema.spaces.managerId
          })
          .from(schema.agents)
          .leftJoin(schema.spaces, eq(schema.agents.spaceId, schema.spaces.id))
          .where(eq(schema.agents.id, agentId))
          .get();

        if (spaceRow && spaceRow.name) {
          spaceContext = `<space_context>\nSpace: ${spaceRow.name}`;
          if (spaceRow.description) spaceContext += `\nDescription: ${spaceRow.description}`;
          if (spaceRow.managerId) {
             const managerRow = this.deps.db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, spaceRow.managerId)).get();
             if (managerRow) spaceContext += `\nManager: ${managerRow.name}`;
          }
          spaceContext += `\n</space_context>`;
        }
      } catch (err) {
        this.deps.logger.warn('engine.space_context.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }

    let specialistMindBlock = '';
    if (agentId && this.deps.specialistMind) {
      try {
        const roleRow = this.deps.db.select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, agentId)).get();
        if (roleRow?.role) specialistMindBlock = await this.deps.specialistMind.contextBlock(ctx.workspaceId, roleRow.role, prompt, 6);
      } catch (err) {
        this.deps.logger.warn('engine.specialist_mind.failed', { runId: ctx.runId, err: (err as Error).message });
      }
    }

    const abilityResult = await this.#buildAbilityBlock(ctx, prompt, agentId);
    // W2 — the operating manual: brief the agent on its full agentic surface
    // (spawn/delegate/workflow-as-tool/replan) + the hard anti-hallucination rules,
    // layered by role. Leads the prompt so it frames everything below it.
    let operatingManualBlock = '';
    try {
      const role = agentId
        ? (this.deps.db.select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.role ?? null)
        : null;
      const manual = composeOperatingManual({ role, workspaceManual: getWorkspaceManual(this.deps.db, ctx.workspaceId) });
      if (manual) operatingManualBlock = `<operating_manual>\n${manual}\n</operating_manual>`;
    } catch (err) {
      this.deps.logger.warn('engine.operating_manual.failed', { runId: ctx.runId, err: (err as Error).message });
    }
    return {
      prompt: [agentIdentityBlock, operatingManualBlock, rolePrompt, peerContext, block, brainBlock, specialistMindBlock, abilityResult.xml, spaceContext, agentMemory, personalBrain, skillBlock, prompt].filter(Boolean).join('\n\n'),
      abilities: abilityResult.abilities,
      abilityEnv: abilityResult.env,
      preferredModel: abilityResult.preferredModel,
    };
  }

  #enqueueSuccessfulBrainCapture(
    ctx: RunningContext,
    nodeId: string,
    output: Record<string, unknown>,
    agentId: string | null,
    extraInput: Record<string, unknown> = {},
  ): void {
    const queue = this.deps.brainQueue;
    if (!queue) return;
    try {
      const baseNodeId = nodeId.includes('::') ? nodeId.split('::')[0] || nodeId : nodeId;
      const node = ctx.graph.nodes.find((candidate) => candidate.id === baseNodeId) ?? null;
      const inputData = ctx.state.nodeStates[baseNodeId]?.inputData ?? null;

      // Write-policy gate (§P1): decide what this run may write to the Brain
      // BEFORE any text is mined. Transient deliverables (digests, reports) are
      // gated to a single episodic marker and can never form pattern atoms.
      let agentRole: string | null = null;
      if (agentId) {
        try {
          agentRole = this.deps.db.select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.role ?? null;
        } catch { /* role lookup is best-effort */ }
      }
      const nodeConfig = (node?.config ?? {}) as Record<string, unknown>;
      const { policy } = resolveMemoryPolicy({
        explicitPolicy: nodeConfig.memoryPolicy,
        surface: 'run_completion',
        nodeKind: node?.config.kind ?? null,
        nodeTitle: node?.title ?? nodeId,
        agentRole,
        output,
      });

      queue.enqueue({
        workspaceId: ctx.workspaceId,
        itemType: 'atom_promotion',
        priority: 'normal',
        payload: {
          workspaceId: ctx.workspaceId,
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          nodeId,
          agentId,
          // App-owned runs form their lessons into the App's brain (portable with
          // the App); bare workflows keep forming into the agent's own scope.
          scopeId: this.#appScopeId(ctx.workspaceId, ctx.workflowId) ?? agentId,
          taskTitle: node?.title ?? nodeId,
          memoryPolicy: policy,
          originSurface: 'run_completion',
          taskInput: {
            nodeTitle: node?.title ?? nodeId,
            nodeKind: node?.config.kind ?? null,
            inputData,
            ...extraInput,
          },
          taskOutput: output,
        },
      });
    } catch (err) {
      this.deps.logger.warn('engine.brain_capture.enqueue_failed', { runId: ctx.runId, nodeId, err: (err as Error).message });
    }
  }

  /**
   * Resolve the ability injection for this dispatch (Â§3 + Â§7.3 of ABILITIES.md):
   *
   *  1. Collect pinned abilities (always-on for this agent).
   *  2. Score the rest of the workspace pool against the task embedding;
   *     drop anything below ABILITY_MIN_RELEVANCE_SCORE.
   *  3. Inject pinned first, then semantic matches, until the workspace token
   *     budget is exhausted.
   *  4. Record an ability_used episode + brain_quality_event for traceability.
   *
   * Best-effort: any failure (no embedder configured, runtime error, empty
   * pool) returns the empty string â€” dispatch must never block on abilities.
   */
  async #buildAbilityBlock(ctx: RunningContext, task: string, agentId?: string): Promise<{
    xml: string;
    abilities: { id: string; name: string; version: string; mode: 'compiled' | 'static' }[];
    env: Record<string, string>;
    preferredModel: string | null;
  }> {
    const emptyResult = { xml: '', abilities: [], env: {}, preferredModel: null };
    const svc = this.deps.abilities;
    const providerFn = this.deps.abilityEmbeddings;
    if (!svc || !providerFn) return emptyResult;
    try {
      const provider = providerFn(ctx.workspaceId);
      const pinned = agentId
        ? svc.listPinsForAgent(agentId).filter((pin) => pin.enabled)
        : [];
      const pinnedIds = new Set(pinned.map((p) => p.abilityId));

      const compiled = svc.listCompiled(ctx.workspaceId);
      if (compiled.length === 0) return emptyResult;

      // Phase 3 â€” resolve the dispatched agent's specialist role loadout. Required
      // abilities are force-injected; forbidden are excluded everywhere; preferred
      // lower the semantic relevance threshold. Keyed by role, resolved from the
      // agent row, so it applies to every materialized agent of that role.
      let loadout = this.deps.loadouts?.resolveForRole(ctx.workspaceId, '');
      if (this.deps.loadouts && agentId && this.deps.db) {
        const roleRow = this.deps.db.select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, agentId)).get();
        if (roleRow?.role) loadout = this.deps.loadouts.resolveForRole(ctx.workspaceId, roleRow.role);
      }
      const forbidden = loadout?.forbidden ?? new Set<string>();
      const preferredThresholds = loadout?.preferred ?? new Map<string, number>();

      let taskEmbedding: number[] | null = null;
      const taskText = task.trim().length > 0 ? task : '';
      if (taskText) {
        try {
          taskEmbedding = await embedTextHelper(provider, taskText.slice(0, 4000));
        } catch (err) {
          this.deps.logger.warn('engine.ability.task_embed_failed', { runId: ctx.runId, err: (err as Error).message });
        }
      }

      const requiredIds = loadout?.required ?? new Set<string>();
      const scored = taskEmbedding ? svc.scoreAbilitiesForTask(ctx.workspaceId, taskEmbedding) : [];
      const semantic = scored
        .filter((s) => !pinnedIds.has(s.ability.id) && !requiredIds.has(s.ability.id) && !forbidden.has(s.ability.id) && s.ability.gate?.always !== true)
        .filter((s) => {
          const base = s.ability.minRelevanceScore ?? CONSTANTS.ABILITY_MIN_RELEVANCE_SCORE;
          // A preferred loadout ability clears a lowered threshold.
          const threshold = preferredThresholds.has(s.ability.id) ? Math.min(preferredThresholds.get(s.ability.id)!, base) : base;
          return s.score >= threshold;
        });

      // Required loadout abilities are force-injected (like pins), ahead of all else.
      const requiredRecords = [...requiredIds]
        .filter((id) => !pinnedIds.has(id))
        .map((id) => ({ ability: svc.tryGet(id), score: 1.0 }))
        .filter((r): r is { ability: NonNullable<ReturnType<AbilityService['tryGet']>>; score: number } =>
          Boolean(r.ability && r.ability.compileStatus === 'ready'),
        );

      // Resolve pinned ability records (skip dirty/unready ones; honor forbidden).
      const pinnedRecords = pinned
        .filter((p) => !forbidden.has(p.abilityId))
        .map((p) => ({ ability: svc.tryGet(p.abilityId), score: 1.0 }))
        .filter((r): r is { ability: NonNullable<ReturnType<AbilityService['tryGet']>>; score: number } =>
          Boolean(r.ability && r.ability.compileStatus === 'ready'),
        );

      const alwaysOn = compiled
        .filter((a) => a.gate?.always === true && !pinnedIds.has(a.id) && !requiredIds.has(a.id) && !forbidden.has(a.id))
        .map((a) => ({ ability: a as NonNullable<ReturnType<AbilityService['tryGet']>>, score: 1.0 }));

      const currentOs = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
      const availableAffordances = ['terminal', 'fileSystem']; // Basic affordances for now

      const preMerged = [...requiredRecords, ...pinnedRecords, ...alwaysOn, ...semantic.map((s) => ({ ability: s.ability, score: s.score }))];

      const merged = preMerged.filter((entry) => {
        const gate = entry.ability.gate;
        if (!gate) return true;
        if (gate.os && gate.os !== currentOs) return false;
        if (gate.requiresEnv && gate.requiresEnv.length > 0) {
          if (!gate.requiresEnv.every((k) => process.env[k] !== undefined)) return false;
        }
        if (gate.requiresAffordances && gate.requiresAffordances.length > 0) {
          if (!gate.requiresAffordances.every((a) => availableAffordances.includes(a))) return false;
        }
        return true;
      }).slice(0, CONSTANTS.ABILITY_MAX_INJECTED);

      if (merged.length === 0) return emptyResult;

      // ABILITIES-10X — resolve the stack: precedence reconciliation, rule-conflict
      // detection, and content-hash-stable ordering of the cacheable (task-invariant)
      // prefix. Falls back to the pre-existing order when no composer is wired.
      let composedConflicts: Array<{ kind: string; detail: string }> = [];
      if (this.deps.abilityComposer) {
        const tierOf = (id: string): AbilityTier =>
          requiredIds.has(id) ? 'required'
            : pinnedIds.has(id) ? 'pinned'
              : compiled.find((a) => a.id === id)?.gate?.always === true ? 'always'
                : 'semantic';
        const composerEntries: ComposerEntry[] = merged.map((entry) => ({
          id: entry.ability.id,
          name: entry.ability.name,
          contentHash: entry.ability.contentHash ?? null,
          depth: entry.ability.depth,
          tier: tierOf(entry.ability.id),
          score: entry.score,
          rulesAlways: entry.ability.rulesAlways ?? [],
          rulesNever: entry.ability.rulesNever ?? [],
          toolHints: entry.ability.toolHints ?? [],
        }));
        const composed = this.deps.abilityComposer.compose(composerEntries);
        const rank = new Map(composed.ordered.map((e, i) => [e.id, i]));
        merged.sort((a, b) => (rank.get(a.ability.id) ?? 0) - (rank.get(b.ability.id) ?? 0));
        composedConflicts = composed.conflicts.map((c) => ({ kind: c.kind, detail: c.detail }));
      }

      const workspaceBudget = await this.#abilityWorkspaceBudget(ctx.workspaceId);
      let usedTokens = 0;
      const blocks: string[] = [];
      const injected: Array<{ id: string; name: string; score: number; tokens: number }> = [];
      const outAbilities: Array<{ id: string; name: string; version: string; mode: 'compiled' | 'static' }> = [];
      let mergedEnv: Record<string, string> = {};
      let outPreferredModel: string | null = null;

      for (const entry of merged) {
        const remaining = workspaceBudget - usedTokens;
        if (remaining < CONSTANTS.MIN_ABILITY_TOKENS) break;
        const perAbilityBudget = Math.min(
          entry.ability.tokenBudget ?? workspaceBudget,
          remaining,
        );
        const result = await svc.buildContextBlock({
          abilityId: entry.ability.id,
          task: taskText,
          taskEmbedding: taskEmbedding ?? [],
          provider,
          tokenBudget: perAbilityBudget,
        });
        if (!result) continue;
        // ABILITIES-10X D3 — a "Method" ability changes HOW the agent works:
        // append its execution policy (tool plan / verify checks) to the block.
        const execXml = this.#renderExecutionPolicy(entry.ability);
        const blockXml = execXml ? `${result.xml}\n${execXml}` : result.xml;
        blocks.push(blockXml);
        usedTokens += result.tokens;
        injected.push({ id: entry.ability.id, name: entry.ability.name, score: entry.score, tokens: result.tokens });
        outAbilities.push({
          id: entry.ability.id,
          name: entry.ability.name,
          version: entry.ability.version ?? '1',
          mode: entry.ability.mode ?? 'compiled'
        });

        if (this.deps.vault) {
          const env = await svc.resolveEnv(entry.ability.id, this.deps.vault);
          mergedEnv = { ...mergedEnv, ...env };
        }
        // ABILITIES-10X D4 — a "Conductor" ability picks the engine: its routing
        // policy's preferred model wins over the legacy preferredModel column.
        const routed = entry.ability.routingPolicy?.preferredModel ?? entry.ability.preferredModel;
        if (routed && !outPreferredModel) {
          outPreferredModel = routed;
        }
      }

      if (blocks.length === 0) return emptyResult;

      // Episodic record + quality event so Brain surfaces show ability usage.
      this.#recordAbilityUsage(ctx, agentId, taskText, injected);

      // ABILITIES-10X — append to the activation ledger (the free flywheel):
      // which abilities fired, what conflicts were resolved, on which run.
      try {
        svc.recordActivation({
          workspaceId: ctx.workspaceId,
          runId: ctx.runId,
          agentId: agentId ?? null,
          model: outPreferredModel,
          abilityIds: injected.map((i) => i.id),
          conflictsResolved: composedConflicts,
          outcome: null,
        });
      } catch (err) {
        this.deps.logger.warn('engine.ability.activation_record_failed', { runId: ctx.runId, err: (err as Error).message });
      }

      return {
        xml: blocks.join('\n\n'),
        abilities: outAbilities,
        env: mergedEnv,
        preferredModel: outPreferredModel,
      };
    } catch (err) {
      this.deps.logger.warn('engine.ability.block_failed', {
        runId: ctx.runId,
        err: (err as Error).message,
      });
      return emptyResult;
    }
  }

  /** ABILITIES-10X D3 — render an ability's execution policy as a compact directive. */
  #renderExecutionPolicy(ability: { executionPolicy: import('@agentis/core').AbilityExecutionPolicy | null }): string | null {
    const p = ability.executionPolicy;
    if (!p) return null;
    const lines: string[] = [];
    if (p.toolPlan && p.toolPlan.length) lines.push(`  <tool-plan>${p.toolPlan.map((t) => String(t)).join(' → ')}</tool-plan>`);
    if (p.verify && p.verify.length) lines.push(`  <verify>${p.verify.map((v) => String(v)).join('; ')}</verify>`);
    if (typeof p.maxRetries === 'number') lines.push(`  <max-retries>${p.maxRetries}</max-retries>`);
    return lines.length ? `<execution-policy>\n${lines.join('\n')}\n</execution-policy>` : null;
  }

  async #abilityWorkspaceBudget(workspaceId: string): Promise<number> {
    try {
      const row = this.deps.db
        .select({ settings: schema.workspaces.brainSettings })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .get();
      const settings = (row?.settings ?? {}) as Record<string, unknown>;
      const candidate = settings?.['ability_token_budget'];
      if (typeof candidate === 'number' && candidate > 0) return Math.floor(candidate);
    } catch {
      /* fall through to default */
    }
    return CONSTANTS.ABILITY_TOKEN_BUDGET;
  }

  #recordAbilityUsage(
    ctx: RunningContext,
    agentId: string | undefined,
    task: string,
    injected: Array<{ id: string; name: string; score: number; tokens: number }>,
  ): void {
    if (injected.length === 0) return;
    // Ability activations are recorded as brain quality events (below) for
    // analytics and pin suggestions — not written into the agent's memory,
    // which is reserved for durable lessons, not per-dispatch telemetry.
    // Brain quality event for analytics / pin suggestions.
    try {
      const totalTokens = injected.reduce((sum, i) => sum + i.tokens, 0);
      for (const inj of injected) {
        this.deps.db.insert(schema.brainQualityEvents).values({
          id: randomUUID(),
          workspaceId: ctx.workspaceId,
          scopeId: null,
          agentId: agentId ?? null,
          eventType: 'ability_used',
          atomId: null,
          abilityId: inj.id,
          runId: ctx.runId,
          delta: inj.score,
          metadata: { tokens: inj.tokens, totalTokens, task: task.slice(0, 200) } as unknown as Record<string, unknown>,
          createdAt: new Date().toISOString(),
        }).run();
      }
    } catch (err) {
      this.deps.logger.warn('engine.ability.brain_event_failed', {
        runId: ctx.runId,
        err: (err as Error).message,
      });
    }
  }

  #logContextFailure(ctx: RunningContext, err: unknown): void {
    this.deps.logger.warn('engine.workspace_context.failed', {
      runId: ctx.runId,
      workspaceId: ctx.workspaceId,
      err: (err as Error).message,
    });
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Artifact collect node
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
            origin: 'workflow',
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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Agent swarm node (AGENTIS-PLATFORM-10X Â§A8)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    const agentId = config.agentId
      ?? this.#resolveConnectedFallbackAgent(ctx.workspaceId, config.capabilityTags, config.requires);
    if (config.agentId) this.#assertAgentSatisfiesRequirements(config.agentId, config.requires, `agent_swarm node ${node.id}`);
    if (!agentId) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `agent_swarm node ${node.id}: no agent bound and none match capability tags`,
      );
    }
    // Honor the runtime's declared concurrency: a swarm must never spawn more
    // parallel processes than the adapter says it can handle (e.g. CLI harnesses
    // that declare maxConcurrent:1). Otherwise 64 child processes hit a runtime
    // built for one — exhausting RAM/PIDs on the host.
    const adapterMaxConcurrent = this.deps.adapters.capabilities(agentId)?.execution?.maxConcurrent;
    const ceiling = adapterMaxConcurrent && adapterMaxConcurrent > 0 ? Math.min(64, adapterMaxConcurrent) : 64;
    const maxParallel = Math.min(Math.max(config.maxParallel || 1, 1), ceiling);
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
      worktrees: new Map(),
      inFlight: new Set(),
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
      void this.#dispatchSwarmSubtask(ctx, node, swarm, swarm.next++);
    }
  }

  #resolveConnectedFallbackAgent(
    workspaceId: string,
    capabilityTags: string[],
    requires?: AgentRequirements,
    preferredRole?: AgentRole,
  ): string | null {
    try {
      const candidates = this.deps.adapters
        .list()
        .filter((registration) => this.#agentSatisfiesRequirements(registration.agentId, requires));
      const registered = new Set(candidates.map((r) => r.agentId));
      if (registered.size === 0) return null;
      if (preferredRole) {
        const matchingRole = this.deps.db
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, preferredRole)))
          .all()
          .find((agent) => registered.has(agent.id));
        if (matchingRole) return matchingRole.id;
      }
      if (capabilityTags.length > 0) {
        const agents = this.deps.db
          .select({ id: schema.agents.id, capabilityTags: schema.agents.capabilityTags })
          .from(schema.agents)
          .where(eq(schema.agents.workspaceId, workspaceId))
          .all();
        for (const a of agents) {
          if (!registered.has(a.id)) continue;
          const tags = Array.isArray(a.capabilityTags) ? (a.capabilityTags as string[]) : [];
          if (tags.some((t) => capabilityTags.includes(t))) return a.id;
        }
      }
      const orchestrator = this.deps.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, 'orchestrator')))
        .get();
      if (orchestrator && registered.has(orchestrator.id)) return orchestrator.id;
      return candidates[0]?.agentId ?? null;
    } catch {
      return null;
    }
  }

  async #dispatchSwarmSubtask(
    ctx: RunningContext,
    node: WorkflowNode,
    swarm: SwarmState,
    index: number,
  ): Promise<void> {
    const item = swarm.items[index];
    const taskId = `${node.id}::swarm::${index}`;
    swarm.inFlight.add(index);
    try {
      const contextResult = await this.#withWorkspaceContext(ctx, swarm.config.prompt, undefined, '', swarm.agentId);
      // Per-task isolation: each parallel subtask gets its own working directory
      // so concurrent agents never share one checkout and clobber each other.
      // Best-effort — a failed/absent allocation degrades to the adapter's cwd.
      const workdir = await this.#acquireSwarmWorktree(swarm, index, taskId);
      await this.deps.adapters.dispatchTask(
        {
          taskId,
          runId: ctx.runId,
          workflowId: ctx.workflowId,
          nodeId: taskId,
          title: `${node.title} [${index + 1}/${swarm.total}]`,
          description: contextResult.prompt,
          inputData: { item, index, prompt: swarm.config.prompt },
          scratchpadSnapshot: this.deps.scratchpad.snapshotOf(ctx.runId),
          capabilityTags: swarm.config.capabilityTags,
          timeoutMs: CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS,
          // Run-scoped cancellation so Stop aborts in-flight swarm subtasks
          // instead of letting them run (and bill) to completion.
          signal: ctx.abortController?.signal,
          workdir,
          abilities: contextResult.abilities,
          abilityEnv: contextResult.abilityEnv,
          preferredModel: contextResult.preferredModel,
        },
        swarm.agentId,
      );
    } catch (err) {
      void this.#onSwarmSubtask(ctx, node.id, index, null, (err as Error).message);
    }
  }

  /**
   * Allocate an isolated working directory for one swarm subtask. Stores the
   * handle on the swarm so it can be released when the subtask settles. Returns
   * the path, or undefined when isolation is unavailable (no WorktreeManager
   * wired, gateway adapter with no local cwd, or allocation failed) — in which
   * case the adapter falls back to its configured cwd.
   */
  async #acquireSwarmWorktree(swarm: SwarmState, index: number, taskId: string): Promise<string | undefined> {
    if (!this.deps.worktrees) return undefined;
    try {
      const handle = await this.deps.worktrees.acquire({
        baseCwd: this.deps.adapters.workdirOf(swarm.agentId),
        taskId,
      });
      if (!handle.path) return undefined;
      swarm.worktrees.set(index, handle);
      return handle.path;
    } catch (err) {
      this.deps.logger.warn('swarm.worktree_acquire_failed', { taskId, err: (err as Error).message });
      return undefined;
    }
  }

  /** Release one subtask's isolated directory (idempotent, best-effort). */
  async #releaseSwarmWorktree(swarm: SwarmState, index: number): Promise<void> {
    const handle = swarm.worktrees.get(index);
    if (!handle) return;
    swarm.worktrees.delete(index);
    try { await handle.release(); } catch { /* best-effort */ }
  }

  /** Release every remaining isolated directory for a settled swarm. */
  async #releaseAllSwarmWorktrees(swarm: SwarmState): Promise<void> {
    const handles = [...swarm.worktrees.values()];
    swarm.worktrees.clear();
    await Promise.all(handles.map((h) => h.release().catch(() => {})));
  }

  /**
   * When a swarm settles early (first_success), abandon the still-running
   * siblings: cancel each in-flight subtask so it stops consuming the runtime and
   * billing, THEN reclaim every isolated directory. Cancelling before releasing
   * avoids yanking a worktree out from under a live process.
   */
  async #abandonInFlightSwarmSiblings(nodeId: string, swarm: SwarmState): Promise<void> {
    const inFlight = [...swarm.inFlight];
    swarm.inFlight.clear();
    await Promise.all(
      inFlight.map((idx) =>
        this.deps.adapters.cancelTask(swarm.agentId, `${nodeId}::swarm::${idx}`).catch(() => {}),
      ),
    );
    await this.#releaseAllSwarmWorktrees(swarm);
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
    // The subtask reported terminal — it is no longer in flight, and its isolated
    // dir can be reclaimed.
    swarm.inFlight.delete(index);
    await this.#releaseSwarmWorktree(swarm, index);
    if (error) {
      swarm.failures.set(index, error);
    } else {
      const capturedOutput = output ?? {};
      swarm.results.set(index, capturedOutput);
      this.#enqueueSuccessfulBrainCapture(ctx, `${nodeId}::swarm::${index}`, capturedOutput, swarm.agentId, {
        swarmNodeId: nodeId,
        item: swarm.items[index] ?? null,
      });
    }

    const node = ctx.graph.nodes.find((n) => n.id === nodeId);

    // first_success: settle as soon as one subtask succeeds.
    if (swarm.config.mergeStrategy === 'first_success' && !error && node) {
      swarm.settled = true;
      ctx.swarms.delete(nodeId);
      delete ctx.state.activeExecutions[nodeId];
      // One subtask won — cancel the in-flight siblings (stop wasted work + cost)
      // and reclaim their isolated dirs instead of orphaning them.
      await this.#abandonInFlightSwarmSiblings(nodeId, swarm);
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
      void this.#dispatchSwarmSubtask(ctx, node, swarm, swarm.next++);
    }

    const done = swarm.results.size + swarm.failures.size;
    if (done < swarm.total || !node) return;

    swarm.settled = true;
    ctx.swarms.delete(nodeId);
    delete ctx.state.activeExecutions[nodeId];
    await this.#releaseAllSwarmWorktrees(swarm);

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
    const scope = {
      input: inputData,
      inputs: inputData,
      output: inputData,
      trigger: inputData,
      nodes: inputData,
      scratchpad: this.deps.scratchpad.snapshotOf(ctx.runId),
    };
    const matches: string[] = [];
    for (const branch of config.branches) {
      if (config.routingMode === 'space_route') {
        const targetSpace = String(inputData.spaceId ?? '');
        if (targetSpace && branch.condition === targetSpace) {
          matches.push(branch.branchId);
          break;
        }
      } else if (evalCondition(branch.condition, scope)) {
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
    const evaluator = this.#resolveEvaluationRuntime(ctx, node);
    if (!evaluator) {
      this.deps.logger.warn('engine.router.llm_route.no_runtime', { nodeId: node.id });
      return this.#executeRouter(ctx, { ...config, routingMode: 'first_match' }, inputData);
    }
    try {
      const branchIds = config.branches.map((b) => b.branchId);
      const decision = await evaluator.routeBranch({
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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // New deterministic primitives â€” wait / transform / filter
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async #executeWait(
    ctx: RunningContext,
    node: WorkflowNode,
    config: WaitNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    // Absolute wake time wins over a relative delay when set: "wait until <ISO>".
    let delayMs: number;
    if (config.untilIso) {
      const untilMs = Date.parse(config.untilIso);
      if (Number.isNaN(untilMs)) {
        throw new AgentisError('VALIDATION_FAILED', `wait node: untilIso '${config.untilIso}' is not a valid ISO 8601 timestamp`);
      }
      delayMs = Math.max(0, untilMs - Date.now());
    } else {
      delayMs = Math.max(0, Math.floor(config.delayMs ?? 0));
    }
    if (delayMs <= 0) {
      await this.#completeNode(ctx, node.id, inputData);
      return;
    }
    // Persist the wake-at on the active execution so a crash mid-wait isn't
    // a silent run loss â€” the WaitRecovery boot scan can pick it up. The
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

  // transform + filter logic now lives in engine/handlers/pureHandlers.ts and
  // is dispatched via #nodeHandlers (NATIVE-ADVANCEMENT Proposal 4).

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Output surface â€” return_output / artifact_save (Layer 6)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
   * content inline in the `artifacts` table â€” the same store used by
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
    // testNode() uses a synthetic `test-â€¦` runId with no workflow_runs row â€”
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
          origin: 'workflow',
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
   * Native browser node (Layer 3 Â§3.2). Renders HTML / navigates URLs via the
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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Integration / HTTP
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async #executeIntegration(
    ctx: RunningContext,
    node: WorkflowNode,
    config: IntegrationNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!config.integrationId) {
      throw new AgentisError('VALIDATION_FAILED', 'integration node missing integrationId');
    }
    if (!config.operationId) {
      throw new AgentisError('VALIDATION_FAILED', 'integration node missing operationId');
    }
    const credential = this.#resolveIntegrationCredential(ctx.workspaceId, config);
    ctx.state.activeExecutions[node.id] = {
      taskId: `integration:${node.id}`,
      nodeId: node.id,
      executorType: 'integration',
      executorRef: `${config.integrationId}.${config.operationId}`,
      startedAt: new Date().toISOString(),
    };
    try {
      const executeOptions = {
        operation: config.operationId,
        params: config.inputs ?? {},
        credential,
        inputData,
      };
      if (this.deps.connectors?.has(config.integrationId)) {
        return await this.deps.connectors.execute(config.integrationId, executeOptions);
      }
      const customManifest = this.#customIntegrationManifest(ctx.workspaceId, config.integrationId);
      if (customManifest) {
        return await manifestHttpConnector(customManifest).execute(executeOptions);
      }
      if (!this.deps.connectors) {
        throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'integration node present but ConnectorRegistry not wired');
      }
      return await this.deps.connectors.execute(config.integrationId, executeOptions);
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  /** `mcp` node — call a registered MCP server's tool via the bridge. */
  async #executeMcp(ctx: RunningContext, node: WorkflowNode, config: McpNodeConfig): Promise<Record<string, unknown>> {
    if (!this.deps.mcpBridge) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'mcp node present but MCP bridge not wired');
    }
    if (!config.toolId) {
      throw new AgentisError('VALIDATION_FAILED', 'mcp node missing toolId');
    }
    ctx.state.activeExecutions[node.id] = {
      taskId: `mcp:${node.id}`,
      nodeId: node.id,
      executorType: 'integration',
      executorRef: config.toolId,
      startedAt: new Date().toISOString(),
    };
    try {
      const result = await this.deps.mcpBridge.call(ctx.workspaceId, config.toolId, config.arguments ?? {});
      if (!result.ok) {
        throw new AgentisError('INTEGRATION_OPERATION_FAILED', `MCP tool ${config.toolId} failed: ${result.error ?? 'unknown error'}`);
      }
      return config.outputKey ? { [config.outputKey]: result.result ?? null } : { result: result.result ?? null };
    } finally {
      delete ctx.state.activeExecutions[node.id];
    }
  }

  /**
   * Resolve the App id for a data node: the node's explicit `appId`, else the
   * App that owns the running workflow (so deterministic persist works without a
   * build-time appId — the App is created after the workflow).
   */
  #resolveDataAppId(ctx: RunningContext, configAppId: string | undefined): string {
    const appId = configAppId ?? this.deps.resolveAppIdForWorkflow?.(ctx.workspaceId, ctx.workflowId);
    if (!appId) {
      throw new AgentisError('VALIDATION_FAILED', 'data node requires an appId (none on the node and no owning App resolvable from the running workflow)');
    }
    return appId;
  }

  /** `data_query` node — read or aggregate an Agentic App datastore collection. */
  #executeDataQuery(ctx: RunningContext, config: DataQueryNodeConfig): Record<string, unknown> {
    if (!this.deps.appData) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'data_query node present but app datastore not wired');
    }
    if (!config.collection) {
      throw new AgentisError('VALIDATION_FAILED', 'data_query node requires a collection');
    }
    const appId = this.#resolveDataAppId(ctx, config.appId);
    if (config.mode === 'aggregate') {
      if (!config.op) throw new AgentisError('VALIDATION_FAILED', 'data_query aggregate requires an op');
      const buckets = this.deps.appData.aggregate(ctx.workspaceId, appId, config.collection, {
        op: config.op,
        ...(config.field ? { field: config.field } : {}),
        ...(config.groupBy ? { groupBy: config.groupBy } : {}),
        ...(config.filter ? { filter: config.filter } : {}),
      });
      return { [config.outputKey ?? 'buckets']: buckets };
    }
    if (config.paginate) {
      // Follow the keyset cursor internally and return every matching row.
      const maxRows = Math.min(Math.max(config.maxRows ?? 1000, 1), 10_000);
      const pageSize = Math.min(config.limit && config.limit > 0 ? config.limit : 200, maxRows);
      const all: unknown[] = [];
      let cursor: string | undefined;
      // Bound the page loop too (defensive against a non-advancing cursor).
      for (let page = 0; page < 1000 && all.length < maxRows; page += 1) {
        const res = this.deps.appData.query(ctx.workspaceId, appId, config.collection, {
          ...(config.filter ? { filter: config.filter } : {}),
          ...(config.sort ? { sort: config.sort } : {}),
          limit: pageSize,
          ...(cursor ? { cursor } : {}),
        });
        for (const row of res.rows) {
          if (all.length >= maxRows) break;
          all.push(row);
        }
        if (!res.nextCursor || res.rows.length === 0) break;
        cursor = res.nextCursor;
      }
      return { [config.outputKey ?? 'rows']: all, count: all.length };
    }
    const res = this.deps.appData.query(ctx.workspaceId, appId, config.collection, {
      ...(config.filter ? { filter: config.filter } : {}),
      ...(config.sort ? { sort: config.sort } : {}),
      ...(config.limit ? { limit: config.limit } : {}),
      ...(config.cursor ? { cursor: config.cursor } : {}),
    });
    return { [config.outputKey ?? 'rows']: res.rows, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
  }

  /** `data_mutate` node — write to an Agentic App datastore collection. */
  #executeDataMutate(ctx: RunningContext, config: DataMutateNodeConfig): Record<string, unknown> {
    if (!this.deps.appData) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'data_mutate node present but app datastore not wired');
    }
    if (!config.collection) {
      throw new AgentisError('VALIDATION_FAILED', 'data_mutate node requires a collection');
    }
    const { workspaceId } = ctx;
    const appId = this.#resolveDataAppId(ctx, config.appId);
    switch (config.operation) {
      case 'insert':
        return { [config.outputKey ?? 'record']: this.deps.appData.insert(workspaceId, appId, config.collection, config.record ?? {}) };
      case 'update': {
        if (!config.recordId) throw new AgentisError('VALIDATION_FAILED', 'data_mutate update requires recordId');
        return { [config.outputKey ?? 'record']: this.deps.appData.update(workspaceId, appId, config.collection, config.recordId, config.record ?? {}) };
      }
      case 'upsert':
        return { [config.outputKey ?? 'record']: this.deps.appData.upsert(workspaceId, appId, config.collection, config.match ?? {}, config.record ?? {}) };
      case 'delete': {
        if (!config.recordId) throw new AgentisError('VALIDATION_FAILED', 'data_mutate delete requires recordId');
        this.deps.appData.delete(workspaceId, appId, config.collection, config.recordId);
        return { [config.outputKey ?? 'deleted']: config.recordId };
      }
      default:
        throw new AgentisError('VALIDATION_FAILED', `data_mutate: unknown operation ${String(config.operation)}`);
    }
  }

  /** `aggregate_window` node — buffer events across runs; emit a batch when the window closes. */
  #executeAggregateWindow(ctx: RunningContext, node: WorkflowNode, config: AggregateWindowNodeConfig, inputData: Record<string, unknown>): Record<string, unknown> {
    if (!this.deps.workflowStore) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'aggregate_window node present but workflow store not wired');
    }
    const { workspaceId, workflowId } = ctx;
    const itemsKey = `__aggwin:${node.id}:${config.key ?? 'default'}`;
    const firstAtKey = `${itemsKey}:firstAt`;
    this.deps.workflowStore.append(workspaceId, workflowId, itemsKey, inputData);
    const buffered = this.deps.workflowStore.get(workspaceId, workflowId, itemsKey);
    const items = Array.isArray(buffered) ? buffered : [];
    let firstAt = Number(this.deps.workflowStore.get(workspaceId, workflowId, firstAtKey) ?? 0);
    if (!firstAt) {
      firstAt = Date.now();
      this.deps.workflowStore.set(workspaceId, workflowId, firstAtKey, firstAt);
    }
    const countReady = config.maxCount ? items.length >= config.maxCount : false;
    const timeReady = config.windowMs ? Date.now() - firstAt >= config.windowMs : false;
    if (countReady || timeReady) {
      // Flush: reset the buffer and emit the batch downstream.
      this.deps.workflowStore.set(workspaceId, workflowId, itemsKey, []);
      this.deps.workflowStore.set(workspaceId, workflowId, firstAtKey, 0);
      return { [config.outputKey ?? 'items']: items, count: items.length, ready: true };
    }
    // Window still open — hold: complete the node but fire NO downstream this run.
    return { __hold: true, ready: false, buffered: items.length };
  }

  #customIntegrationManifest(workspaceId: string, service: string): ReturnType<typeof getCustomIntegrationManifest> | null {
    try {
      return getCustomIntegrationManifest(this.deps.db, workspaceId, service);
    } catch (err) {
      if (err instanceof AgentisError && err.code === 'RESOURCE_NOT_FOUND') return null;
      throw err;
    }
  }

  #resolveIntegrationCredential(workspaceId: string, config: IntegrationNodeConfig): Record<string, unknown> | null {
    const explicitId = config.credentialId?.trim();
    const row = explicitId
      ? this.#credentialRowById(workspaceId, explicitId)
      : this.#credentialRowForIntegration(workspaceId, config.integrationId);
    if (!row) return null;
    if (!this.deps.vault) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'integration credential found but CredentialVault is not wired');
    }
    try {
      const decoded = this.deps.vault.decrypt(row.encryptedValue);
      const parsed = parseJsonOrString(decoded);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : { value: decoded };
    } catch (err) {
      throw new AgentisError('INTEGRATION_CREDENTIAL_MISSING', `failed to decrypt credential: ${(err as Error).message}`);
    }
  }

  #credentialRowById(workspaceId: string, credentialId: string): typeof schema.credentials.$inferSelect {
    const row = this.deps.db
      .select()
      .from(schema.credentials)
      .where(and(eq(schema.credentials.id, credentialId), eq(schema.credentials.workspaceId, workspaceId)))
      .get();
    if (!row) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `credential '${credentialId}' not found`);
    }
    return row;
  }

  #credentialRowForIntegration(workspaceId: string, integrationId: string): typeof schema.credentials.$inferSelect | null {
    const slug = integrationId.toLowerCase();
    const candidates = this.deps.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.workspaceId, workspaceId))
      .all()
      .filter((row) => {
        const type = row.credentialType.toLowerCase();
        return type === slug || type === `integration_${slug}` || type === `oauth_${slug}`;
      });
    return candidates.sort((left, right) => String(right.updatedAt ?? right.createdAt).localeCompare(String(left.updatedAt ?? left.createdAt)))[0] ?? null;
  }

  async #executeHttpRequest(
    ctx: RunningContext,
    node: WorkflowNode,
    config: HttpRequestNodeConfig,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    if (!config.url) throw new AgentisError('VALIDATION_FAILED', 'http_request node missing url');
    const requestUrl = await assertSafeUrl(config.url, {
      allowPrivate: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
    });
    const method = (config.method ?? 'GET').toUpperCase();
    const timeoutMs = Math.max(1, Math.min(config.timeoutMs ?? 30_000, 120_000));
    const maxRetries = Math.max(0, Math.min(config.maxRetries ?? 0, 5));
    const retryOn = new Set((config.retryOn ?? []).map((c) => Number(c)));
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    // AEJ (NATIVE-ADVANCEMENT Proposal 1): on a crash-recovery re-dispatch the
    // node carries a stable idempotency key. Send it as a standard
    // `Idempotency-Key` header so a request that may already have been sent
    // before the crash is deduped server-side — turning the retry into
    // effectively once. Never override an operator-supplied header.
    if (idempotencyKey && !Object.keys(headers).some((h) => h.toLowerCase() === 'idempotency-key')) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    if (config.auth && config.auth.type !== 'none') {
      const credentialId = (config.auth as { credentialId?: string }).credentialId;
      if (!credentialId) {
        throw new AgentisError('VALIDATION_FAILED', 'http_request auth requires credentialId; inline secrets are not allowed');
      }
      if (!this.deps.vault) {
        throw new AgentisError('VALIDATION_FAILED', 'http_request auth requires the credential vault');
      }
      const row = this.deps.db
        .select()
        .from(schema.credentials)
        .where(and(eq(schema.credentials.id, credentialId), eq(schema.credentials.workspaceId, ctx.workspaceId)))
        .get();
      if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `credential '${credentialId}' not found`);
      const secret = this.deps.vault.decrypt(row.encryptedValue);
      switch (config.auth.type) {
        case 'bearer':
          headers['authorization'] = `Bearer ${secret}`;
          break;
        case 'api_key':
          headers[config.auth.header.toLowerCase()] = secret;
          break;
        case 'basic':
          headers['authorization'] = `Basic ${Buffer.from(secret).toString('base64')}`;
          break;
        default:
          break;
      }
    }
    ctx.state.activeExecutions[node.id] = {
      taskId: `http:${node.id}`,
      nodeId: node.id,
      executorType: 'http',
      executorRef: `${method} ${redactUrl(requestUrl.toString())}`,
      startedAt: new Date().toISOString(),
    };
    try {
      let attempt = 0;
      let lastError: Error | null = null;
      while (attempt <= maxRetries) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Honor run-scoped cancellation: a cancelRun() aborts the outbound
        // request instead of letting it finish after the run was cancelled.
        const runSignal = ctx.abortController?.signal;
        const signal = runSignal ? AbortSignal.any([controller.signal, runSignal]) : controller.signal;
        try {
          const res = await fetch(requestUrl, {
            method,
            headers,
            body: method === 'GET' || method === 'DELETE' ? undefined : config.body,
            signal,
            redirect: 'manual',
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

  // ─────────────────────────────────────────────────────────────────────────
  // Utility & data primitives — code / spreadsheet / graphql (WORKFLOW-UPDATE)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * `code` node. JavaScript runs in the engine's guarded VM realm (same sandbox
   * as transform/filter — no Node globals, no require/import). Python is
   * best-effort via a child `python3` process; if Python is not on PATH the node
   * fails with a clean, actionable error.
   */
  async #executeCode(
    ctx: RunningContext,
    node: WorkflowNode,
    config: CodeNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = config.inputKeys && config.inputKeys.length > 0
      ? Object.fromEntries(config.inputKeys.map((k) => [k, inputData[k]]))
      : inputData;
    const wrapResult = (result: unknown): Record<string, unknown> => {
      if (config.outputKey) return { [config.outputKey]: result };
      if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
      return { value: result };
    };

    if (config.language === 'javascript') {
      const result = evaluateExpression<unknown>(config.code, { input }, { timeoutMs: config.timeoutMs });
      return wrapResult(result);
    }

    if (config.language === 'python') {
      const result = await this.#runPython(ctx, config.code, input, config.timeoutMs);
      return wrapResult(result);
    }

    throw new AgentisError('VALIDATION_FAILED', `code: unsupported language ${(config as { language: string }).language}`);
  }

  async #runPython(
    ctx: RunningContext,
    code: string,
    input: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const { spawn } = await import('node:child_process');
    const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
    const timeout = Math.max(1, Math.min(timeoutMs ?? 15_000, 120_000));
    // The user code reads `input` (a dict) and assigns `output`; we print it as JSON.
    const program = [
      'import sys, json',
      'input = json.loads(sys.stdin.read())',
      'output = None',
      'def _main():',
      '    global output',
      ...code.split('\n').map((line) => `    ${line}`),
      '_main()',
      'sys.stdout.write(json.dumps(output))',
    ].join('\n');

    let lastErr = 'python runtime not found';
    for (const bin of candidates) {
      try {
        const result = await new Promise<unknown>((resolve, reject) => {
          const child = spawn(bin, ['-c', program], { stdio: ['pipe', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          const runSignal = ctx.abortController?.signal;
          const onAbort = () => child.kill('SIGKILL');
          runSignal?.addEventListener('abort', onAbort, { once: true });
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`python execution timed out after ${timeout}ms`)); }, timeout);
          child.on('error', (e) => { clearTimeout(timer); reject(e); });
          child.stdout.on('data', (d) => { out += String(d); });
          child.stderr.on('data', (d) => { err += String(d); });
          child.on('close', (codeNum) => {
            clearTimeout(timer);
            runSignal?.removeEventListener('abort', onAbort);
            if (codeNum !== 0) { reject(new Error(err.trim() || `python exited with code ${codeNum}`)); return; }
            try { resolve(out.trim() ? JSON.parse(out) : null); } catch { resolve(out); }
          });
          child.stdin.write(JSON.stringify(input));
          child.stdin.end();
        });
        return result;
      } catch (e) {
        lastErr = (e as Error).message;
        // ENOENT → try the next candidate; a real execution error → surface it.
        if (!/ENOENT|not found|not recognized/i.test(lastErr)) {
          throw new AgentisError('INTEGRATION_OPERATION_FAILED', `code (python) failed: ${lastErr}`);
        }
      }
    }
    throw new AgentisError('EXTENSION_RUNTIME_UNAVAILABLE', `code (python) requires a python interpreter on PATH: ${lastErr}`);
  }

  /** `spreadsheet` node. CSV is built-in; XLSX uses the bundled exceljs. */
  async #executeSpreadsheet(
    node: WorkflowNode,
    config: SpreadsheetNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const key = config.outputKey ?? (config.operation === 'parse' ? 'rows' : 'content');
    const source = config.inputPath ? readDotPath(inputData, config.inputPath) : inputData;
    const hasHeaders = config.hasHeaders !== false;

    if (config.operation === 'parse') {
      if (config.format === 'csv') {
        const rows = parseCsv(asString(source), hasHeaders);
        return { [key]: rows };
      }
      // xlsx parse — source is a base64 string or Buffer.
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const buf = Buffer.isBuffer(source) ? source : Buffer.from(asString(source), 'base64');
      await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
      const ws = config.sheet ? wb.getWorksheet(config.sheet) ?? wb.worksheets[0] : wb.worksheets[0];
      const rows = worksheetToRows(ws, hasHeaders);
      return { [key]: rows };
    }

    // build
    const records = Array.isArray(source) ? (source as Array<Record<string, unknown>>) : [];
    if (config.format === 'csv') {
      return { [key]: buildCsv(records, hasHeaders) };
    }
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(typeof config.sheet === 'string' ? config.sheet : 'Sheet1');
    const headers = records.length > 0 ? Object.keys(records[0]!) : [];
    if (hasHeaders && headers.length) ws.addRow(headers);
    for (const rec of records) ws.addRow(headers.map((h) => rec[h] as unknown));
    const out = await wb.xlsx.writeBuffer();
    return { [key]: Buffer.from(out).toString('base64'), encoding: 'base64' };
  }

  /** `graphql` node — POSTs a structured query to the configured endpoint. */
  async #executeGraphQl(
    ctx: RunningContext,
    node: WorkflowNode,
    config: GraphQlNodeConfig,
  ): Promise<Record<string, unknown>> {
    if (!config.endpoint) throw new AgentisError('VALIDATION_FAILED', 'graphql node missing endpoint');
    const endpoint = await assertSafeUrl(config.endpoint, {
      allowPrivate: String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
    });
    const timeoutMs = Math.max(1, Math.min(config.timeoutMs ?? 30_000, 120_000));
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(config.headers ?? {}) };
    if (config.credentialId) {
      if (!this.deps.vault) throw new AgentisError('VALIDATION_FAILED', 'graphql credential requires the credential vault');
      const row = this.deps.db
        .select()
        .from(schema.credentials)
        .where(and(eq(schema.credentials.id, config.credentialId), eq(schema.credentials.workspaceId, ctx.workspaceId)))
        .get();
      if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `credential '${config.credentialId}' not found`);
      headers['authorization'] = `Bearer ${this.deps.vault.decrypt(row.encryptedValue)}`;
    }
    const variables: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config.variables ?? {})) variables[k] = coerceJson(v);

    ctx.state.activeExecutions[node.id] = {
      taskId: `graphql:${node.id}`,
      nodeId: node.id,
      executorType: 'http',
      executorRef: `GraphQL ${redactUrl(endpoint.toString())}`,
      startedAt: new Date().toISOString(),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const runSignal = ctx.abortController?.signal;
    const signal = runSignal ? AbortSignal.any([controller.signal, runSignal]) : controller.signal;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: config.query, variables }),
        signal,
        redirect: 'manual',
      });
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      const errors = (body as { errors?: unknown[] })?.errors;
      if (!res.ok || (Array.isArray(errors) && errors.length > 0)) {
        throw new AgentisError('INTEGRATION_OPERATION_FAILED', `graphql request failed (status ${res.status}): ${JSON.stringify(errors ?? body).slice(0, 500)}`);
      }
      const data = (body as { data?: unknown })?.data ?? body;
      return config.outputKey ? { [config.outputKey]: data } : { data, ok: true, status: res.status };
    } catch (err) {
      if (err instanceof AgentisError) throw err;
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `graphql request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      delete ctx.state.activeExecutions[node.id];
    }
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Workflow-scoped persistent KV
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Evaluator / Guardrails
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async #executeEvaluator(
    ctx: RunningContext,
    node: WorkflowNode,
    config: EvaluatorNodeConfig,
    inputData: Record<string, unknown>,
    tctx: TemplateContext,
  ): Promise<Record<string, unknown>> {
    if (!config.targetPath) {
      throw new AgentisError('VALIDATION_FAILED', 'evaluator node missing targetPath');
    }
    const evaluator = this.#resolveEvaluationRuntime(ctx, node, config.targetPath);
    if (!evaluator) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        'evaluator node has no dedicated evaluation model and no chat-capable workspace agent',
      );
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
      // Track FAILâ†’retry cycles via a tagged inputData field â€” the evaluator-retry
      // pattern routes back to the upstream agent_task, which receives a bumped
      // iterationCount on each cycle.
      const prevIteration = Number(inputData['__evalIteration'] ?? 0);
      const verdict = await evaluator.evaluate({
        workspaceId: ctx.workspaceId,
        target,
        criteria: config.criteria,
        rubric: config.rubric,
        passThreshold: config.passThreshold,
      });
      try {
        this.deps.sharedIntelligence?.applyEvaluatorVerdict({
          workspaceId: ctx.workspaceId,
          runId: ctx.runId,
          scopeId: null,
          agentId: null,
          verdict: verdict.passed ? 'pass' : 'fail',
          evaluatorConfidence: verdict.score,
        });
      } catch (err) {
        this.deps.logger.warn('engine.evaluator_brain_feedback.failed', { runId: ctx.runId, err: (err as Error).message });
      }
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

  /**
   * Resolve evaluation in agentic-default order:
   * dedicated workspace/runtime model -> evaluated node's agent -> nearest
   * upstream agent -> workspace orchestrator -> any chat-capable workspace agent.
   */
  #resolveEvaluationRuntime(
    ctx: RunningContext,
    node: WorkflowNode,
    targetPath?: string,
  ): EvaluationRuntime | undefined {
    const config = node.config.kind === 'evaluator' ? node.config : null;
    const evaluationTask = config
      ? `${config.criteria}${config.rubric ? `\n${config.rubric}` : ''}`
      : node.title;
    const dedicated =
      this.deps.resolveEvaluatorRuntime?.(ctx.workspaceId, 'evaluation', { task: evaluationTask, purpose: 'workflow_evaluation' })
      ?? this.deps.evaluatorRuntime;
    if (dedicated) return dedicated;
    if (this.deps.modelAssistedRuntimeEnabled?.(ctx.workspaceId) === false) return undefined;

    const preferred = this.#evaluationAgentCandidates(ctx, node, targetPath);
    const workspaceAgents = this.deps.db
      .select({ id: schema.agents.id, role: schema.agents.role })
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ctx.workspaceId))
      .all();
    const workspaceIds = new Set(workspaceAgents.map((agent) => agent.id));
    const orchestratorId = workspaceAgents.find((agent) => agent.role === 'orchestrator')?.id;
    if (orchestratorId) preferred.push({ agentId: orchestratorId });
    for (const registration of this.deps.adapters.list()) {
      if (workspaceIds.has(registration.agentId)) {
        preferred.push({ agentId: registration.agentId });
      }
    }

    const unique = new Map<string, { agentId: string; preferredModel?: string }>();
    for (const candidate of preferred) {
      if (!unique.has(candidate.agentId)) unique.set(candidate.agentId, candidate);
    }
    for (const { agentId, preferredModel } of unique.values()) {
      const registered = this.deps.adapters.get(agentId)?.adapter;
      const adapter = registered ?? this.deps.resolveAgentRuntime?.(ctx.workspaceId, agentId, evaluationTask, preferredModel);
      if (!adapter?.chat || adapter.capabilities?.().interactiveChat === false) continue;
      this.deps.logger.info('engine.evaluator.agent_runtime', {
        nodeId: node.id,
        agentId,
        adapterType: adapter.adapterType,
      });
      return new StructuredEvaluatorRuntime(
        new AdapterStructuredCompleter(adapter, `agent:${agentId}`, preferredModel),
        this.deps.logger,
      );
    }
    return undefined;
  }

  #evaluationAgentCandidates(
    ctx: RunningContext,
    evaluatorNode: WorkflowNode,
    targetPath?: string,
  ): Array<{ agentId: string; preferredModel?: string }> {
    const candidates: Array<{ agentId: string; preferredModel?: string }> = [];
    const visited = new Set<string>();
    const queue: string[] = [];
    const targetNodeId = targetPath ? nodeIdFromTargetPath(ctx.graph, targetPath) : null;
    if (targetNodeId) queue.push(targetNodeId);
    queue.push(...ctx.graph.edges.filter((edge) => edge.target === evaluatorNode.id).map((edge) => edge.source));

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      const sourceNode = ctx.graph.nodes.find((candidate) => candidate.id === nodeId);
      const binding = evaluationAgentBindingFromNode(sourceNode);
      if (binding) candidates.push(binding);
      queue.push(...ctx.graph.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source));
    }
    return candidates;
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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Loop
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    // Resolve items array â€” accept either a `{{path}}` template or a raw dot path.
    let items: unknown;
    if (config.itemsExpression?.includes('{{')) {
      // Stringified pass â€” we need typed access, so read the path directly.
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

    // Durable / idempotent resume (masterplan 1.4): crash recovery re-dispatches
    // an interrupted loop node, so we persist each iteration's result and SKIP it
    // on re-run — side effects fire at most once per iteration instead of the
    // whole loop replaying. `_loopState` is the persisted completed/failed map.
    const priorState = (ctx.state.nodeStates[node.id]?.outputData?._loopState ?? {}) as {
      completed?: Record<string, unknown>;
      failed?: Record<string, string>;
    };
    const completedMap: Record<string, unknown> = { ...(priorState.completed ?? {}) };
    const failedMap: Record<string, string> = { ...(priorState.failed ?? {}) };
    for (const [idx, value] of Object.entries(completedMap)) results[Number(idx)] = value;
    for (const [idx, message] of Object.entries(failedMap)) errors.push({ index: Number(idx), message });

    const persistLoopState = async (chunkEnd: number): Promise<void> => {
      const loopNs = ctx.state.nodeStates[node.id];
      if (!loopNs) return;
      loopNs.outputData = {
        ...(loopNs.outputData ?? {}),
        _loopState: { completed: completedMap, failed: failedMap },
        _loopProgress: { completed: chunkEnd, total: items.length, errors: errors.length },
      };
      await this.#persistRun(ctx);
    };

    for (let chunkStart = 0; chunkStart < items.length; chunkStart += chunkSize) {
      const chunkEnd = Math.min(chunkStart + chunkSize, items.length);
      const chunkIndexes: number[] = [];
      for (let i = chunkStart; i < chunkEnd; i += 1) chunkIndexes.push(i);

      // Process this chunk with bounded concurrency.
      const pool: Array<Promise<void>> = [];
      const next = (async () => {
        let cursor = 0;
        const runOne = async (i: number): Promise<void> => {
          // Already settled on a prior attempt — reuse the persisted outcome.
          if (Object.prototype.hasOwnProperty.call(completedMap, String(i)) || Object.prototype.hasOwnProperty.call(failedMap, String(i))) {
            return;
          }
          try {
            const itemOutput = await this.#runLoopIteration(ctx, node, config, items[i], i);
            results[i] = itemOutput;
            completedMap[String(i)] = itemOutput;
          } catch (err) {
            const message = (err as Error).message;
            errors.push({ index: i, message });
            failedMap[String(i)] = message;
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
        // stop_all: bubble up (persist what completed so a resume skips it).
        delete ctx.state.activeExecutions[node.id];
        await persistLoopState(chunkEnd);
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

      // Persist per-chunk so a crash-recovery re-dispatch resumes from here
      // (skipping completed iterations) instead of replaying the whole loop.
      await persistLoopState(chunkEnd);
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

  // ───────────────────────────────────────────────────────────────────────
  // Convergence loop (`converge`) — AGENT-COOPERATION-10X §Pillar 1.
  // Iterate a cohort sub-graph until a continuation policy says stop. Stateful
  // across iterations via the blackboard, owns one isolated worktree for the
  // whole cohort (§Pillar 3), and stops on goal / stall / budget / ceiling with
  // an honest terminal verdict. No graph cycle — the body subflow is re-invoked.
  // ───────────────────────────────────────────────────────────────────────

  async #dispatchConverge(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
    inputData: Record<string, unknown>,
    _tctx: TemplateContext,
  ): Promise<void> {
    if (!this.deps.subflows) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'converge node present but SubflowExecutor not wired');
    }
    if (!config.bodyWorkflowId) {
      throw new AgentisError('VALIDATION_FAILED', 'converge node missing bodyWorkflowId');
    }
    ctx.state.activeExecutions[node.id] = {
      taskId: `converge:${node.id}`,
      nodeId: node.id,
      executorType: 'converge',
      executorRef: config.bodyWorkflowId,
      startedAt: new Date().toISOString(),
    };
    void this.#runConverge(ctx, node, config, inputData).catch((err) => {
      delete ctx.state.activeExecutions[node.id];
      void this.#failNode(ctx, node.id, (err as Error).message);
      void this.#tick(ctx);
    });
  }

  async #runConverge(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    const stateKey = config.stateKey?.trim() || node.id;
    const maxIterations = Math.max(1, Math.min(config.maxIterations ?? 8, 100));
    const stallWindow = Math.max(1, config.stallPolicy?.window ?? 2);
    const carry = config.carryStrategy ?? 'accumulate';
    const startedAt = Date.now();

    // Durable resume — pick up persisted iteration state after a crash recovery.
    const priorState = (ctx.state.nodeStates[node.id]?.outputData?.['_convergeState'] ?? {}) as ConvergeRunState;
    const history: ConvergeIterationRecord[] = [...(priorState.history ?? [])];
    let iteration = priorState.history?.length ?? 0;
    const accumulated: Record<string, unknown> = { ...(priorState.accumulated ?? {}) };
    let lastSignature: string | undefined = priorState.lastSignature;
    this.deps.scratchpad.hydrate(ctx.runId);

    // §Pillar 3: one worktree the whole cohort shares for the loop lifetime.
    const worktree = await this.#acquireConvergeWorktree(ctx, node, config);
    if (worktree?.path) {
      this.deps.scratchpad.write(
        ctx.runId,
        `${stateKey}.workspace`,
        { path: worktree.path, mode: worktree.mode },
        { namespace: stateKey, identity: CONVERGE_IDENTITY },
      );
    }

    let verdictKind: ConvergeVerdict = 'max_iterations';
    let lastOutput: Record<string, unknown> = priorState.lastOutput ?? {};
    let stallStreak = priorState.stallStreak ?? 0;

    try {
      while (iteration < maxIterations) {
        // Budget breaker — wall clock (always) + real recorded cost / tokens
        // across this run and its descendant cohort runs (when a spend resolver
        // is wired). Any crossed limit stops the loop with an honest verdict.
        if (this.#convergeBudgetExceeded(ctx, config.budget, startedAt)) {
          verdictKind = 'budget_exhausted';
          break;
        }

        const iterStart = Date.now();
        const iterInput: Record<string, unknown> = {
          ...inputData,
          converge: {
            iteration,
            stateKey,
            state: carry === 'replace' ? lastOutput : accumulated,
            workspace: worktree?.path ? { path: worktree.path, mode: worktree.mode } : undefined,
          },
        };

        const rawOutput = await this.#runConvergeIteration(ctx, node, config, iterInput, iteration);
        // The body must not feed our control envelope back into shared state — a
        // body that echoes its inputs would otherwise create a self-referential
        // cycle (state → converge → state) that breaks run-state serialization.
        const output = stripConvergeEnvelope(rawOutput);
        lastOutput = output;

        if (carry === 'accumulate') {
          Object.assign(accumulated, output);
        } else {
          for (const k of Object.keys(accumulated)) delete accumulated[k];
          Object.assign(accumulated, output);
        }

        // Record this iteration's output so the operator + next pass can read it.
        this.deps.scratchpad.write(ctx.runId, `${stateKey}.iteration.${iteration}`, output, {
          namespace: stateKey,
          iteration,
          identity: CONVERGE_IDENTITY,
        });

        const decision = await this.#evaluateConvergeContinuation(ctx, node, config, output, iteration);

        // Stall detection — the efficiency guard. Two consecutive no-change
        // iterations (default) means we're spinning; stop with an honest verdict.
        const signature = convergeStableSignature(output);
        if (lastSignature !== undefined && signature === lastSignature) stallStreak += 1;
        else stallStreak = 0;
        lastSignature = signature;

        const record: ConvergeIterationRecord = {
          iteration,
          durationMs: Date.now() - iterStart,
          continue: decision.continue,
          verdict: decision.verdict,
          score: decision.score,
          critique: decision.critique,
          stallStreak,
        };
        history.push(record);
        iteration += 1;

        await this.#persistConvergeState(ctx, node, { history, accumulated, lastSignature, lastOutput, stallStreak });
        this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CONVERGE_ITERATION, {
          runId: ctx.runId,
          nodeId: node.id,
          ...record,
          spendMs: Date.now() - startedAt,
          maxIterations,
        });

        if (!decision.continue) {
          verdictKind = 'goal_met';
          break;
        }
        if (config.stallPolicy && stallStreak + 1 >= stallWindow) {
          verdictKind = 'stalled';
          break;
        }
      }

      const preserveResult = worktree ? await worktree.release() : { preserved: false };
      delete ctx.state.activeExecutions[node.id];

      // Graduate the converged knowledge from the run-scoped blackboard to durable
      // workspace memory — but only when the goal was actually met, and only the
      // surviving (non-superseded) claims, gated by the Brain's formation judge.
      if (verdictKind === 'goal_met') {
        await this.#promoteConvergedKnowledge(ctx, node, stateKey, lastOutput);
      }

      const result: Record<string, unknown> = {
        converged: verdictKind === 'goal_met',
        verdict: verdictKind,
        iterations: iteration,
        history,
        output: lastOutput,
        state: accumulated,
      };
      if (preserveResult.preserved) {
        result['branch'] = preserveResult.branch;
        if (preserveResult.prUrl) result['prUrl'] = preserveResult.prUrl;
        result['changedFiles'] = preserveResult.changedFiles;
      }

      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CONVERGE_SETTLED, {
        runId: ctx.runId,
        nodeId: node.id,
        verdict: verdictKind,
        iterations: iteration,
        preserved: preserveResult,
      });
      await this.#completeNode(ctx, node.id, result);
      void this.#tick(ctx);
    } catch (err) {
      if (worktree) await worktree.release().catch(() => {});
      throw err;
    }
  }

  /** Run one convergence iteration by delegating the body cohort to SubflowExecutor. */
  async #runConvergeIteration(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
    inputs: Record<string, unknown>,
    iteration: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      void this.deps.subflows!.start({
        parentRunId: ctx.runId,
        parentNodeId: `${node.id}:iter:${iteration}`,
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        childWorkflowId: config.bodyWorkflowId,
        inputs,
        resumeParent: async (output) => resolve(output ?? {}),
        failParent: async (msg) => reject(new Error(msg)),
        startChildRun: async (childArgs) => {
          const handle = await this.startRun(childArgs);
          return { runId: handle.runId };
        },
      });
    });
  }

  /**
   * Decide whether the loop should run another iteration. Three pluggable
   * sources, one interface (deterministic | judge | signal). `continue: true`
   * means keep iterating; `false` means the goal is met.
   */
  async #evaluateConvergeContinuation(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
    output: Record<string, unknown>,
    iteration: number,
  ): Promise<{ continue: boolean; verdict: string; score?: number; critique?: string }> {
    const cont = config.continuation;

    if (cont.type === 'deterministic') {
      const expr = cont.expr.replace(/^\{\{\s*|\s*\}\}$/g, '');
      let keepGoing = false;
      try {
        keepGoing = evalCondition(expr, {
          body: output,
          output,
          iteration,
          scratchpad: this.deps.scratchpad.snapshotOf(ctx.runId),
        });
      } catch (err) {
        // A broken predicate stops the loop (fail-safe) rather than spin forever.
        this.deps.logger.warn('converge.continuation.expr_failed', { nodeId: node.id, err: (err as Error).message });
        keepGoing = false;
      }
      return { continue: keepGoing, verdict: keepGoing ? 'open' : 'converged' };
    }

    if (cont.type === 'signal') {
      const channel = cont.channel?.trim() || 'converge';
      const msgs = this.deps.scratchpad.readChannel(ctx.runId, channel, 10);
      const done = msgs.some((m) => /^done\b|__converge_done__/i.test(m.message));
      return { continue: !done, verdict: done ? 'signalled_done' : 'open' };
    }

    // judge
    const evaluator = this.#resolveEvaluationRuntime(ctx, node, cont.targetPath);
    if (!evaluator) {
      this.deps.logger.warn('converge.continuation.no_evaluator', { nodeId: node.id });
      // Without a judge we cannot assess convergence — stop to avoid an unbounded loop.
      return { continue: false, verdict: 'no_evaluator' };
    }
    const target = readDotPath(output, cont.targetPath) ?? output;
    const verdict = await evaluator.evaluate({
      workspaceId: ctx.workspaceId,
      target,
      criteria: cont.criteria,
      rubric: cont.rubric,
      passThreshold: cont.passThreshold,
    });
    try {
      this.deps.sharedIntelligence?.applyEvaluatorVerdict({
        workspaceId: ctx.workspaceId,
        runId: ctx.runId,
        scopeId: null,
        agentId: null,
        verdict: verdict.passed ? 'pass' : 'fail',
        evaluatorConfidence: verdict.score,
      });
    } catch {
      /* best-effort brain feedback */
    }
    return {
      continue: !verdict.passed,
      verdict: verdict.passed ? 'pass' : 'fail',
      score: verdict.score,
      critique: verdict.critique,
    };
  }

  /** Acquire the cohort's shared isolated worktree (or none for `isolation: 'shared'`). */
  async #acquireConvergeWorktree(
    ctx: RunningContext,
    node: WorkflowNode,
    config: ConvergeNodeConfig,
  ): Promise<WorktreeHandle | undefined> {
    if (config.isolation === 'shared') return undefined;
    if (!this.deps.worktrees) return undefined;
    const baseCwd = this.#resolveConvergeBaseCwd();
    if (!baseCwd) return undefined;
    const preserve = config.preserve ?? 'discard';
    try {
      const handle = await this.deps.worktrees.acquire({
        baseCwd,
        taskId: `run-${ctx.runId.slice(0, 8)}-${node.id}`,
        preserve,
        branchName: preserve !== 'discard' ? `agentis/run-${ctx.runId.slice(0, 8)}` : undefined,
        commitMessage: `Agentis cooperative loop — ${node.title ?? node.id}`,
      });
      if (!handle.path) {
        await handle.release().catch(() => {});
        return undefined;
      }
      this.deps.logger.info('converge.worktree.acquired', {
        runId: ctx.runId,
        nodeId: node.id,
        mode: handle.mode,
      });
      return handle;
    } catch (err) {
      this.deps.logger.warn('converge.worktree.acquire_failed', { runId: ctx.runId, nodeId: node.id, err: (err as Error).message });
      return undefined;
    }
  }

  /** Pick a base repo cwd from any registered local adapter (single-operator OSS). */
  #resolveConvergeBaseCwd(): string | undefined {
    for (const reg of this.deps.adapters.list()) {
      const wd = this.deps.adapters.workdirOf(reg.agentId);
      if (wd) return wd;
    }
    return undefined;
  }

  /** Persist iteration state so a crash-recovery re-dispatch resumes mid-loop. */
  async #persistConvergeState(ctx: RunningContext, node: WorkflowNode, state: ConvergeRunState): Promise<void> {
    const ns = ctx.state.nodeStates[node.id];
    if (!ns) return;
    ns.outputData = {
      ...(ns.outputData ?? {}),
      _convergeState: state,
      _convergeProgress: {
        iterations: state.history?.length ?? 0,
        lastVerdict: state.history?.at(-1)?.verdict,
      },
    };
    await this.#persistRun(ctx);
  }

  /**
   * Whether the loop has crossed any budget limit. Wall-clock is always enforced;
   * cost (cents) and tokens are enforced against REAL recorded spend across this
   * run and its descendant cohort runs when a spend resolver is wired.
   */
  #convergeBudgetExceeded(
    ctx: RunningContext,
    budget: ConvergeNodeConfig['budget'],
    startedAt: number,
  ): boolean {
    if (!budget) return false;
    if (budget.ms !== undefined && Date.now() - startedAt > budget.ms) return true;
    if (budget.usd === undefined && budget.tokens === undefined) return false;
    const spend = this.deps.resolveRunSpend?.(ctx.runId);
    if (!spend) return false; // No real signal → don't fabricate enforcement.
    if (budget.usd !== undefined && spend.costCents / 100 > budget.usd) return true;
    if (budget.tokens !== undefined && spend.tokens > budget.tokens) return true;
    return false;
  }

  /**
   * Promote a converged loop's surviving claims (and final result) from the
   * run-scoped blackboard into durable workspace memory, via the Brain's
   * formation gate (which rejects garbage). Best-effort: never blocks the run.
   */
  async #promoteConvergedKnowledge(
    ctx: RunningContext,
    node: WorkflowNode,
    stateKey: string,
    lastOutput: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.sharedIntelligence) return;
    try {
      const entries = this.deps.scratchpad.listEntries(ctx.runId, { namespace: stateKey });
      const claimEntries = entries.filter((e) => e.kind === 'claim');
      // Drop disputed/revised claims — keep only the surviving truth.
      const superseded = new Set(claimEntries.map((e) => e.supersedes).filter((id): id is string => Boolean(id)));
      const survivingClaims = claimEntries
        .filter((e) => !superseded.has(e.id))
        .map((e) => String(e.value ?? ''))
        .filter((s) => s.trim());
      if (survivingClaims.length === 0 && Object.keys(lastOutput).length === 0) return;
      await this.deps.sharedIntelligence.promote({
        workspaceId: ctx.workspaceId,
        runId: ctx.runId,
        nodeId: node.id,
        taskTitle: `Converged: ${node.title ?? node.id}`,
        taskOutput: { convergedClaims: survivingClaims, result: lastOutput },
      });
    } catch (err) {
      this.deps.logger.warn('converge.promote.failed', { runId: ctx.runId, nodeId: node.id, err: (err as Error).message });
    }
  }

  async #executeCheckpoint(
    ctx: RunningContext,
    node: WorkflowNode,
    config: CheckpointNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    // `task_id` has an FK to `tasks` â€” we can't stash the node id there, so the
    // resume target is tracked in-memory keyed by the approval id.
    const approvalCopy = checkpointApprovalCopy(ctx, node, inputData);
    const approval = await this.deps.approvals.create({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      runId: ctx.runId,
      taskId: null,
      targetId: node.id,
      gatewayId: null,
      source: 'checkpoint',
      title: approvalCopy.title,
      summary: approvalCopy.summary,
      confidence: null,
    });
    this.#pendingApprovals(ctx).set(approval.id, { kind: 'checkpoint', targetId: node.id });
    // Mark node WAITING; an explicit operator approval will resume the run
    // through ApprovalInboxService.resolve() â†’ engine.notifyTaskCompleted().
    const ns = ctx.state.nodeStates[node.id]!;
    ns.status = 'WAITING';
    await this.#persistRun(ctx);
    this.deps.bus.publish(
      REALTIME_ROOMS.run(ctx.runId),
      REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
      { runId: ctx.runId, nodeId: node.id, reason: 'checkpoint' },
    );
    // `auto_after_timeout`: if no operator decision arrives within `timeoutMs`,
    // auto-approve and resume. Goes through the same ApprovalInboxService.resolve
    // path an operator uses, so the row is marked resolved and the run resumes via
    // the bound checkpoint handler. If the operator already decided, `resolve`
    // throws RESOURCE_CONFLICT (status != pending) and we no-op. (In-memory timer:
    // a process restart before it fires falls back to manual approval.)
    if (config.approvalMode === 'auto_after_timeout' && (config.timeoutMs ?? 0) > 0) {
      const timer = setTimeout(() => {
        void this.deps.approvals
          .resolve({
            workspaceId: ctx.workspaceId,
            approvalId: approval.id,
            decision: 'approve',
            reason: 'auto-approved after checkpoint timeout',
          })
          .catch(() => { /* already resolved by the operator, or the run moved on */ });
      }, config.timeoutMs);
      timer.unref?.();
    }
  }

  /**
   * `human_input`: pause the run and collect structured form values from a human,
   * then resume with those values as the node output. Reuses the checkpoint
   * approval/resume path (source 'checkpoint'); `resolveApproval` detects the
   * human_input node and completes it with the submitted `data` instead of a
   * bare `{ approved: true }`.
   */
  async #executeHumanInput(
    ctx: RunningContext,
    node: WorkflowNode,
    config: HumanInputNodeConfig,
    _inputData: Record<string, unknown>,
  ): Promise<void> {
    const fieldCount = Array.isArray(config.fields) ? config.fields.length : 0;
    const approval = await this.deps.approvals.create({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      userId: ctx.userId,
      runId: ctx.runId,
      taskId: null,
      targetId: node.id,
      gatewayId: null,
      source: 'checkpoint',
      title: (config.prompt?.trim() || `Provide input: ${node.title}`).slice(0, 200),
      summary: `Fill ${fieldCount} field(s) to continue.`,
      confidence: null,
    });
    this.#pendingApprovals(ctx).set(approval.id, { kind: 'checkpoint', targetId: node.id });
    const ns = ctx.state.nodeStates[node.id]!;
    ns.status = 'WAITING';
    await this.#persistRun(ctx);
    // Carry the form spec so the UI can render the inputs to collect.
    this.deps.bus.publish(
      REALTIME_ROOMS.run(ctx.runId),
      REALTIME_EVENTS.NODE_WAITING_FOR_INPUT,
      { runId: ctx.runId, nodeId: node.id, reason: 'human_input', approvalId: approval.id, form: { prompt: config.prompt ?? null, fields: config.fields } },
    );
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Lifecycle helpers
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Phase execution model (Layer 5): SLA tracking + budget governance
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  #phaseRuntime(ctx: RunningContext): Map<string, PhaseRuntimeState> {
    if (!ctx.phaseRuntime) ctx.phaseRuntime = new Map();
    return ctx.phaseRuntime;
  }

  #pendingApprovals(ctx: RunningContext): Map<string, PendingApproval> {
    if (!ctx.pendingApprovals) ctx.pendingApprovals = new Map();
    return ctx.pendingApprovals;
  }

  #nodeRetryAttempts(ctx: RunningContext): Map<string, number> {
    if (!ctx.nodeRetryAttempts) ctx.nodeRetryAttempts = new Map();
    return ctx.nodeRetryAttempts;
  }

  #nodeDispatchCounts(ctx: RunningContext): Map<string, number> {
    if (!ctx.nodeDispatchCounts) ctx.nodeDispatchCounts = new Map();
    return ctx.nodeDispatchCounts;
  }

  /** Whether a failed node qualifies for generic `retryPolicy` re-dispatch. */
  #shouldGenericRetry(node: WorkflowNode, error: string): boolean {
    const policy = node.retryPolicy;
    if (!policy || !(policy.maxAttempts > 0)) return false;
    // Agent-like kinds run through self-heal / AgentRetryPolicy — never double-retry.
    if (GENERIC_RETRY_EXCLUDED_KINDS.has(node.config.kind)) return false;
    // Self-heal-terminal / recoverable-model errors are handled separately upstream.
    if (isSelfHealTerminalError(error)) return false;
    if (policy.retryOn && policy.retryOn.length > 0) {
      const lc = error.toLowerCase();
      if (!policy.retryOn.some((s) => lc.includes(s.toLowerCase()))) return false;
    }
    return true;
  }

  /**
   * Route an approval resolution to the right resume path (checkpoint node or
   * phase gate). The resume target is looked up from the in-memory map keyed by
   * the approval id. Public â€” called from the approval-resolution wiring.
   */
  async resolveApproval(args: { runId: string; approvalId: string; decision: 'approve' | 'reject'; data?: Record<string, unknown> }): Promise<void> {
    const ctx = this.#runs.get(args.runId) ?? this.#ensureRecoveredCtx(args.runId);
    if (!ctx) return;
    const pending = ctx.pendingApprovals?.get(args.approvalId) ?? this.#recoverPendingApproval(ctx, args.approvalId);
    if (!pending) return;
    ctx.pendingApprovals!.delete(args.approvalId);
    if (pending.kind === 'phase_gate') {
      if (args.decision === 'approve') await this.resumePhaseGate({ runId: args.runId, phaseId: pending.targetId });
      else await this.failRunForGate({ runId: args.runId, phaseId: pending.targetId, reason: 'Phase gate rejected' });
      return;
    }
    if (pending.kind === 'session') {
      // Resume the session either way â€” the agent decides what to do with a
      // rejection. Missing bookkeeping means the run moved on; ignore.
      if (!pending.sessionId || !pending.toolCallId || !pending.runCtx) return;
      const node = ctx.graph.nodes.find((n) => n.id === pending.targetId);
      if (!node) return;
      await this.#wakeSession(ctx, node, pending.sessionId, pending.runCtx, pending.toolCallId, {
        approved: args.decision === 'approve',
        decision: args.decision,
      });
      return;
    }
    if (pending.kind === 'self_heal') {
      // W7 approve mode: apply the certified patch + re-run the node; on reject,
      // fail the node honestly (no silent bad apply).
      const node = ctx.graph.nodes.find((candidate) => candidate.id === pending.targetId);
      if (args.decision === 'approve' && pending.healAction === 'retry_with_repair_context' && node) {
        const retried = await this.#retryWithRepairContext(
          ctx,
          node,
          pending.retryError ?? 'Previous attempt failed.',
          pending.retryDiagnosis ?? 'Retry requested by self-healing.',
          pending.retryAttempt ?? 1,
          pending.retryMaxAttempts ?? 1,
          'guarded',
        );
        this.#audit(ctx, { nodeId: pending.targetId, action: 'self_heal.retry_approved', actorType: 'user', actorId: 'operator', outputSummary: retried ? 'approved and retried' : 'approved but retry failed' });
        if (!retried) void this.#tick(ctx);
      } else if (args.decision === 'approve' && pending.healPatch) {
        const applied = await this.#applyHealAndRedispatch(ctx, pending.healResumeNodeId ?? pending.targetId, pending.healPatch, pending.repairPlanId);
        if (node) {
          if (pending.repairPlanId) this.#completeRepairPlan(ctx, node, pending.repairPlanId, applied ? 'applied' : 'blocked');
          this.#recordSelfHealIncident(ctx, node, {
            status: applied ? 'APPLIED' : 'BLOCKED',
            outcome: applied ? 'graph_patch_applied' : 'blocked',
            reason: applied ? 'Operator approved the self-healing fix.' : 'Approved self-healing patch could not be applied.',
          });
          await this.#persistRun(ctx).catch(() => {});
        }
        if (!applied) await this.#failNode(ctx, pending.targetId, 'self-healing patch could not be applied');
        this.#audit(ctx, { nodeId: pending.targetId, action: 'self_heal.approved', actorType: 'user', actorId: 'operator', outputSummary: applied ? 'approved and applied' : 'approved but apply failed' });
      } else {
        if (node) {
          if (pending.repairPlanId) this.#completeRepairPlan(ctx, node, pending.repairPlanId, 'rejected');
          this.#recordSelfHealIncident(ctx, node, {
            status: 'BLOCKED',
            outcome: 'blocked',
            reason: 'Self-healing fix was rejected by the operator.',
          });
          await this.#persistRun(ctx).catch(() => {});
        }
        await this.#failNode(ctx, pending.targetId, 'self-healing fix was rejected by the operator');
        this.#audit(ctx, { nodeId: pending.targetId, action: 'self_heal.rejected', actorType: 'user', actorId: 'operator', outputSummary: 'operator rejected repair' });
        void this.#tick(ctx);
      }
      return;
    }
    // checkpoint / human_input. A human_input node completes with the SUBMITTED
    // form values as its output; a plain checkpoint completes with { approved }.
    const resolvedNode = ctx.graph.nodes.find((n) => n.id === pending.targetId);
    if (resolvedNode?.config.kind === 'human_input') {
      if (args.decision === 'approve') {
        const cfg = resolvedNode.config as HumanInputNodeConfig;
        const submitted = args.data ?? {};
        const output = cfg.outputKey ? { [cfg.outputKey]: submitted } : submitted;
        await this.notifyTaskCompleted({ runId: args.runId, nodeId: pending.targetId, output });
      } else {
        // The human declined to provide input — fail the node so the run doesn't hang.
        await this.#failNode(ctx, pending.targetId, 'human input was declined');
        void this.#tick(ctx);
      }
      return;
    }
    // checkpoint: approve completes the node; reject leaves it waiting (V1).
    if (args.decision === 'approve') {
      await this.notifyTaskCompleted({ runId: args.runId, nodeId: pending.targetId, output: { approved: true } });
    }
  }

  #recoverPendingApproval(ctx: RunningContext, approvalId: string): PendingApproval | null {
    const row = this.deps.db
      .select()
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.id, approvalId), eq(schema.approvalRequests.runId, ctx.runId)))
      .get();
    if (!row?.targetId) return null;
    const kind = row.source === 'phase_gate'
      ? 'phase_gate'
      : row.source === 'self_heal'
        ? 'self_heal'
        : row.source === 'checkpoint'
          ? 'checkpoint'
          : null;
    if (!kind) return null;
    if (kind === 'self_heal') {
      const payload = row.payload as Record<string, unknown> | null;
      if (payload?.kind === 'retry_with_repair_context') {
        const pending: PendingApproval = {
          kind,
          targetId: row.targetId,
          healAction: 'retry_with_repair_context',
          retryError: typeof payload.error === 'string' ? payload.error : 'Previous attempt failed.',
          retryDiagnosis: typeof payload.diagnosis === 'string' ? payload.diagnosis : 'Retry requested by self-healing.',
          retryAttempt: typeof payload.attempt === 'number' ? payload.attempt : 1,
          retryMaxAttempts: typeof payload.maxAttempts === 'number' ? payload.maxAttempts : 1,
        };
        this.#pendingApprovals(ctx).set(approvalId, pending);
        return pending;
      }
      const healPatch = selfHealPatchFromPayload(row.payload);
      if (!healPatch) return null;
      const pending: PendingApproval = {
        kind,
        targetId: row.targetId,
        healAction: 'graph_patch',
        healPatch,
        healResumeNodeId: typeof payload?.resumeNodeId === 'string' ? payload.resumeNodeId : undefined,
        repairPlanId: typeof payload?.repairPlanId === 'string' ? payload.repairPlanId : undefined,
      };
      this.#pendingApprovals(ctx).set(approvalId, pending);
      return pending;
    }
    const pending: PendingApproval = { kind, targetId: row.targetId };
    this.#pendingApprovals(ctx).set(approvalId, pending);
    return pending;
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
   * Per-run workflow cost ceiling (Â§5.3): the middle budget tier between
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
   * Workspace/day cost ceiling (Â§5.3): the outermost budget cage above per-phase.
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
        targetId: phaseId,
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
   * the gate and re-enters the dispatch loop. Public â€” called from the approval
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

  /** Fail a run because a phase gate was rejected. Public â€” called from approval resolution. */
  async failRunForGate(args: { runId: string; phaseId: string; reason: string }): Promise<void> {
    const ctx = this.#runs.get(args.runId);
    if (!ctx) {
      await this.#cancelPersistedRun(args.runId);
      return;
    }
    this.#audit(ctx, { action: 'human_gate.rejected', actorType: 'user', actorId: 'operator', outputSummary: `phase ${args.phaseId}: ${args.reason}` });
    markOpenNodesSkipped(ctx.state, args.reason);
    await this.#transitionRunStatus(ctx, 'FAILED');
    this.#disposeRunState(args.runId);
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
  ): Promise<Record<string, unknown> | null> {
    const ns = ctx.state.nodeStates[nodeId];
    if (!ns) return null;
    const completedNode = ctx.graph.nodes.find((n) => n.id === nodeId);
    // W5.0/W7 — the universal completion chokepoint. If the output misses its
    // declared contract, self-heal (recover from the agent's own output, or
    // apply/queue a structural repair) before failing. structural outcomes
    // re-dispatch or pause the node — abort this completion.
    let normalizedOutput: Record<string, unknown>;
    try {
      normalizedOutput = completedNode ? normalizeDeclaredNodeOutput(completedNode, output) : output;
    } catch (err) {
      const heal = completedNode ? await this.#runSelfHeal(ctx, completedNode, output, (err as Error).message) : { kind: 'none' as const };
      if (heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval') return null;
      if (heal.kind !== 'output_fixed') throw new Error(selfHealFailureMessage((err as Error).message, heal));
      normalizedOutput = completedNode ? normalizeDeclaredNodeOutput(completedNode, heal.output) : heal.output;
    }
    let normalization = completedNode
      ? normalizeDeclaredNodeOutputResult(completedNode, normalizedOutput)
      : outputNormalization(normalizedOutput);
    if (completedNode && normalization.missingKeys.length > 0) {
      const missingMessage = missingDeclaredOutputMessage(completedNode, normalization.missingKeys);
      const heal = await this.#runSelfHeal(
        ctx,
        completedNode,
        output,
        missingMessage,
      );
      if (heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval') return null;
      if (heal.kind === 'output_fixed') {
        normalization = normalizeDeclaredNodeOutputResult(completedNode, heal.output);
        normalizedOutput = normalization.output;
      } else if (heal.kind === 'none' && heal.reason) {
        throw new Error(selfHealFailureMessage(missingMessage, heal));
      }
    }
    const deviation = normalization.missingKeys.length > 0
      ? buildContractDeviation(completedNode, normalization)
      : undefined;
    ns.status = 'COMPLETED';
    ns.completedAt = new Date().toISOString();
    ns.outputData = normalizedOutput;
    if (deviation) ns.contractDeviation = deviation;
    else delete ns.contractDeviation;
    if (!ctx.state.completedNodeIds.includes(nodeId)) ctx.state.completedNodeIds.push(nodeId);
    delete ctx.state.activeExecutions[nodeId];

    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: 'node.completed',
      nodeId,
      payload: { output: normalizedOutput },
    });
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_COMPLETED, {
      runId: ctx.runId,
      nodeId,
      outputPreview: compactRealtimePayload(normalizedOutput),
    });
    if (deviation) {
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.CONTRACT_VIOLATION, {
        runId: ctx.runId,
        nodeId,
        violations: [deviation.message],
        deviation,
      });
    }
    if (completedNode) this.#emitWorkStep(ctx, completedNode, 'complete');
    this.#audit(ctx, {
      nodeId,
      action: 'node.completed',
      actorType: completedNode && (completedNode.config.kind === 'agent_task' || completedNode.config.kind === 'agent_swarm') ? 'agent' : 'system',
      actorId: completedNode ? nodeActorId(completedNode) : 'engine',
      outputSummary: summarizeForAudit(normalizedOutput),
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
      return normalizedOutput;
    }

    // Per-run workflow ceiling (Â§5.3) â€” the middle budget tier.
    if (completedNode && this.#workflowRunBudgetExceeded(ctx, completedNode)) {
      ctx.budgetHalt = true;
      markOpenNodesSkipped(ctx.state, 'Halted: workflow run budget exceeded');
      await this.#persistRun(ctx);
      return normalizedOutput;
    }

    // Workspace/day ceiling (Â§5.3) â€” the outermost budget cage. Checked after
    // every node so a single run can't blow the workspace's daily allowance.
    if (this.#workspaceDailyBudgetExceeded(ctx)) {
      ctx.budgetHalt = true;
      markOpenNodesSkipped(ctx.state, 'Halted: workspace daily budget exceeded');
      await this.#persistRun(ctx);
      return normalizedOutput;
    }

    // Fan out to downstream nodes. Error edges are reserved for `#failNode`
    // and must NOT be traversed on a successful completion â€” but their
    // downstream target IS still waiting on this source's id. Drop it from
    // the required list so the target doesn't block the run from settling.
    // `__hold`: a node (e.g. aggregate_window with an open window) completed but
    // explicitly defers its downstream — fire NO outgoing edges this run; drop
    // this node from each target's required inputs so the run still settles.
    const held = (normalizedOutput as { __hold?: unknown } | null)?.__hold === true;

    for (const edge of ctx.downstreamEdges.get(nodeId) ?? []) {
      const buf = ctx.state.waitingInputs[edge.target];
      if (!buf) continue;

      if (held) {
        buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
        this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: upstream is buffering (window still open)');
        continue;
      }

      if (edge.type === 'error') {
        // Catch branch â€” source completed successfully, so this edge never
        // fires. Drop it from required; the join gate decides whether the
        // target can still be fed (promote) or is now unreachable (skip).
        buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
        this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: catch-only branch with no error to handle');
        continue;
      }

      // Conditional / branch edge gating (router branches, filter gates, etc.).
      if (!shouldTraverseEdge(edge, normalizedOutput, this.deps.scratchpad.snapshotOf(ctx.runId))) {
          // NATIVE-ADVANCEMENT Proposal 3 (Agentis-native skip propagation):
          // the branch was NOT taken, so this edge will never deliver. Drop it
          // from the target's required inputs so the target doesn't block the
          // run forever; the join gate then promotes (if another branch already
          // satisfied it) or skip-cascades when nothing else can feed it.
          buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
          this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: branch condition not met');
          continue;
      }

      buf.receivedInputs[nodeId] = normalizedOutput;
      buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
      this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: upstream path never produced an input');
    }

    await this.#maybeSnapshot(ctx);
    await this.#persistRun(ctx);
    return normalizedOutput;
  }

  /**
   * Agentis-native skip propagation (NATIVE-ADVANCEMENT Proposal 3). A node that
   * can never receive its required inputs (an untaken branch's subtree) is
   * marked SKIPPED; since it will never complete, its outgoing edges will never
   * fire either, so we drop it from each downstream target's required inputs and
   * recursively skip any target that thereby becomes unreachable. This is the
   * "the silence is intentional and structural" behaviour without a Pulse table.
   */
  #skipUnreachable(ctx: RunningContext, nodeId: string, reason: string): void {
    const ns = ctx.state.nodeStates[nodeId];
    // Only skip nodes that haven't started/finished on another path.
    if (!ns || ns.status === 'COMPLETED' || ns.status === 'SKIPPED'
      || ns.status === 'RUNNING' || ns.status === 'WAITING') {
      return;
    }
    ns.status = 'SKIPPED';
    ns.completedAt = new Date().toISOString();
    if (!ctx.state.skippedNodeIds.includes(nodeId)) ctx.state.skippedNodeIds.push(nodeId);
    delete ctx.state.waitingInputs[nodeId];
    delete ctx.state.activeExecutions[nodeId];
    this.deps.logger.debug?.('engine.node.skipped', { runId: ctx.runId, nodeId, reason });
    for (const edge of ctx.downstreamEdges.get(nodeId) ?? []) {
      if (!ctx.state.waitingInputs[edge.target]) continue;
      ctx.state.waitingInputs[edge.target]!.requiredInputs =
        ctx.state.waitingInputs[edge.target]!.requiredInputs.filter((id) => id !== nodeId);
      this.#promoteOrSkipTarget(ctx, edge.target, reason);
    }
  }

  /**
   * Pause a node on a recoverable infrastructure failure (out of credits / model
   * billing). The node parks in WAITING with a `blockedReason`, the run settles to
   * WAITING, and the operator can fix the cause and `resumeBlockedRun` from here —
   * nothing is lost and the run never lies "running".
   */
  async #pauseNodeBlocked(ctx: RunningContext, nodeId: string, reason: string): Promise<void> {
    const ns = ctx.state.nodeStates[nodeId];
    if (!ns) return;
    delete ctx.state.activeExecutions[nodeId];
    ns.status = 'WAITING';
    ns.blockedReason = reason;
    this.deps.logger.warn('engine.node.paused_blocked', { runId: ctx.runId, nodeId, reason });
    await this.deps.ledger.append({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId,
      runId: ctx.runId,
      eventType: 'node.failed',
      nodeId,
      payload: { error: reason, paused: true, recoverable: true },
    }).catch(() => {});
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_WAITING_FOR_INPUT, {
      runId: ctx.runId, nodeId, reason: 'blocked', detail: reason,
    });
    const node = ctx.graph.nodes.find((n) => n.id === nodeId);
    if (node) this.#emitWorkStep(ctx, node, 'fail', `Paused — ${reason}`);
    this.#audit(ctx, { nodeId, action: 'node.paused', actorType: 'system', actorId: 'engine', outputSummary: reason });
    // Persist node state (blockedReason) then set the run status column to WAITING.
    await this.#persistRun(ctx);
    await this.#transitionRunStatus(ctx, 'WAITING');
  }

  /**
   * Resume a run paused on a recoverable failure: every blocked node is reset to
   * PENDING and re-enqueued from its saved input, the run goes RUNNING, and the
   * dispatch loop re-enters — re-running exactly the node(s) that stalled. Rebuilds
   * the in-memory context if the run isn't resident (e.g. after a restart).
   */
  async resumeBlockedRun(runId: string): Promise<{ resumed: number }> {
    let ctx = this.#runs.get(runId);
    const persistedRun = this.deps.db.select({ status: schema.workflowRuns.status }).from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    if (!ctx) {
      const rebuilt = this.#rebuildContextFromPersisted(runId);
      if (!rebuilt) return { resumed: 0 };
      this.#runs.set(runId, rebuilt);
      ctx = rebuilt;
    }
    // An operator pause aborts the previous run-scoped signal. A resumed run is
    // a fresh execution epoch and must not inherit that cancellation.
    if (persistedRun?.status === 'PAUSED') ctx.abortController = new AbortController();
    let resumed = 0;
    for (const ns of Object.values(ctx.state.nodeStates)) {
      if (ns && ns.status === 'WAITING' && ns.blockedReason) {
        ns.status = 'PENDING';
        delete ns.blockedReason;
        ctx.state.readyQueue.push({
          nodeId: ns.nodeId,
          priority: 0,
          insertedAt: new Date().toISOString(),
          inputData: ns.inputData ?? {},
        });
        resumed += 1;
      }
    }
    if (resumed === 0 && persistedRun?.status === 'PAUSED' && ctx.state.readyQueue.length > 0) {
      resumed = ctx.state.readyQueue.length;
    }
    if (resumed === 0 && (persistedRun?.status === 'RUNNING' || persistedRun?.status === 'WAITING')) {
      const queued = new Set(ctx.state.readyQueue.map((item) => item.nodeId));
      const activeNodeIds = new Set(Object.keys(ctx.state.activeExecutions ?? {}));
      for (const ns of Object.values(ctx.state.nodeStates)) {
        if (!ns || (ns.status !== 'RUNNING' && ns.status !== 'WAITING')) continue;
        if (queued.has(ns.nodeId)) continue;
        ns.status = 'PENDING';
        delete ns.blockedReason;
        ctx.state.readyQueue.push({
          nodeId: ns.nodeId,
          priority: 0,
          insertedAt: new Date().toISOString(),
          inputData: ns.inputData ?? {},
        });
        resumed += 1;
      }
      for (const nodeId of activeNodeIds) delete ctx.state.activeExecutions[nodeId];
    }
    if (resumed === 0) return { resumed: 0 };
    await this.#transitionRunStatus(ctx, 'RUNNING');
    void this.#tick(ctx);
    return { resumed };
  }

  /** Rebuild a RunningContext from a persisted run row (resume after restart). */
  #rebuildContextFromPersisted(runId: string): RunningContext | null {
    const run = this.deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    if (!run || !run.workflowId) return null;
    const state = run.runState as unknown as WorkflowRunState | null;
    if (!state) return null;
    try {
      const graph = this.#loadWorkflowGraph(run.workflowId);
      return {
        runId: run.id,
        workflowId: run.workflowId,
        planId: this.deps.plans?.findByRun(run.workspaceId, run.id)?.id ?? null,
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
        selfHealAttempts: hydrateSelfHealAttempts(state),
        abortController: new AbortController(),
      };
    } catch (err) {
      this.deps.logger.warn('engine.resume.rebuild_failed', { runId, err: (err as Error).message });
      return null;
    }
  }

  async #failNode(ctx: RunningContext, nodeId: string, error: string): Promise<void> {
    const ns = ctx.state.nodeStates[nodeId];
    if (!ns) return;
    // Recoverable infrastructure failure (model out of credits / billing): do NOT
    // fail the run — PAUSE this node so the operator can add credits or switch the
    // model and resume from exactly here. Takes precedence over error-edge routing
    // (a catch branch can't fix "no credits"). This is the fix for runs that used
    // to either hang as "running" forever or fail opaquely on an out-of-credits model.
    const node = ctx.graph.nodes.find((candidate) => candidate.id === nodeId);
    const recoverableModelFailure = isRecoverableModelError(error);
    if (!isSelfHealTerminalError(error)) {
      if (node && isSelfHealableNode(node)) {
        const heal = await this.#runSelfHeal(ctx, node, {}, error);
        if (heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval') return;
        if (heal.kind === 'output_fixed') {
          try {
            delete ctx.state.activeExecutions[nodeId];
            const completedOutput = await this.#completeNode(ctx, nodeId, heal.output);
            if (completedOutput) {
              void this.#tick(ctx);
              return;
            }
          } catch (err) {
            error = selfHealFailureMessage((err as Error).message, {
              kind: 'none',
              reason: 'Recovered output could not satisfy the node contract after self-healing.',
            });
          }
        } else if (heal.reason) {
          error = selfHealFailureMessage(error, heal);
        }
      }
    }
    if (recoverableModelFailure) {
      await this.#pauseNodeBlocked(ctx, nodeId, friendlyBlockedReason(error));
      return;
    }
    if (!isSelfHealTerminalError(error) && node?.config.kind === 'agent_task') {
      const retried = await this.#tryLegacyAgentTaskSelfHealRetry(ctx, node, error);
      if (retried) return;
    }
    if (node?.config.kind === 'agent_task') {
      this.#reflectHardNodeFailure(ctx, node, error);
    }
    // Generic per-node retryPolicy: bounded re-dispatch of transient IO /
    // deterministic failures BEFORE error-edge routing, so any non-agent node
    // gets the resilience that previously only agent_task had. Agent-like kinds
    // are excluded (they use self-heal / AgentRetryPolicy above).
    if (node && this.#shouldGenericRetry(node, error)) {
      const attempts = this.#nodeRetryAttempts(ctx);
      const prior = attempts.get(nodeId) ?? 0;
      const cap = Math.min(Math.max(node.retryPolicy!.maxAttempts, 0), 10);
      if (prior < cap) {
        const attempt = prior + 1;
        attempts.set(nodeId, attempt);
        const base = node.retryPolicy!.backoffMs && node.retryPolicy!.backoffMs > 0 ? node.retryPolicy!.backoffMs : 1000;
        const delay = Math.min(base * 2 ** (attempt - 1), 60_000);
        const inputData = ns.inputData ?? {};
        // Hold the run open during the backoff — a synthetic execution keeps the
        // settle loop from marking the run done while the retry timer is pending.
        delete ctx.state.activeExecutions[nodeId];
        ctx.state.activeExecutions[nodeId] = {
          taskId: `retry:${nodeId}`,
          nodeId,
          executorType: 'wait',
          executorRef: `retry:${attempt}/${cap}`,
          startedAt: new Date().toISOString(),
        };
        ns.status = 'WAITING';
        this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_RETRY_SCHEDULED, {
          runId: ctx.runId,
          nodeId,
          attempt,
          reason: 'retry_policy',
        });
        await this.#persistRun(ctx).catch(() => {});
        const timer = setTimeout(() => {
          delete ctx.state.activeExecutions[nodeId];
          void (async () => {
            try {
              await this.#dispatchNode(ctx, node, { nodeId, priority: 0, insertedAt: new Date().toISOString(), inputData });
            } catch (err) {
              await this.#failNode(ctx, nodeId, (err as Error).message);
            }
            void this.#tick(ctx);
          })();
        }, delay);
        timer.unref?.();
        return; // retrying — do not route the error / fail the node yet
      }
    }
    delete ctx.state.activeExecutions[nodeId];

    // â”€â”€ Error-edge routing (must happen BEFORE we mark the node as FAILED
    //    or push to failedNodeIds). When a connected error edge exists, the
    //    failure is "handled" â€” the catch branch runs and the node is
    //    treated as COMPLETED-with-error for settle purposes. This ordering
    //    matters because #tick() can re-enter from another path between
    //    `void this.#failNode()` and its first await, and would see the
    //    failed state and transition the run to FAILED.
    const downstream = ctx.downstreamEdges.get(nodeId) ?? [];
    const errorEdges = downstream.filter((e) => e.type === 'error');
    // PARALLEL onBranchError='continue_with_results': a failed branch that feeds a
    // merge whose resolved policy is `continue` is ABSORBED — the merge proceeds
    // with the surviving branches instead of the whole run failing. We treat such
    // a continue-merge edge exactly like an implicit error (catch) edge: it
    // receives the failed branch's error payload and the run carries on.
    const continueEdges = downstream.filter(
      (e) => e.type !== 'error'
        && this.#resolveJoinPolicy(ctx, ctx.graph.nodes.find((n) => n.id === e.target)).onError === 'continue',
    );
    const handledEdges = [...errorEdges, ...continueEdges];
    if (handledEdges.length > 0) {
      const handledIds = new Set(handledEdges.map((e) => e.id));
      const viaContinueOnly = errorEdges.length === 0;
      const errorPayload = {
        ...(ns.inputData ?? {}),
        error: {
          nodeId,
          message: error,
          at: new Date().toISOString(),
        },
      };
      // Mark as completed (not failed) â€” the failure was handled (catch branch
      // or a continue-on-error merge).
      ns.status = 'COMPLETED';
      ns.completedAt = new Date().toISOString();
      ns.error = error;        // keep the error for debugging
      ns.outputData = errorPayload;
      if (!ctx.state.completedNodeIds.includes(nodeId)) ctx.state.completedNodeIds.push(nodeId);

      for (const edge of handledEdges) {
        const buf = ctx.state.waitingInputs[edge.target];
        if (!buf) continue;
        buf.receivedInputs[nodeId] = errorPayload;
        buf.requiredInputs = buf.requiredInputs.filter((id) => id !== nodeId);
        this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: upstream path never produced an input');
      }

      // The failure was handled, so the node's remaining (non-handled) SUCCESS
      // edges will NEVER deliver. Drop them from downstream targets and
      // skip-cascade any that thereby become unreachable — otherwise the success
      // branch hangs and the whole run sits in WAITING forever (the "stuck on
      // Pending" UX). Mirrors the conditional skip in #completeNode (Proposal 3).
      for (const edge of downstream.filter((e) => e.type !== 'error' && !handledIds.has(e.id))) {
        if (!ctx.state.waitingInputs[edge.target]) continue;
        ctx.state.waitingInputs[edge.target]!.requiredInputs =
          ctx.state.waitingInputs[edge.target]!.requiredInputs.filter((id) => id !== nodeId);
        this.#promoteOrSkipTarget(ctx, edge.target, 'Skipped: the upstream step failed and was handled');
      }

      // Emit an explanatory ledger event + bus event so observers still see
      // the failure even though the run continues.
      await this.deps.ledger.append({
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        runId: ctx.runId,
        eventType: 'node.failed',
        nodeId,
        payload: { error, handledBy: viaContinueOnly ? 'parallel_continue' : 'error_edge' },
      });
      this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), REALTIME_EVENTS.NODE_FAILED, {
        runId: ctx.runId,
        nodeId,
        error,
        handledByErrorEdge: !viaContinueOnly,
      });
      const failedNode = ctx.graph.nodes.find((n) => n.id === nodeId);
      if (failedNode) this.#emitWorkStep(ctx, failedNode, 'fail', error);
      this.#audit(ctx, { nodeId, action: 'node.failed', actorType: 'system', actorId: 'engine', outputSummary: `${viaContinueOnly ? 'absorbed by continue-on-error merge' : 'handled by error edge'}: ${error}` });
      await this.#persistRun(ctx);
      return;
    }

    // No error edge wired â€” terminal failure for the node + the run.
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
    // The trigger inputs are whatever the run was started with â€” the first
    // queued item's inputData on the trigger node carries them.
    const triggerNode = ctx.graph.nodes.find((n) => n.type === 'trigger');
    const triggerInputs = (triggerNode && ctx.state.nodeStates[triggerNode.id]?.inputData) as
      | Record<string, unknown>
      | undefined;
    const scratchpadSnap = this.deps.scratchpad.snapshotOf(ctx.runId);
    // Workflow-store snapshot â€” empty when the service isn't wired or workflowId is missing.
    const storeSnap = this.deps.workflowStore && ctx.workflowId
      ? this.deps.workflowStore.snapshot(ctx.workspaceId, ctx.workflowId)
      : {};
    // Workspace-store (Tier 3) snapshot â€” powers `{{workspace.kv.*}}`.
    const workspaceKvSnap = this.deps.workspaceStore
      ? this.deps.workspaceStore.snapshot(ctx.workspaceId)
      : {};
    return buildTemplateContext({
      inputData: item.inputData ?? {},
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
    const payload = { runId, status: 'CANCELLED', workflowId: run.workflowId, workspaceId: run.workspaceId };
    this.deps.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.RUN_CANCELLED, payload);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(run.workspaceId), REALTIME_EVENTS.RUN_CANCELLED, payload);
  }

  async #pausePersistedRun(runId: string): Promise<void> {
    const run = await this.deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    if (!run || isTerminalRunStatus(run.status) || run.status === 'PAUSED') return;
    const state = run.runState as unknown as WorkflowRunState | null;
    if (state) {
      state.status = 'PAUSED';
      for (const node of Object.values(state.nodeStates)) {
        if (node?.status === 'RUNNING') {
          node.status = 'WAITING';
          node.blockedReason = 'Paused by operator';
        }
      }
      state.activeExecutions = {};
    }
    const now = new Date().toISOString();
    await this.deps.db.update(schema.workflowRuns).set({
      status: 'PAUSED', runState: (state ?? run.runState) as unknown as object, updatedAt: now,
    }).where(eq(schema.workflowRuns.id, runId));
    const payload = { runId, status: 'PAUSED', workflowId: run.workflowId, workspaceId: run.workspaceId };
    this.deps.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.RUN_PAUSED, payload);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(run.workspaceId), REALTIME_EVENTS.RUN_PAUSED, payload);
  }

  /**
   * Publish a human-readable AGENT_WORK_STEP to the workspace room so the
   * canvas Live feed can attribute work to a named agent in real time.
   * NODE_* events stay run-scoped and id-only; this is the agent-facing layer.
   */
  #emitWorkStep(
    ctx: RunningContext,
    node: WorkflowNode,
    phase: 'start' | 'complete' | 'fail' | 'thinking',
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
          : phase === 'thinking'
            ? `Repairing ${node.title}`
          : `Failed at ${node.title}`;
    const workStepPayload = {
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
    };
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.AGENT_WORK_STEP, workStepPayload);
    this.#appendActivityTail(ctx.runId, REALTIME_EVENTS.AGENT_WORK_STEP, workStepPayload);
  }

  /**
   * Run-level self-heal. The run completed every reachable node but produced NO
   * terminal output — a routing DEAD-END (classically: a gate's `fail`/reject
   * verdict whose only wired path is an error-catch that never fires, so every
   * return node is skipped). Node-level self-heal never sees this because no node
   * FAILED. With self-heal on, "every workflow must run", so we engage the
   * orchestrator to repair the routing and resume to a real terminal output —
   * reusing the exact node-level ladder (deep replan → finalize → validate →
   * certify → resume → bounded escalation). Returns true when a repair is
   * applied/queued (the run continues or pauses instead of failing).
   */
  async #healRunDeadEnd(ctx: RunningContext): Promise<boolean> {
    if (!this.deps.selfHeal) return false;
    let cfg: SelfHealConfig;
    try { cfg = getSelfHealConfig(this.deps.db, ctx.workspaceId); } catch { return false; }
    if (!cfg.enabled) return false;
    // Anchor the repair on the last completed decision node (the branch point that
    // dead-ended); the orchestrator gets the whole graph and chooses the resume
    // node (typically the skipped return node for this outcome).
    const anchorId = ctx.state.completedNodeIds.at(-1);
    const node = anchorId ? ctx.graph.nodes.find((n) => n.id === anchorId) : undefined;
    if (!node || !isSelfHealableNode(node)) return false;
    this.deps.logger.info('engine.self_heal.run_dead_end', { runId: ctx.runId, anchorNodeId: node.id });
    const heal = await this.#runSelfHeal(
      ctx,
      node,
      {},
      'Workflow reached no declared terminal output; every output path was skipped — a branch outcome (e.g. a gate "fail"/reject verdict) has no wired path to a return/terminal node. Repair the routing so this outcome reaches a terminal output node, preserving intent.',
    );
    return heal.kind === 'structural_applied' || heal.kind === 'awaiting_approval';
  }

  async #transitionRunStatus(ctx: RunningContext, status: WorkflowRunStatus): Promise<void> {
    if (ctx.state.status === status) return;

    // Output contract enforcement: a run transitioning to COMPLETED must match
    // the workflow's declared `outputContract` (when set). Mismatches downgrade
    // to COMPLETED_WITH_CONTRACT_VIOLATION so operators see the problem on the
    // canvas instead of silently shipping bad data. Brain evaluation reuses
    // this path when validating typed workflow output.
    // A node that errored — even one "handled" by an error/catch edge (it ends
    // COMPLETED but carries `ns.error`) — means the run did NOT cleanly succeed.
    // Report it honestly as COMPLETED_WITH_ERRORS instead of a green
    // "ran successfully", so the operator sees it and auto-diagnosis fires.
    if (status === 'COMPLETED') {
      const errored = Object.values(ctx.state.nodeStates).some((n) => Boolean(n?.error) && n?.status === 'COMPLETED');
      if (errored) status = 'COMPLETED_WITH_ERRORS';
    }

    if (status === 'COMPLETED') {
      const deviations = Object.values(ctx.state.nodeStates)
        .map((n) => n.contractDeviation)
        .filter((d): d is WorkflowNodeContractDeviation => Boolean(d));
      if (deviations.length > 0) {
        status = 'COMPLETED_WITH_CONTRACT_VIOLATION';
        (ctx.state as unknown as { contractViolations?: string[] }).contractViolations = deviations.map((d) => d.message);
      }
    }

    if (status === 'COMPLETED') {
      // Branches may intentionally skip alternate work, but an explicit output
      // workflow has not succeeded until at least one of its terminal outputs
      // actually ran. This prevents an untaken success branch plus an error-only
      // failure branch from becoming a green run with no result.
      const declaredOutputs = ctx.graph.nodes.filter((node) => {
        const config = node.config as { kind?: string; isOutput?: boolean };
        return config.kind === 'return_output' || config.isOutput === true;
      });
      if (declaredOutputs.length > 0 && !declaredOutputs.some((node) => ctx.state.nodeStates[node.id]?.status === 'COMPLETED')) {
        // A run-level dead-end is a self-heal trigger too: with self-heal on, the
        // orchestrator repairs the routing and resumes to a real terminal output
        // instead of the run silently failing. Only when it can't do we finalize
        // as errored (and the operator gets the "send to Agentis team" path).
        if (await this.#healRunDeadEnd(ctx)) return;
        status = 'COMPLETED_WITH_ERRORS';
        const reason = 'Workflow reached no declared terminal output; every output path was skipped.';
        (ctx.state as unknown as { completionFailure?: string }).completionFailure = reason;
        this.deps.logger.warn('engine.run.no_terminal_output', { runId: ctx.runId, outputNodeIds: declaredOutputs.map((node) => node.id) });
      }
    }

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
      || status === 'COMPLETED_WITH_ERRORS'
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
    // signal â€” so any further work performed after the publish would race.
    if (finishing && previous !== status) {
      if (ctx.planId && this.deps.plans) {
        const nextPlanStatus = status === 'COMPLETED' ? 'completed'
          : status === 'FAILED' || status === 'CANCELLED' || status === 'COMPLETED_WITH_ERRORS' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
            ? 'failed'
            : null;
        if (nextPlanStatus) this.deps.plans.setStatus(ctx.workspaceId, ctx.userId, ctx.planId, nextPlanStatus);
      }
      this.#clearPhaseTimers(ctx);
      await this.#appendTerminalConversationMessage(ctx, status);
      this.#audit(ctx, {
        action: `run.${status.toLowerCase()}`,
        actorType: 'system',
        actorId: 'engine',
        outputSummary: `${ctx.state.completedNodeIds.length} completed, ${ctx.state.failedNodeIds.length} failed`,
      });
      // Self-improvement: after a failure, look for a repeat pattern (Â§7.2).
      if ((status === 'FAILED' || status === 'COMPLETED_WITH_ERRORS') && this.deps.instincts) {
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
        // COMPLETED_WITH_ERRORS is surfaced as a FAILURE: it triggers the
        // proactive auto-diagnosis and shows red in the UI, matching the user's
        // mental model ("a node failed → the workflow failed").
        : status === 'CANCELLED'
          ? REALTIME_EVENTS.RUN_CANCELLED
          : status === 'PAUSED'
            ? REALTIME_EVENTS.RUN_PAUSED
            : status === 'FAILED' || status === 'COMPLETED_WITH_ERRORS'
          ? REALTIME_EVENTS.RUN_FAILED
          : REALTIME_EVENTS.RUN_RUNNING;
    // workspaceId lets the workspace-level SSE fallback forward this run-status
    // event (its filter keys on room OR payload.workspaceId).
    const runStatusPayload = { runId: ctx.runId, status, workflowId: ctx.workflowId, workspaceId: ctx.workspaceId };
    this.deps.bus.publish(REALTIME_ROOMS.run(ctx.runId), eventName, runStatusPayload);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), eventName, runStatusPayload);
    this.#appendActivityTail(ctx.runId, eventName, runStatusPayload);
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
    // Fallback â€” last completed node's output. Matches the subflow parent
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
  planId: string | null;
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
  /** Generic `retryPolicy` attempt counters keyed by node id (non-agent nodes). */
  nodeRetryAttempts?: Map<string, number>;
  /** Per-node dispatch counts for the infinite-cycle ceiling. */
  nodeDispatchCounts?: Map<string, number>;
  /**
   * Run-scoped cancellation (NATIVE-ADVANCEMENT Proposal 7, Agentis-native form).
   * `cancelRun` aborts this so in-flight work that honors the signal (HTTP
   * requests today; other handlers can adopt it) stops promptly instead of
   * running to completion after the run was cancelled.
   */
  abortController?: AbortController;
  /** Per-phase execution runtime (cost accrual + SLA timer). Lazily created. */
  phaseRuntime?: Map<string, PhaseRuntimeState>;
  /** Set when a phase / run / workspace budget is exceeded â€” settles the run as FAILED. */
  budgetHalt?: boolean;
  /** Accrued cost for this run (cents) â€” drives the per-run workflow ceiling (Â§5.3). */
  runCostCents?: number;
  /** Cached workflow per-run budget: undefined = not yet loaded, null = uncapped. */
  workflowBudgetCents?: number | null;
  /** In-memory map of pending approval id â†’ resume target (checkpoint node / phase / session). */
  pendingApprovals?: Map<string, PendingApproval>;
  /** Sessions parked on `await_event`, keyed by event name. */
  sessionWaiters?: Map<string, SessionWaiter[]>;
}

/** Resume target for a pending approval. `session` carries the wake bookkeeping. */
interface PendingApproval {
  kind: 'checkpoint' | 'phase_gate' | 'session' | 'self_heal';
  targetId: string;
  sessionId?: string;
  toolCallId?: string;
  runCtx?: SessionRunContext;
  healAction?: 'graph_patch' | 'retry_with_repair_context';
  /** For kind 'self_heal' — the certified, validated patch awaiting approval (W7). */
  healPatch?: WorkflowGraphPatch;
  healResumeNodeId?: string;
  repairPlanId?: string;
  retryError?: string;
  retryDiagnosis?: string;
  retryAttempt?: number;
  retryMaxAttempts?: number;
}

/** A session parked on a named run event, with everything needed to wake it. */
interface SessionWaiter {
  sessionId: string;
  nodeId: string;
  toolCallId: string;
  runCtx: SessionRunContext;
}

interface PhaseRuntimeState {
  started: boolean;
  startedAt: number;
  cost: number;
  slaTimer?: ReturnType<typeof setTimeout>;
  slaBreached: boolean;
  /** Human-gate state (Â§5.1). `none` until the phase's first node is reached. */
  gateState?: 'none' | 'pending' | 'approved';
  /** Ready-queue items held while the gate is pending â€” re-enqueued on approval. */
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
  /** Isolated per-subtask working directories, keyed by item index. Released on settle. */
  worktrees: Map<number, WorktreeHandle>;
  /** Dispatched-but-not-yet-reported subtask indices. Used to cancel siblings on early settle. */
  inFlight: Set<number>;
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

/**
 * Hard ceiling on engine tick concurrency. Even `unbounded` resolves to this —
 * `Number.MAX_SAFE_INTEGER` was a footgun that let one fan-out schedule
 * effectively limitless dispatches and exhaust the host's RAM/PIDs/file handles.
 * 256 is far above any real need while keeping a runaway bounded.
 */
export const WORKFLOW_PARALLELISM_HARD_CAP = 256;

/** Node kinds that own their retry/self-heal path; excluded from generic retryPolicy. */
const GENERIC_RETRY_EXCLUDED_KINDS = new Set<string>([
  'agent_task',
  'agent_swarm',
  'agent_session',
  'dynamic_swarm',
  'planner',
]);

/** Max times one node may be dispatched per run before the run is failed as a cycle. */
function nodeDispatchCeiling(): number {
  const raw = Number(process.env.AGENTIS_NODE_DISPATCH_CEILING);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
}

export function resolveParallelism(): number {
  const raw = process.env.AGENTIS_WORKFLOW_PARALLELISM ?? CONSTANTS.WORKFLOW_PARALLELISM_DEFAULT;
  if (raw === 'unbounded') return WORKFLOW_PARALLELISM_HARD_CAP;
  if (raw === 'auto') {
    const cpu = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency;
    return Math.max(2, Math.min((cpu ?? 4) * 2, WORKFLOW_PARALLELISM_HARD_CAP));
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, WORKFLOW_PARALLELISM_HARD_CAP) : 8;
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

function hydrateSelfHealAttempts(state: WorkflowRunState): Map<string, number> {
  const attempts = new Map<string, number>();
  const raw = state.selfHealAttempts ?? {};
  if (!raw || typeof raw !== 'object') return attempts;
  for (const [nodeId, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      attempts.set(nodeId, Math.floor(value));
    }
  }
  return attempts;
}

function selfHealAttemptCount(ctx: RunningContext, nodeId: string): number {
  const current = ctx.selfHealAttempts.get(nodeId);
  if (typeof current === 'number') return current;
  const persisted = ctx.state.selfHealAttempts?.[nodeId];
  const normalized = typeof persisted === 'number' && Number.isFinite(persisted) && persisted > 0
    ? Math.floor(persisted)
    : 0;
  if (normalized > 0) ctx.selfHealAttempts.set(nodeId, normalized);
  return normalized;
}

function recordSelfHealAttempt(ctx: RunningContext, nodeId: string): number {
  const next = selfHealAttemptCount(ctx, nodeId) + 1;
  ctx.selfHealAttempts.set(nodeId, next);
  ctx.state.selfHealAttempts = { ...(ctx.state.selfHealAttempts ?? {}), [nodeId]: next };
  return next;
}

/**
 * Which node kinds self-healing may repair. Output-recovery and runtime-rebind
 * are agent-specific, but the STRUCTURAL repair path (diagnose → patch node
 * config → re-dispatch) is generic, so any re-dispatchable node qualifies. Only
 * `trigger` (the run's entry, not a runtime step) is excluded — a failure there
 * is not something a graph patch can fix.
 */
function isSelfHealableNode(node: WorkflowNode): boolean {
  return node.config.kind !== 'trigger';
}

function isSelfHealTerminalError(error: string): boolean {
  return /Self-healing stopped:|self-healing patch could not be applied|self-healing fix was rejected/i.test(error);
}

/**
 * A node failed because its agent has no working runtime (the most common
 * long-run failure: a CLI/process dropped, a pinned agent was never connected,
 * the adapter is offline). This class is repaired DETERMINISTICALLY — rebind the
 * runtime or reroute to the healer — never by an LLM graph patch, so it costs no
 * tokens.
 */
function isRuntimeBindingFailure(error: string): boolean {
  return /no connected runtime|has no connected runtime|ADAPTER_UNAVAILABLE|adapter is (?:not connected|offline)|agent is offline|no runtime|runtime not connected/i.test(error);
}

function selfHealFailureMessage(error: string, heal: SelfHealEngineResult | null): string {
  if (!heal || heal.kind !== 'none' || !heal.reason) return error;
  const diagnosis = heal.diagnosis ? ` Diagnosis: ${heal.diagnosis}` : '';
  return `${error}\n\nSelf-healing stopped: ${heal.reason}.${diagnosis} If this looks like a platform-level workflow repair gap, send this run to the Agentis team with the failing node and run id.`;
}

function selfHealPatchFromPayload(payload: unknown): WorkflowGraphPatch | null {
  if (!payload || typeof payload !== 'object') return null;
  const patch = (payload as { patch?: unknown }).patch;
  if (!patch || typeof patch !== 'object') return null;
  const candidate = patch as Partial<WorkflowGraphPatch>;
  if (typeof candidate.patchId !== 'string') return null;
  if (typeof candidate.reason !== 'string') return null;
  if (typeof candidate.baseGraphRevision !== 'number') return null;
  if (!Array.isArray(candidate.addNodes)) return null;
  if (!Array.isArray(candidate.updateNodes)) return null;
  if (!Array.isArray(candidate.removeNodeIds)) return null;
  if (!Array.isArray(candidate.addEdges)) return null;
  if (!Array.isArray(candidate.removeEdgeIds)) return null;
  return candidate as WorkflowGraphPatch;
}

/** Shared full-graph diff used by recovery application and rollback. */
function graphDiffPatch(base: WorkflowGraph, target: WorkflowGraph, baseGraphRevision: number): WorkflowGraphPatch {
  const beforeNodes = new Map(base.nodes.map((node) => [node.id, node] as const));
  const afterNodes = new Map(target.nodes.map((node) => [node.id, node] as const));
  const beforeEdges = new Map(base.edges.map((edge) => [edge.id, edge] as const));
  const afterEdges = new Map(target.edges.map((edge) => [edge.id, edge] as const));
  return {
    patchId: randomUUID(),
    reason: 'self_heal',
    baseGraphRevision,
    addNodes: target.nodes.filter((node) => !beforeNodes.has(node.id)),
    updateNodes: target.nodes.filter((node) => {
      const before = beforeNodes.get(node.id);
      return Boolean(before && JSON.stringify(before) !== JSON.stringify(node));
    }),
    removeNodeIds: base.nodes.filter((node) => !afterNodes.has(node.id)).map((node) => node.id),
    addEdges: target.edges.filter((edge) => !beforeEdges.has(edge.id)),
    removeEdgeIds: base.edges.filter((edge) => !afterEdges.has(edge.id)).map((edge) => edge.id),
  };
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
    // null â€” we never throw at the boundary because workflows often have
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

/**
 * Whether a node failure is a recoverable INFRASTRUCTURE problem (the agent's
 * model is out of credits / billing / quota) rather than a logical task failure.
 * These pause the run (operator fixes billing, then resumes) instead of failing
 * it. Model-agnostic: matches the common provider signals, not a single vendor.
 */
function isRecoverableModelError(error: string): boolean {
  const e = (error || '').toLowerCase();
  return /\b402\b/.test(e)
    || /status=402/.test(e)
    || /insufficient[_\s]?quota/.test(e)
    || /insufficient[_\s]?(funds|credit|credits|balance)/.test(e)
    || /out of credits?/.test(e)
    || /payment required/.test(e)
    || /quota exceeded|exceeded your current quota/.test(e)
    || /billing (hard limit|issue|required)/.test(e)
    || /\bno credits?\b/.test(e);
}

/** A replayable activity item — a RealtimeEnvelope kept in the per-run tail. */
interface RunActivityEnvelope {
  event: string;
  payload: Record<string, unknown>;
  emittedAt: string;
}
/** Max items kept in a run's in-memory activity tail. */
const RUN_ACTIVITY_TAIL_CAP = 400;

/** Operator-facing reason for a credit/model pause. */
function friendlyBlockedReason(error: string): string {
  return 'This agent’s model is out of credits (or its billing/quota was rejected). '
    + 'Add credits or switch the agent’s model, then resume the run. '
    + `(provider said: ${(error || '').slice(0, 180)})`;
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'COMPLETED'
    || status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
    || status === 'COMPLETED_WITH_ERRORS'
    || status === 'FAILED'
    || status === 'CANCELLED';
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

/** Coerce a resolved content value into the string `addDocument` expects. */
function stringifyKnowledgeContent(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function mergeBufferedInputs(
  buf: { receivedInputs: Record<string, unknown> },
  strategy: 'merge_keys' | 'collect_all' | 'first_non_null' = 'merge_keys',
): Record<string, unknown> {
  const entries = Object.entries(buf.receivedInputs);

  // collect_all — keep every branch output distinct as an ordered array rather
  // than flattening keys (which would let a later branch clobber an earlier one).
  if (strategy === 'collect_all') {
    return { results: entries.map(([, value]) => value) };
  }

  // first_non_null — take the first branch that produced a meaningful payload.
  if (strategy === 'first_non_null') {
    for (const [src, value] of entries) {
      const isEmptyObject =
        value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
      if (value !== null && value !== undefined && !isEmptyObject) {
        return value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : { [src]: value };
      }
    }
    return {};
  }

  // merge_keys (default) — shallow-merge branch object outputs.
  const merged: Record<string, unknown> = {};
  for (const [src, value] of entries) {
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
 * is satisfied. The Brain' runtime contract reuses this same function via
 * the `WorkflowContract` shape â€” keep it pure and dependency-free.
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
    return url.length > 60 ? `${url.slice(0, 60)}â€¦` : url;
  }
}

function asString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Best-effort JSON coercion for templated GraphQL variable strings. */
function coerceJson(value: string): unknown {
  const t = value.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.parse(t); } catch { return value; }
  }
  return value;
}

/** Parse a CSV string into row objects (when headers) or string arrays. */
function parseCsv(text: string, hasHeaders: boolean): Array<Record<string, string>> | string[][] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return hasHeaders ? [] : [];
  if (!hasHeaders) return rows;
  const headers = rows[0]!;
  return rows.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => { rec[h] = cells[i] ?? ''; });
    return rec;
  });
}

/** RFC-4180-ish CSV tokenizer (quotes, escaped quotes, embedded newlines). */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Build a CSV string from row objects. */
function buildCsv(records: Array<Record<string, unknown>>, hasHeaders: boolean): string {
  if (records.length === 0) return '';
  const headers = Object.keys(records[0]!);
  const escape = (v: unknown): string => {
    const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  if (hasHeaders) lines.push(headers.map(escape).join(','));
  for (const rec of records) lines.push(headers.map((h) => escape(rec[h])).join(','));
  return lines.join('\n');
}

/** Convert an exceljs worksheet to row objects/arrays. */
function worksheetToRows(ws: unknown, hasHeaders: boolean): Array<Record<string, unknown>> | unknown[][] {
  if (!ws) return [];
  const raw: unknown[][] = [];
  const sheet = ws as { eachRow(cb: (row: { values: unknown }, n: number) => void): void };
  sheet.eachRow((r) => {
    // exceljs row.values is 1-indexed (values[0] is undefined).
    const cells = Array.isArray(r.values) ? (r.values as unknown[]).slice(1) : [];
    raw.push(cells.map((c) => (c && typeof c === 'object' && 'text' in (c as object) ? (c as { text: unknown }).text : c)));
  });
  if (raw.length === 0) return [];
  if (!hasHeaders) return raw;
  const headers = (raw[0] ?? []).map((h) => asString(h));
  return raw.slice(1).map((cells) => {
    const rec: Record<string, unknown> = {};
    headers.forEach((h, i) => { rec[h] = cells[i] ?? null; });
    return rec;
  });
}

/** The phase id (if any) a node belongs to â€” for audit + SLA/budget attribution. */
/**
 * Approval copy for a checkpoint node — a GENERIC preview of whatever
 * side-effecting action the checkpoint guards (any integration, HTTP request,
 * or agent task), so the operator sees exactly what they're approving. Not
 * specialised to any one connector.
 */
function checkpointApprovalCopy(
  ctx: RunningContext,
  node: WorkflowNode,
  inputData: Record<string, unknown>,
): { title: string; summary: string } {
  const action = checkpointGuardedAction(ctx, node, inputData);
  if (!action) {
    return {
      title: node.title || 'Checkpoint approval',
      summary: `Approve to continue workflow run ${ctx.runId}.`,
    };
  }
  const title = node.title && !/^checkpoint\b/i.test(node.title)
    ? node.title
    : `Approve: ${action.label}`;
  const parts = [`Approve running ${action.label}.`];
  for (const [key, value] of action.fields) parts.push(`${key}: ${value}.`);
  return { title, summary: parts.join(' ') };
}

/**
 * Describe the next side-effecting node a checkpoint gates, with a compact,
 * resolved preview of its inputs. Works for any integration / http_request /
 * agent node — connector-agnostic.
 */
function checkpointGuardedAction(
  ctx: RunningContext,
  node: WorkflowNode,
  inputData: Record<string, unknown>,
): { label: string; fields: Array<[string, string]> } | null {
  const target = (ctx.downstreamEdges.get(node.id) ?? [])
    .map((edge) => ctx.graph.nodes.find((candidate) => candidate.id === edge.target))
    .find((candidate): candidate is WorkflowNode => {
      const kind = (candidate?.config as { kind?: string } | undefined)?.kind;
      return kind === 'integration' || kind === 'http_request' || kind === 'agent_task' || kind === 'agent_session';
    });
  if (!target) return null;

  const tctx = checkpointTemplateContext(ctx, inputData);
  const cfg = target.config as Record<string, unknown> & { kind?: string };

  if (cfg.kind === 'integration') {
    const integrationId = String(cfg.integrationId ?? 'integration');
    const op = cfg.operationId ? ` · ${String(cfg.operationId)}` : '';
    const inputs = resolveTemplateDeep((cfg.inputs as Record<string, unknown>) ?? {}, tctx) as Record<string, unknown>;
    return { label: `${target.title || integrationId} (${integrationId}${op})`, fields: previewFields(inputs) };
  }
  if (cfg.kind === 'http_request') {
    const url = resolveTemplate(String(cfg.url ?? ''), tctx);
    const method = String(cfg.method ?? 'GET').toUpperCase();
    return { label: `${target.title || 'HTTP request'} (${method} ${url ? redactUrl(url) : 'unset URL'})`, fields: previewFields({ body: (cfg as { body?: unknown }).body }) };
  }
  // agent_task / agent_session
  const prompt = previewText(resolveTemplate(String((cfg as { prompt?: unknown }).prompt ?? ''), tctx));
  return { label: target.title || 'agent task', fields: prompt ? [['Task', prompt]] : [] };
}

/** First few non-empty, resolved input fields of a node, for a compact approval preview. */
function previewFields(inputs: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(inputs ?? {})) {
    const preview = previewText(value);
    if (preview) out.push([key, preview]);
    if (out.length >= 5) break;
  }
  return out;
}

function checkpointTemplateContext(ctx: RunningContext, inputData: Record<string, unknown>): TemplateContext {
  const nodeOutputs: Record<string, Record<string, unknown>> = {};
  for (const [id, ns] of Object.entries(ctx.state.nodeStates)) {
    if (ns.outputData) nodeOutputs[id] = ns.outputData as Record<string, unknown>;
  }
  const triggerNode = ctx.graph.nodes.find((candidate) => candidate.type === 'trigger');
  const triggerInputs = triggerNode
    ? (ctx.state.nodeStates[triggerNode.id]?.inputData as Record<string, unknown> | undefined)
    : undefined;
  return buildTemplateContext({
    inputData,
    triggerInputs: triggerInputs ?? inputData,
    nodeOutputs,
    scratchpad: ctx.scratchpad?.snapshot ?? {},
    store: {},
    workspace: { id: ctx.workspaceId, kv: {} },
    run: { id: ctx.runId, startedAt: ctx.startedAt },
  });
}

function previewText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const joined = value.map((item) => previewText(item)).filter(Boolean).join(', ');
    return joined || undefined;
  }
  const text = asString(value).replace(/\s+/g, ' ').trim();
  if (!text || text === '{}') return undefined;
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function phaseIdForNode(graph: WorkflowGraph, nodeId: string): string | null {
  for (const phase of graph.phases ?? []) {
    if (phase.nodeIds?.includes(nodeId)) return phase.id;
  }
  return null;
}

/** Best identifier for the actor behind a node â€” agent id/role for agent nodes, else 'engine'. */
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
    return s.length > 280 ? `${s.slice(0, 279)}â€¦` : s;
  } catch {
    return null;
  }
}

/** Best-effort JSON for embedding input data in a tool-loop task prompt. */
function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 4_000 ? `${s.slice(0, 3_999)}â€¦` : s;
  } catch {
    return String(value);
  }
}

function toolInputSchemaToChatParameters(schemaValue: unknown): ToolDefinition['parameters'] {
  if (schemaValue && typeof schemaValue === 'object' && !Array.isArray(schemaValue)) {
    const schemaRecord = schemaValue as Record<string, unknown>;
    const properties = schemaRecord.properties && typeof schemaRecord.properties === 'object' && !Array.isArray(schemaRecord.properties)
      ? schemaRecord.properties as ToolDefinition['parameters']['properties']
      : {};
    const required = Array.isArray(schemaRecord.required) ? schemaRecord.required.map(String) : undefined;
    return {
      type: 'object',
      properties,
      ...(required && required.length > 0 ? { required } : {}),
    };
  }
  return { type: 'object', properties: {} };
}

function agentOutputContractPrompt(outputKeys: string[] | undefined): string {
  const keys = (outputKeys ?? []).map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0) return '';
  return [
    '',
    '',
    'OUTPUT CONTRACT:',
    `Return one strict JSON object with these exact top-level keys: ${keys.map((key) => JSON.stringify(key)).join(', ')}.`,
    'Do not wrap the JSON in markdown or code fences.',
    'If a list has no items, return an empty array for that key.',
    'If a count is zero, still include every declared list/content key with an empty or safe value.',
  ].join('\n');
}

interface DeclaredOutputNormalizationResult {
  output: Record<string, unknown>;
  declaredKeys: string[];
  missingKeys: string[];
  recoveredKeys: string[];
}

function outputNormalization(output: Record<string, unknown>): DeclaredOutputNormalizationResult {
  return { output, declaredKeys: [], missingKeys: [], recoveredKeys: [] };
}

function normalizeDeclaredNodeOutput(node: WorkflowNode, output: Record<string, unknown>): Record<string, unknown> {
  return normalizeDeclaredNodeOutputResult(node, output).output;
}

function normalizeDeclaredNodeOutputResult(node: WorkflowNode, output: Record<string, unknown>): DeclaredOutputNormalizationResult {
  const keys = declaredOutputKeys(node);
  if (keys.length === 0) return outputNormalization(output);
  const parsed = parseStructuredOutputEnvelope(output);
  const normalized: Record<string, unknown> = parsed ? { ...output, ...parsed } : { ...output };
  const recovered = new Set<string>();
  if (parsed) {
    for (const key of keys) {
      if (!isOutputValuePresent(output[key]) && isOutputValuePresent(parsed[key])) {
        recovered.add(key);
      }
    }
  }

  for (const key of keys) {
    if (isOutputValuePresent(normalized[key])) continue;
    const aliasValue = firstOutputAliasValue(normalized, key);
    if (isOutputValuePresent(aliasValue)) {
      normalized[key] = aliasValue;
      recovered.add(key);
      continue;
    }
    const inferredCount = inferCountValue(normalized, key);
    if (isOutputValuePresent(inferredCount)) {
      normalized[key] = inferredCount;
      recovered.add(key);
      continue;
    }
    if (looksCollectionOutputKey(key) && outputDeclaresZeroItems(normalized)) {
      normalized[key] = [];
      recovered.add(key);
    }
  }
  if (keys.length === 1 && !isOutputValuePresent(normalized[keys[0]!])) {
    const text = firstOutputAliasValue(normalized, keys[0]!) ?? outputTextEnvelope(output);
    if (isOutputValuePresent(text)) {
      normalized[keys[0]!] = text;
      recovered.add(keys[0]!);
    }
  }
  const missing = keys.filter((key) => !isOutputValuePresent(normalized[key]));
  return {
    output: normalized,
    declaredKeys: keys,
    missingKeys: missing,
    recoveredKeys: [...recovered].filter((key) => !missing.includes(key)),
  };
}

function missingDeclaredOutputMessage(node: WorkflowNode, missing: string[]): string {
  return `agent node '${node.id}' did not produce declared output key(s): ${missing.join(', ')}`;
}

function buildContractDeviation(
  node: WorkflowNode | undefined,
  result: DeclaredOutputNormalizationResult,
): WorkflowNodeContractDeviation {
  const missing = result.missingKeys;
  const message = node
    ? missingDeclaredOutputMessage(node, missing)
    : `node did not produce declared output key(s): ${missing.join(', ')}`;
  return {
    kind: 'missing_declared_output_keys',
    declaredKeys: result.declaredKeys,
    missingKeys: missing,
    recoveredKeys: result.recoveredKeys,
    message,
    outputPreview: compactRealtimePayload(result.output),
  };
}

function declaredOutputKeys(node: WorkflowNode): string[] {
  const config = node.config as { kind?: string; outputKeys?: unknown };
  if (config.kind !== 'agent_task' && config.kind !== 'agent_session' && config.kind !== 'planner') return [];
  return Array.isArray(config.outputKeys)
    ? config.outputKeys.filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
    : [];
}

function parseStructuredOutputEnvelope(output: Record<string, unknown>): Record<string, unknown> | null {
  const objectEnvelope = objectOutputEnvelope(output);
  if (objectEnvelope) return objectEnvelope;
  const text = outputTextEnvelope(output);
  return text ? parseGeneric(text) : null;
}

function objectOutputEnvelope(output: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ['output', 'result', 'content', 'message', 'response', 'answer', 'body', 'digest']) {
    const value = output[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function outputTextEnvelope(output: Record<string, unknown>): string | null {
  for (const key of ['text', 'output', 'result', 'content', 'message', 'response', 'answer', 'body', 'markdown', 'markdownBody', 'html', 'htmlBody', 'digest']) {
    const value = output[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function firstOutputAliasValue(output: Record<string, unknown>, key: string): unknown {
  for (const alias of outputAliasesForKey(key)) {
    const value = output[alias];
    if (isOutputValuePresent(value)) return value;
  }
  return undefined;
}

function inferCountValue(output: Record<string, unknown>, key: string): number | undefined {
  const normalized = normalizeOutputKey(key);
  if (!normalized.endsWith('count')) return undefined;
  for (const alias of countSourceAliasesForKey(key)) {
    const value = output[alias];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function outputAliasesForKey(key: string): string[] {
  const normalized = normalizeOutputKey(key);
  const aliases = new Set<string>([key]);
  if (
    normalized.includes('body')
    || normalized.includes('content')
    || normalized.includes('markdown')
    || normalized.includes('message')
    || normalized.includes('digest')
    || normalized.includes('summary')
    || normalized.includes('report')
    || normalized.includes('analysis')
    || normalized.includes('finding')
    || normalized === 'result'
  ) {
    for (const alias of bodyAliasesForKey(normalized)) {
      aliases.add(alias);
    }
  }
  if (normalized.includes('subject') || normalized.includes('title')) {
    aliases.add('subject');
    aliases.add('title');
  }
  if (looksCollectionOutputKey(key)) {
    for (const alias of collectionAliasesForKey(normalized)) {
      aliases.add(alias);
    }
  }
  return [...aliases];
}

function normalizeOutputKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function bodyAliasesForKey(normalized: string): string[] {
  if (normalized.includes('html')) {
    return ['htmlBody', 'html', 'body', 'content', 'message', 'digest', 'output', 'result', 'answer', 'response'];
  }
  if (normalized.includes('markdown')) {
    return ['markdownBody', 'markdown', 'body', 'content', 'text', 'message', 'digest', 'summary', 'report', 'analysis', 'findings', 'output', 'result', 'answer', 'response'];
  }
  return ['body', 'content', 'text', 'message', 'digest', 'summary', 'report', 'analysis', 'findings', 'output', 'result', 'answer', 'response', 'markdownBody', 'markdown', 'htmlBody', 'html'];
}

function collectionAliasesForKey(normalized: string): string[] {
  if (normalized.includes('sent') && normalized.includes('story') && normalized.includes('key')) {
    return ['sentStoryKeys', 'storyKeys', 'sentKeys', 'keys'];
  }
  if (normalized.includes('story') || normalized.includes('stori')) {
    return ['topStories', 'stories', 'articles', 'items', 'results'];
  }
  if (normalized.includes('article')) {
    return ['articles', 'stories', 'items', 'results'];
  }
  if (normalized.includes('key')) {
    return ['keys', 'storyKeys'];
  }
  if (normalized.includes('record')) return ['records', 'rows', 'items', 'results'];
  if (normalized.includes('row')) return ['rows', 'records', 'items', 'results'];
  return ['items', 'results', 'records', 'rows'];
}

function countSourceAliasesForKey(key: string): string[] {
  const normalized = normalizeOutputKey(key);
  if (normalized === 'sentcount') return ['sentStoryKeys', 'sentKeys'];
  const stem = normalized.replace(/count$/, '');
  const rawStem = key.replace(/count$/i, '');
  const aliases = new Set<string>([
    rawStem,
    `${rawStem}s`,
    `${rawStem}Items`,
    `${rawStem}Records`,
    `${rawStem}Rows`,
    `${stem}s`,
    `${stem}Items`,
    `${stem}Records`,
    `${stem}Rows`,
  ].filter(Boolean));
  for (const alias of collectionAliasesForKey(stem)) aliases.add(alias);
  return [...aliases];
}

function looksCollectionOutputKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.endsWith('s')
    || normalized.includes('list')
    || normalized.includes('items')
    || normalized.includes('keys')
    || normalized.includes('records')
    || normalized.includes('rows');
}

function outputDeclaresZeroItems(output: Record<string, unknown>): boolean {
  return Object.entries(output).some(([key, value]) => /count$/i.test(key) && Number(value) === 0);
}

function isOutputValuePresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function nodeIdFromTargetPath(graph: WorkflowGraph, targetPath: string): string | null {
  const path = targetPath.trim().replace(/^\{\{\s*|\s*\}\}$/g, '');
  const nodesBySpecificity = [...graph.nodes].sort((a, b) => b.id.length - a.id.length);
  for (const node of nodesBySpecificity) {
    if (
      path === node.id
      || path === `nodes.${node.id}`
      || path.startsWith(`${node.id}.`)
      || path.startsWith(`nodes.${node.id}.`)
    ) {
      return node.id;
    }
  }
  return null;
}

function agentConfiguredModel(agent: { runtimeModel?: string | null; config?: unknown } | null | undefined): string | null {
  const runtimeModel = stringValue(agent?.runtimeModel);
  if (runtimeModel) return runtimeModel;
  const raw = agent?.config;
  let config: Record<string, unknown> | null = null;
  try {
    config = typeof raw === 'string'
      ? JSON.parse(raw) as Record<string, unknown>
      : raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
  } catch {
    return null;
  }
  return stringValue(config?.model);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function evaluationAgentBindingFromNode(
  node: WorkflowNode | undefined,
): { agentId: string; preferredModel?: string } | null {
  if (!node) return null;
  const config = node.config as { kind?: string; agentId?: unknown; modelOverride?: unknown };
  if (
    typeof config.agentId === 'string'
    && (
      config.kind === 'agent_task'
      || config.kind === 'agent_session'
      || config.kind === 'agent_swarm'
      || config.kind === 'planner'
    )
  ) {
    return {
      agentId: config.agentId,
      ...(typeof config.modelOverride === 'string' && config.modelOverride
        ? { preferredModel: config.modelOverride }
        : {}),
    };
  }
  return null;
}

/** Project a subset of keys from an input map. Missing keys are dropped. */
function pickKeys(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in input) out[key] = input[key];
  }
  return out;
}

/** Adapt a `useSession` agent_task into the agent_session config shape. */
function agentTaskAsSession(cfg: AgentTaskNodeConfig): AgentSessionNodeConfig {
  return {
    kind: 'agent_session',
    agentId: cfg.agentId,
    agentRole: cfg.agentRole,
    prompt: cfg.prompt,
    inputKeys: [],
    outputKeys: cfg.outputKeys ?? [],
    maxSteps: cfg.maxToolSteps,
    capabilityTags: cfg.capabilityTags ?? [],
    requires: cfg.requires,
  };
}

/** Pull the textual payload out of a session's terminal output. */
function extractPlanText(output: Record<string, unknown>): string {
  const result = output.result ?? output.output ?? output;
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Parse a planner's reply into a clean task list. Prefers a JSON array embedded
 * anywhere in the text; falls back to non-empty lines. Bounded by `max`.
 */
function parseTaskList(text: string, max: number): string[] {
  if (!text || !text.trim()) return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        const tasks = parsed
          .map((t) => (typeof t === 'string' ? t : typeof t === 'object' && t ? safeJson(t) : String(t)))
          .map((t) => t.trim())
          .filter(Boolean);
        if (tasks.length > 0) return tasks.slice(0, max);
      }
    } catch {
      // fall through to line-splitting
    }
  }
  const lines = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  return lines.slice(0, max);
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

function shouldTraverseEdge(
  edge: WorkflowEdge,
  output: Record<string, unknown>,
  scratchpad: Record<string, unknown>,
): boolean {
  if (edge.type === 'error') return false;
  if (edge.condition) {
    return evalCondition(edge.condition, { output, scratchpad });
  }
  if (edge.type === 'condition') {
    return implicitConditionEdgeResult(output);
  }
  return true;
}

function implicitConditionEdgeResult(output: Record<string, unknown> | unknown): boolean {
  if (typeof output === 'boolean') return output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    for (const key of ['passed', 'ok', 'approved', 'allow', 'allowed', 'continue', 'shouldContinue', 'go']) {
      if (typeof record[key] === 'boolean') return record[key] as boolean;
    }
  }
  return true;
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
  // Best-effort JSON parse for values authored as templates â€” fall back to the
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
      // Lightweight check â€” full JSON Schema validation lives in the contract
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

// ───────────────────────────────────────────────────────────────────────────
// Convergence loop (`converge`) — module-scope helpers (AGENT-COOPERATION-10X).
// ───────────────────────────────────────────────────────────────────────────

/** Honest terminal verdicts — never a fake green. */
type ConvergeVerdict = 'goal_met' | 'stalled' | 'budget_exhausted' | 'max_iterations';

/** The system identity stamped on controller-authored blackboard entries. */
const CONVERGE_IDENTITY = { runtime: 'system', label: 'Converge controller' } as const;

interface ConvergeIterationRecord {
  iteration: number;
  durationMs: number;
  /** Whether the controller decided to run another pass after this one. */
  continue: boolean;
  /** Continuation verdict: open | converged | pass | fail | signalled_done | … */
  verdict: string;
  score?: number;
  critique?: string;
  /** Consecutive no-change iterations leading up to (and including) this one. */
  stallStreak: number;
}

/** Persisted controller state — enough to resume a loop mid-flight after a crash. */
interface ConvergeRunState {
  history?: ConvergeIterationRecord[];
  accumulated?: Record<string, unknown>;
  lastSignature?: string;
  lastOutput?: Record<string, unknown>;
  stallStreak?: number;
}

/**
 * Remove the reserved `converge` control envelope from a body's output so it
 * never re-enters accumulated state (a body that echoes its inputs would create
 * a `state → converge → state` cycle).
 */
function stripConvergeEnvelope(output: Record<string, unknown>): Record<string, unknown> {
  if (!output || typeof output !== 'object' || !('converge' in output)) return output;
  const { converge: _omit, ...rest } = output;
  return rest;
}

/**
 * Order-independent structural signature of an iteration's output, used for
 * stall detection. Two iterations with the same signature made no material
 * progress.
 */
function convergeStableSignature(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
    );
  };
  try {
    return JSON.stringify(norm(value));
  } catch {
    return String(value);
  }
}
