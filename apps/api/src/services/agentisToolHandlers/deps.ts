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
}
