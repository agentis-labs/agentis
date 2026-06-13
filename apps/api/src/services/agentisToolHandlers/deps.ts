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
import type { OrchestratorModelRouter } from '../orchestratorModelRouter.js';
import type { AbilityCreationService } from '../abilityCreationService.js';

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
  /** Optional — used by NL workflow synthesis for structured-output LLM calls. */
  evaluatorRuntime?: EvaluatorRuntime;
  /** Optional — dedicated workflow-synthesis runtime (§6). Falls back to evaluatorRuntime. */
  synthesisRuntime?: EvaluatorRuntime;
  /**
   * Optional — resolve a per-workspace EvaluatorRuntime for a model role
   * (OMNICHANNEL §4.4). When set, synthesis honors per-workspace model overrides;
   * falls back to synthesisRuntime/evaluatorRuntime.
   */
  resolveEvaluatorRuntime?: (workspaceId: string, role: 'synthesis' | 'evaluation') => EvaluatorRuntime | undefined;
  /**
   * Optional — per-role orchestrator model router. Lets workflow synthesis route
   * around a slow per-call CLI harness through the operator's configured streaming
   * model (the same fast path the chat loop uses), with ZERO extra setup. Without
   * it, synthesis falls back to the agent's own adapter.
   */
  modelRouter?: OrchestratorModelRouter;
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
  specialistRouter?: SpecialistDemandRouter;
}
