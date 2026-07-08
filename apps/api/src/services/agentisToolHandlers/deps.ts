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
import type { KnowledgeBaseService } from '../knowledge/knowledgeBase.js';
import type { EvaluatorRuntime } from '../evaluatorRuntime.js';
import type { WorkspaceIntelligenceService } from '../workspace/workspaceIntelligence.js';
import type { AgentLibraryService } from '../agent/agentLibrary.js';
import type { ExtensionLibraryService } from '../extensionLibrary.js';
import type { SpecialistAgentService } from '../specialist/specialistAgents.js';
import type { SpecialistDemandRouter } from '../specialist/specialistDemandRouter.js';
import type { SpecialistProfileService } from '../specialist/specialistProfileService.js';
import type { SpecialistRuntimeService } from '../specialist/specialistRuntimeService.js';
import type { OrchestratorModelRouter } from '../orchestrator/orchestratorModelRouter.js';
import type { MemoryStore } from '../memory/memoryStore.js';
import type { SharedIntelligenceService } from '../sharedIntelligence.js';
import type { SkillService } from '../skillService.js';
import type { PlanService } from '../planService.js';
import type { ChannelBridge } from '../conversation/channelBridge.js';
import type { BrowserPool } from '../browserPool.js';
import type { ArtifactService } from '../artifactService.js';
import type { AssetStore } from '../assetStore.js';
import type { McpToolBridge } from '../mcp/mcpToolBridge.js';
import type { CapabilityIndex } from '../capability/capabilityIndex.js';
import type { CommandModelService } from '../command/commandModel.js';
import type { ConversationService } from '../conversation/conversationService.js';
import type { MediaService } from '../mediaService.js';
import type { ConnectionGrantService } from '../connectionGrants.js';
import type { AgentSessionService } from '../agent/agentSession.js';
import type { ExperimentService } from '../experiments.js';
import type { DurableEntityService } from '../durableEntities.js';

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
  /** Backs agentis.brain.search — agent-initiated semantic recall over the Brain. */
  sharedIntelligence?: SharedIntelligenceService;
  /** Backs agentis.skill.load — returns a Skill's full SKILL.md body on demand. */
  skills?: SkillService;
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
  /** Content-addressed asset store — backs agentis.assets.save (dedup + register). */
  assetStore?: AssetStore;
  /** External MCP tool bridge — backs agentis.mcp.list / agentis.mcp.call. */
  mcpBridge?: McpToolBridge;
  /**
   * Compressed, searchable map of the whole workspace — backs the
   * agentis.capability.* reach tools and the Command Model briefing. Lets an
   * agent know-of-everything and invoke anything (apps/nodes/phases/specialists/
   * MCP) without holding it all in context.
   */
  capabilityIndex?: CapabilityIndex;
  /**
   * The fractal Command Model — backs agentis.command.review/note and the resident
   * Command Briefing. Gives an orchestrator/manager progressive comprehension of
   * what it manages (scoped inventory + progress/deltas + App minds).
   */
  commandModel?: CommandModelService;
  /**
   * The per-contact Conversation State Machine (GAP B1/B3). Backs
   * agentis.conversation.define/.enroll — an App's declarative outreach script
   * (deterministic greeting → agent pitch → classify → run_workflow → stop) that
   * the channel dispatcher advances on each inbound reply, token-free where scripted.
   */
  conversation?: ConversationService;
  /**
   * Generic multimodal generation (image today; audio/speech/video as providers
   * register). Backs agentis.media.generate. Provider-pluggable — no vendor lock-in.
   */
  media?: MediaService;
  /**
   * Per-agent scoped authority over connections (Agent-Native Platform Plan §3.3).
   * Backs the send-door authorization check and agentis.connection.grant/.request/.grants.
   * Absent → connections behave as pre-grant (open), so wiring is strictly additive.
   */
  connectionGrants?: ConnectionGrantService;
  /**
   * Agent session store — backs agentis.residency.remember (§3.1), letting a
   * resident agent persist its plan/observations blocks across scheduled wakes.
   */
  sessionStore?: Pick<AgentSessionService, 'rememberResident' | 'residentState'>;
  /** Experiment/variant substrate (§3.5) — backs agentis.experiment.define/assign/record/results. */
  experiments?: ExperimentService;
  /** Durable Entity spine (§3.0/§3.2) — backs agentis.subject.* (per-subject durable actors). */
  durableEntities?: DurableEntityService;
}
