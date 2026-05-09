/**
 * Shared deps for the tool handler families.
 *
 * The registry is transport-agnostic — handlers do not assume they were
 * called from chat or workflow. They must look up entities by id, run inside
 * the workspace context, and return typed structured output.
 */

import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { WorkflowEngine } from '../../engine/WorkflowEngine.js';
import type { LedgerService } from '../ledger.js';
import type { ScratchpadService } from '../scratchpad.js';
import type { ApprovalInboxService } from '../approvalInbox.js';
import type { ActivityFeedService } from '../activityFeed.js';
import type { PartialReplayService } from '../partialReplay.js';
import type { KnowledgeStore } from '../knowledgeStore.js';
import type { AppMemoryStore } from '../appMemoryStore.js';
import type { EvaluatorExampleStore } from '../evaluatorExampleStore.js';
import type { WorkflowBaselineStore } from '../workflowBaselineStore.js';
import type { AppIntelligenceRuntime } from '../appIntelligenceRuntime.js';
import type { IntelligencePromotion } from '../intelligencePromotion.js';
import type { MemoryRuntime } from '../memoryRuntime.js';
import type { EpisodicMemoryStore } from '../episodicMemoryStore.js';
import type { MemoryPromotion } from '../memoryPromotion.js';
import type { RollingBaselineStore } from '../rollingBaselineStore.js';

export interface ToolHandlerDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  engine: WorkflowEngine;
  ledger: LedgerService;
  scratchpad: ScratchpadService;
  approvals: ApprovalInboxService;
  activity: ActivityFeedService;
  replay: PartialReplayService;
  /** App Knowledge Wedge stores. Optional during incremental rollout. */
  knowledge?: KnowledgeStore;
  appMemory?: AppMemoryStore;
  evaluators?: EvaluatorExampleStore;
  baselines?: WorkflowBaselineStore;
  intelligence?: AppIntelligenceRuntime;
  promotion?: IntelligencePromotion;
  /** Memory Architecture runtime. Optional during incremental rollout. */
  memory?: MemoryRuntime;
  episodes?: EpisodicMemoryStore;
  memoryPromotion?: MemoryPromotion;
  rollingBaselines?: RollingBaselineStore;
}
