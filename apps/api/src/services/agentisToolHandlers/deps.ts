/**
 * Shared deps for the tool handler families.
 *
 * The registry is transport-agnostic — handlers do not assume they were
 * called from chat or workflow. They must look up entities by id, run inside
 * the workspace context, and return typed structured output.
 */

import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { EventBus } from '../../event-bus.js';
import type { WorkflowEngine } from '../../engine/WorkflowEngine.js';
import type { AdapterManager } from '../../adapters/AdapterManager.js';
import type { LedgerService } from '../ledger.js';
import type { ScratchpadService } from '../scratchpad.js';
import type { ApprovalInboxService } from '../approvalInbox.js';
import type { ActivityFeedService } from '../activityFeed.js';
import type { PartialReplayService } from '../partialReplay.js';
import type { KnowledgeBaseService } from '../knowledgeBase.js';
import type { EvaluatorRuntime } from '../evaluatorRuntime.js';
import type { WorkspaceIntelligenceService } from '../workspaceIntelligence.js';
import type { AgentLibraryService } from '../agentLibrary.js';
import type { ExtensionLibraryService } from '../extensionLibrary.js';
import type { SpecialistAgentService } from '../specialistAgents.js';
import type { SpecialistDemandRouter } from '../specialistDemandRouter.js';
import type { SpecialistProfileService } from '../specialistProfileService.js';
import type { SpecialistRuntimeService } from '../specialistRuntimeService.js';
import type { OrchestratorModelRouter } from '../orchestratorModelRouter.js';
import type { AbilityCreationService } from '../abilityCreationService.js';
import type { MemoryStore } from '../memoryStore.js';
import type { PlanService } from '../planService.js';
import type { ChannelBridge } from '../channelBridge.js';
import type { BrowserPool } from '../browserPool.js';
import type { ArtifactService } from '../artifactService.js';
import type { McpToolBridge } from '../mcpToolBridge.js';

export interface ToolHandlerDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  bus: EventBus;
  engine: WorkflowEngine;
  adapters: AdapterManager;
  ledger: LedgerService;
  scratchpad: ScratchpadService;
  approvals: ApprovalInboxService;
  activity: ActivityFeedService;
  replay: PartialReplayService;
  knowledgeBases?: KnowledgeBaseService;
  /** §B4 — typed workspace memory facade over the unified episode substrate. */
  memory?: MemoryStore;
  /** Optional — used by NL workflow synthesis for structured-output LLM calls. */
  evaluatorRuntime?: EvaluatorRuntime;
  /** Optional — dedicated workflow-synthesis runtime (§6). Falls back to evaluatorRuntime. */
  synthesisRuntime?: EvaluatorRuntime;
  /**
   * Optional — resolve a per-workspace EvaluatorRuntime for a model role
   * (OMNICHANNEL §4.4). When set, synthesis honors per-workspace model overrides;
   * falls back to synthesisRuntime/evaluatorRuntime.
   */
  resolveEvaluatorRuntime?: (
    workspaceId: string,
    role: 'synthesis' | 'evaluation',
    hint?: { task?: string | null; purpose?: string | null; explicitModel?: string | null },
  ) => EvaluatorRuntime | undefined;
  /**
   * Optional — per-role orchestrator model router. Lets workflow synthesis route
   * around a slow per-call CLI harness through the operator's configured streaming
   * model (the same fast path the chat loop uses), with ZERO extra setup. Without
   * it, synthesis falls back to the agent's own adapter.
   */
  modelRouter?: OrchestratorModelRouter;
  /** Optional workspace gate for automatic model-assisted evaluator/brain/runtime fallback. */
  modelAssistedRuntimeEnabled?: (workspaceId: string) => boolean;
  /** Optional — Layer 1 workspace context injected into build_workflow synthesis. */
  workspaceIntelligence?: WorkspaceIntelligenceService;
  /** Optional — Principle #11 agent-as-file library; expands the casting vocabulary with custom roles. */
  agentLibrary?: AgentLibraryService;
  /** Optional workspace-volume extension source library available to synthesis. */
  extensionLibrary?: ExtensionLibraryService;
  abilityCreation?: AbilityCreationService;
  /**
   * Optional — Layer 2 specialist library. Lets build_workflow MATERIALIZE the
   * cast (commission real specialist agents for each agentRole and pin them to
   * nodes) so the team is real and visible the moment a workflow is built.
   */
  specialists?: SpecialistAgentService;
  /**
   * Resolve (and lazily connect) a runtime for an agent — the same mechanism the
   * engine uses at dispatch. The build uses it to bind a freshly-cast specialist to
   * the workspace's default model runtime at CREATION, so it is connected (not an
   * offline `http` placeholder that shows "fails on first run"), and model routing
   * has real model candidates to choose from. Returns undefined when model-assisted
   * runtime is disabled — the specialist then stays offline (the lazy dispatch bind
   * remains the fallback). Untyped here to avoid an engine-type import cycle.
   */
  resolveAgentRuntime?: (workspaceId: string, agentId: string, task?: string | null, explicitModel?: string | null) => unknown;
  specialistProfiles?: SpecialistProfileService;
  specialistRuntime?: SpecialistRuntimeService;
  specialistRouter?: SpecialistDemandRouter;
  plans?: PlanService;
  channels?: ChannelBridge;
  /** Headless Chromium pool — backs the `agentis.browser.*` tools. */
  browserPool?: BrowserPool;
  /** Artifact persistence + resolution — screenshots become referenceable, channel attachments resolve to bytes. */
  artifacts?: ArtifactService;
  /** External MCP tool bridge — backs agentis.mcp.list / agentis.mcp.call. */
  mcpBridge?: McpToolBridge;
}
