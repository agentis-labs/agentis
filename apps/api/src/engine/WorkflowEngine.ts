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
import { eq } from 'drizzle-orm';
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
  type DataWriteNodeConfig,
  type DataReadNodeConfig,
  type AgentSwarmNodeConfig,
  type BrainLookupNodeConfig,
  type ArtifactCollectNodeConfig,
  type WorkflowEdge,
  type WorkflowGraphPatch,
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
import type { CollectiveBrainService } from '../services/collectiveBrain.js';
import type { BrainPromotionQueueWorker } from '../services/brainPromotionQueueWorker.js';
import type { AgentAbilityService } from '../services/agentAbilityService.js';
import type { UserProfileService } from '../services/userProfileService.js';
import type { AppDataService } from '../services/appDataService.js';
import type { ConversationStore } from '../services/conversationStore.js';
import { evalCondition } from './SafeConditionParser.js';
import { validateWorkflowGraph } from './validateGraph.js';
import { noopTelemetry, type Telemetry } from '../telemetry/index.js';

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
  collectiveBrain?: CollectiveBrainService;
  /** Durable brain promotion queue (BRAIN-ABILITIES-REPLAN.md §BL10). */
  brainQueue?: BrainPromotionQueueWorker;
  /** Agent abilities — procedural how-to injection at dispatch (Part IV). */
  abilities?: AgentAbilityService;
  /** Operator profile — USER.md-equivalent injection at dispatch (§BL8). */
  userProfiles?: UserProfileService;
  /** App Data layer — required for `data_write` nodes (AGENTIS-PLATFORM-10X §A5). */
  appData?: AppDataService;
  /** Conversation bridge — lets chat-started runs report terminal state back to the thread. */
  conversations?: ConversationStore;
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
      thinkingTraces: new Map(),
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
    const node = ctx.graph.nodes.find((candidate) => candidate.id === args.nodeId) ?? null;
    await this.#completeNode(ctx, args.nodeId, args.output);
    if (node?.config.kind === 'agent_task') {
      this.#maybePromoteFromAgentTask(ctx, node, node.config, args.output);
    }
    void this.#tick(ctx);
  }

  /**
   * Capture an `agent.thinking` reasoning trace (B3). The richest learning
   * signal — the agent's reflection on what it noticed and why — is collected
   * per agent_task node and handed to the ability reviewer at completion.
   */
  recordThinking(runId: string, nodeId: string, text: string): void {
    if (!text) return;
    const ctx = this.#runs.get(runId);
    if (!ctx) return;
    const swarm = parseSwarmTaskId(nodeId);
    const key = swarm ? swarm.nodeId : nodeId;
    const trace = ctx.thinkingTraces.get(key) ?? [];
    if (trace.length >= 40) return; // bound memory per node
    trace.push(text);
    ctx.thinkingTraces.set(key, trace);
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
      if (ctx.state.failedNodeIds.length > 0) {
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
    await this.#startNode(ctx, node, item.inputData);

    switch (node.config.kind) {
      case 'trigger': {
        // Triggers are pure pass-throughs at run time — they were the seed.
        await this.#completeNode(ctx, node.id, item.inputData);
        return;
      }
      case 'scratchpad': {
        const result = await this.#executeScratchpadNode(ctx, node.config, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'merge': {
        // Merge node passes through the union of received inputs.
        await this.#completeNode(ctx, node.id, item.inputData);
        return;
      }
      case 'router': {
        const branchOutputs = this.#executeRouter(ctx, node.config, item.inputData);
        await this.#completeNode(ctx, node.id, { branches: branchOutputs });
        return;
      }
      case 'checkpoint': {
        await this.#executeCheckpoint(ctx, node, node.config, item.inputData);
        return;
      }
      case 'skill_task': {
        const result = await this.#executeSkillTask(ctx, node, node.config, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'knowledge': {
        const result = await this.#executeKnowledgeNode(ctx, node.config, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'agent_task': {
        await this.#dispatchAgentTask(ctx, node, node.config, item.inputData);
        return; // adapter event will call notifyTaskCompleted
      }
      case 'data_write': {
        const result = await this.#executeDataWrite(ctx, node, node.config, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'data_read': {
        const result = await this.#executeDataRead(ctx, node, node.config, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'brain_lookup': {
        const result = await this.#executeBrainLookup(ctx, node.config, item.inputData);
        await this.#completeNode(ctx, node.id, result);
        return;
      }
      case 'agent_swarm': {
        await this.#dispatchAgentSwarm(ctx, node, node.config, item.inputData);
        return; // swarm subtask events resolve the node
      }
      case 'artifact_collect': {
        const result = await this.#executeArtifactCollect(ctx, node, node.config, item.inputData);
        await this.#completeNode(ctx, node.id, result);
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
    const knowledgeScope = ctx.appId ? { appId: ctx.appId, includeWorkspace: true } : undefined;
    const bases = config.knowledgeBaseId
      ? [this.deps.knowledgeBases.getKnowledgeBase(ctx.workspaceId, config.knowledgeBaseId, knowledgeScope)]
      : this.deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId, knowledgeScope);
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

  async #dispatchAgentTask(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    if (!config.agentId) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `agent_task node ${node.id} has no agentId bound`,
      );
    }
    const taskId = randomUUID();
    ctx.state.activeExecutions[node.id] = {
      taskId,
      nodeId: node.id,
      executorType: 'agent',
      executorRef: config.agentId,
      startedAt: new Date().toISOString(),
    };

    // B2 — query the Brain for atoms relevant to this task and inject them as
    // a frozen context block. Degrades gracefully to no block when the Brain
    // is empty or retrieval fails. Atom injections are recorded so the
    // evaluator feedback loop (Gap14) can later credit/penalise them.
    let brainContext: string | undefined;
    if (this.deps.collectiveBrain) {
      try {
        const result = await this.deps.collectiveBrain.buildDispatchContext({
          workspaceId: ctx.workspaceId,
          appId: this.#resolveAppId(ctx),
          agentId: config.agentId,
          runId: ctx.runId,
          taskDescription: `${node.title}\n${config.prompt}`,
        });
        if (result.block) brainContext = result.block;
      } catch (err) {
        this.deps.logger.warn('collective_brain.dispatch_context.failed', {
          runId: ctx.runId,
          nodeId: node.id,
          message: (err as Error).message,
        });
      }
    }

    // Part IV — inject the agent's relevant procedural abilities (how-to
    // knowledge), ranked by task relevance. Frozen at dispatch.
    let abilityBlock = '';
    if (this.deps.abilities) {
      try {
        const result = await this.deps.abilities.buildDispatchBlock({
          workspaceId: ctx.workspaceId,
          agentId: config.agentId,
          workflowId: ctx.workflowId,
          appId: this.#resolveAppId(ctx),
          runId: ctx.runId,
          taskDescription: `${node.title}\n${config.prompt}`,
        });
        abilityBlock = result.block;
      } catch (err) {
        this.deps.logger.warn('agent_abilities.dispatch_block.failed', {
          runId: ctx.runId,
          nodeId: node.id,
          message: (err as Error).message,
        });
      }
    }

    // §BL8 — operator profile (USER.md equivalent), frozen at dispatch.
    let profileBlock = '';
    if (this.deps.userProfiles) {
      try {
        profileBlock = this.deps.userProfiles.buildDispatchBlock(ctx.workspaceId);
      } catch {
        profileBlock = '';
      }
    }

    const sections = [config.prompt];
    if (profileBlock) sections.push(`=== ${profileBlock}`);
    if (abilityBlock) sections.push(`=== AGENT ABILITIES (proven procedures) ===\n${abilityBlock}`);
    if (brainContext) sections.push(`=== BRAIN CONTEXT (knowledge from past runs) ===\n${brainContext}`);
    const description = sections.join('\n\n');

    await this.deps.adapters.dispatchTask({
      taskId,
      runId: ctx.runId,
      workflowId: ctx.workflowId,
      nodeId: node.id,
      title: node.title,
      description,
      inputData,
      scratchpadSnapshot: this.deps.scratchpad.snapshotOf(ctx.runId),
      capabilityTags: config.capabilityTags,
      timeoutMs: CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS,
      brainContext,
    }, config.agentId);
  }

  #maybePromoteFromAgentTask(
    ctx: RunningContext,
    node: WorkflowNode,
    config: AgentTaskNodeConfig,
    output: Record<string, unknown>,
  ): void {
    if (!this.deps.collectiveBrain) return;
    const inputData = ctx.state.nodeStates[node.id]?.inputData ?? null;
    // B1 — promote to the owning app's scope, not workspace scope. The hardcoded
    // `appId: null` poisoned app-brain isolation on every run.
    const appId = this.#resolveAppId(ctx);
    const thinkingTrace = ctx.thinkingTraces.get(node.id) ?? [];
    try {
      if (this.deps.brainQueue) {
        // BL10 — durable, restart-safe enqueue instead of `queueMicrotask`.
        this.deps.brainQueue.enqueue({
          workspaceId: ctx.workspaceId,
          itemType: 'atom_promotion',
          priority: 'normal',
          payload: {
            workspaceId: ctx.workspaceId,
            appId,
            workflowId: ctx.workflowId,
            runId: ctx.runId,
            nodeId: node.id,
            agentId: config.agentId ?? null,
            taskInput: inputData,
            taskOutput: output,
          },
        });
        // Part IV — distil a procedural ability from this run (Path 1).
        if (this.deps.abilities) {
          this.deps.brainQueue.enqueue({
            workspaceId: ctx.workspaceId,
            itemType: 'ability_review',
            priority: 'normal',
            payload: {
              workspaceId: ctx.workspaceId,
              agentId: config.agentId ?? null,
              workflowId: ctx.workflowId,
              runId: ctx.runId,
              taskTitle: node.title,
              taskInput: inputData,
              taskOutput: output,
              thinkingTrace,
            },
          });
        }
      } else {
        // Fallback when the queue is not wired (tests) — synchronous lexical path.
        queueMicrotask(() => {
          try {
            this.deps.collectiveBrain!.extractAndPromote({
              workspaceId: ctx.workspaceId,
              workflowId: ctx.workflowId,
              runId: ctx.runId,
              nodeId: node.id,
              agentId: config.agentId ?? null,
              appId,
              taskInput: inputData,
              taskOutput: output,
            });
          } catch (err) {
            this.deps.logger.warn('collective_brain.agent_task_promotion.failed', {
              runId: ctx.runId,
              nodeId: node.id,
              message: (err as Error).message,
            });
          }
        });
      }
    } catch (err) {
      this.deps.logger.warn('collective_brain.agent_task_promotion.failed', {
        runId: ctx.runId,
        nodeId: node.id,
        message: (err as Error).message,
      });
    }
  }

  // ────────────────────────────────────────────────────────────
  // Data layer — data_write node (AGENTIS-PLATFORM-10X §A5)
  // ────────────────────────────────────────────────────────────

  async #executeDataWrite(
    ctx: RunningContext,
    node: WorkflowNode,
    config: DataWriteNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.appData) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        'data_write node present but AppDataService not wired',
      );
    }
    const appId = config.appId ?? this.#resolveAppId(ctx);
    if (!appId) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `data_write node ${node.id} could not resolve an owning app — set config.appId`,
      );
    }
    const recordSource = config.recordPath
      ? lookupPath(inputData, config.recordPath)
      : inputData;
    if (!recordSource || typeof recordSource !== 'object' || Array.isArray(recordSource)) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `data_write node ${node.id}: input record is not an object`,
      );
    }
    const record = recordSource as Record<string, unknown>;

    if (config.operation === 'insert') {
      const { id } = this.deps.appData.insert(ctx.workspaceId, appId, config.table, record);
      return { id, table: config.table, operation: 'insert' };
    }
    if (config.operation === 'upsert') {
      const idField = config.idField ?? 'id';
      const result = this.deps.appData.upsert(
        ctx.workspaceId,
        appId,
        config.table,
        record,
        idField,
      );
      return { id: result.id, table: config.table, operation: result.created ? 'insert' : 'update' };
    }
    // update
    const targetId = config.idField ? record[config.idField] : record.id;
    if (typeof targetId !== 'string' || !targetId) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `data_write node ${node.id}: update requires an id (idField=${config.idField ?? 'id'})`,
      );
    }
    this.deps.appData.update(ctx.workspaceId, appId, config.table, targetId, record);
    return { id: targetId, table: config.table, operation: 'update' };
  }

  /**
   * Read records from the app's structured Data layer. Lets a workflow act on
   * its own accumulated operational data without leaving the engine.
   */
  async #executeDataRead(
    ctx: RunningContext,
    node: WorkflowNode,
    config: DataReadNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.appData) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        'data_read node present but AppDataService not wired',
      );
    }
    const appId = config.appId ?? this.#resolveAppId(ctx);
    if (!appId) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `data_read node ${node.id} could not resolve an owning app — set config.appId`,
      );
    }
    const where: Record<string, unknown> = { ...(config.where ?? {}) };
    for (const [col, path] of Object.entries(config.whereFrom ?? {})) {
      where[col] = lookupPath(inputData, path);
    }
    const result = this.deps.appData.query(appId, config.table, {
      where,
      expression: config.filter,
      limit: config.limit,
      orderBy: config.orderBy,
      orderDir: config.orderDir,
    });
    const key = config.outputKey ?? 'records';
    if (config.single) {
      return {
        [key]: result.records[0] ?? null,
        found: result.records.length > 0,
        table: config.table,
      };
    }
    return { [key]: result.records, total: result.total, table: config.table };
  }

  /** Resolve the owning app of the running workflow (cached on the context). */
  #resolveAppId(ctx: RunningContext): string | null {
    if (ctx.appId !== undefined) return ctx.appId;
    let appId: string | null = null;
    try {
      const wf = this.deps.db
        .select({ appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, ctx.workflowId))
        .get();
      appId = wf?.appId ?? null;
      if (!appId) {
        const app = this.deps.db
          .select({ id: schema.appInstances.id })
          .from(schema.appInstances)
          .where(eq(schema.appInstances.entryWorkflowId, ctx.workflowId))
          .get();
        appId = app?.id ?? null;
      }
    } catch {
      appId = null;
    }
    ctx.appId = appId;
    return appId;
  }

  // ────────────────────────────────────────────────────────────
  // Brain lookup node (AGENTIS-PLATFORM-10X §Layer 4)
  // ────────────────────────────────────────────────────────────

  async #executeBrainLookup(
    ctx: RunningContext,
    config: BrainLookupNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const outputKey = config.outputKey ?? 'atoms';
    if (!this.deps.collectiveBrain) {
      return { [outputKey]: [], query: '', resultCount: 0 };
    }
    let query = config.query ?? '';
    if ((config.queryMode ?? 'static') === 'dynamic' && config.queryPath) {
      const v = lookupPath(inputData, config.queryPath);
      query = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
    }
    query = query.trim();
    const topK = Math.min(Math.max(config.topK ?? 5, 1), 25);
    let atoms: unknown[] = [];
    try {
      const brain = this.deps.collectiveBrain as unknown as {
        search?: (a: { workspaceId: string; query: string; topK: number }) => unknown[];
        query?: (a: { workspaceId: string; query: string; topK: number }) => unknown[];
      };
      const fn = brain.search ?? brain.query;
      if (fn && query) {
        atoms = fn.call(this.deps.collectiveBrain, {
          workspaceId: ctx.workspaceId,
          query,
          topK,
        });
      }
    } catch (err) {
      this.deps.logger.warn('brain_lookup.failed', {
        runId: ctx.runId,
        message: (err as Error).message,
      });
    }
    return { [outputKey]: atoms, query, resultCount: Array.isArray(atoms) ? atoms.length : 0 };
  }

  // ────────────────────────────────────────────────────────────
  // Artifact collect node (AGENTIS-PLATFORM-10X §A12)
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

  async #executeCheckpoint(
    ctx: RunningContext,
    node: WorkflowNode,
    config: CheckpointNodeConfig,
    inputData: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.approvals.create({
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
    ctx.eventsSinceSnapshot += 1;
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
    ctx.eventsSinceSnapshot += 1;

    // Fan out to downstream nodes.
    for (const edge of ctx.downstreamEdges.get(nodeId) ?? []) {
      // Conditional edge gating.
      if (edge.condition) {
        const scope = { output, scratchpad: this.deps.scratchpad.snapshotOf(ctx.runId) };
        if (!evalCondition(edge.condition, scope)) continue;
      }
      const buf = ctx.state.waitingInputs[edge.target];
      if (!buf) continue;
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
    ns.status = 'FAILED';
    ns.completedAt = new Date().toISOString();
    ns.error = error;
    if (!ctx.state.failedNodeIds.includes(nodeId)) ctx.state.failedNodeIds.push(nodeId);
    delete ctx.state.activeExecutions[nodeId];

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
    await this.#persistRun(ctx);
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
    const previous = ctx.state.status;
    ctx.state.status = status;
    const finishing = status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
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

    const eventName =
      status === 'COMPLETED'
        ? REALTIME_EVENTS.RUN_COMPLETED
        : status === 'FAILED'
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

    // Cross-workflow event signaling (AGENTIS-PLATFORM-10X §A3): a workflow
    // reaching a terminal state fires APP_WORKFLOW_COMPLETED / _FAILED so the
    // `workflow_completed` trigger can chain the next domain without coupling.
    if (status === 'COMPLETED' || status === 'FAILED') {
      const appWfEvent =
        status === 'COMPLETED'
          ? REALTIME_EVENTS.APP_WORKFLOW_COMPLETED
          : REALTIME_EVENTS.APP_WORKFLOW_FAILED;
      const appWfPayload = {
        runId: ctx.runId,
        workflowId: ctx.workflowId,
        workspaceId: ctx.workspaceId,
        ambientId: ctx.ambientId,
        userId: ctx.userId,
        status,
      };
      this.deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), appWfEvent, appWfPayload);
      const appId = this.#resolveAppId(ctx);
      if (appId) {
        this.deps.bus.publish(REALTIME_ROOMS.app(appId), appWfEvent, { ...appWfPayload, appId });
      }
    }

    if (finishing && previous !== status) {
      await this.#appendTerminalConversationMessage(ctx, status);
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
  /** Owning app id — `undefined` = not resolved yet, `null` = resolved as none. */
  appId?: string | null;
  /** Active agent_swarm nodes keyed by node id. */
  swarms: Map<string, SwarmState>;
  /** Self-heal attempt counters keyed by agent_task node id. */
  selfHealAttempts: Map<string, number>;
  /** B3 — accumulated `agent.thinking` text per agent_task node id. */
  thinkingTraces: Map<string, string[]>;
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
