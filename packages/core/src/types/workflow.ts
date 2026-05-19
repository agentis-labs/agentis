/**
 * Workflow graph & run-state types.
 *
 * The shape of these types is the contract between the canvas, the engine,
 * and the persistence layer. Touch them here, then propagate.
 *
 * Mirrors V1-SPEC §6.2 and §6.3.
 */

export type WorkflowNodeType =
  | 'trigger'
  | 'agent_task'
  | 'skill_task'
  | 'knowledge'
  | 'router'
  | 'merge'
  | 'checkpoint'
  | 'subflow'
  | 'scratchpad'
  /** Direct write into the app's structured Data layer (AGENTIS-PLATFORM-10X §A5). */
  | 'data_write'
  /** Query the app's structured Data layer from inside a running workflow (§Layer 3). */
  | 'data_read'
  /** Parallel agent fan-out over an input array (AGENTIS-PLATFORM-10X §A8). */
  | 'agent_swarm'
  /** Query the Collective Brain graph from inside a running workflow (§Layer 4). */
  | 'brain_lookup'
  /** Collect and version artifacts produced by upstream nodes (AGENTIS-PLATFORM-10X §A12). */
  | 'artifact_collect';

export interface WorkflowGraph {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  position: { x: number; y: number };
  config: WorkflowNodeConfig;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  /** Safe expression (no eval). Evaluated by SafeConditionParser. */
  condition?: string;
}

export interface WorkflowOutputConfig {
  /** Marks this node as part of the workflow's operator-facing output surface. */
  isOutput?: boolean;
}

export type WorkflowNodeConfig = (
  | TriggerNodeConfig
  | AgentTaskNodeConfig
  | SkillTaskNodeConfig
  | KnowledgeNodeConfig
  | RouterNodeConfig
  | MergeNodeConfig
  | CheckpointNodeConfig
  | SubflowNodeConfig
  | ScratchpadNodeConfig
  | DataWriteNodeConfig
  | DataReadNodeConfig
  | AgentSwarmNodeConfig
  | BrainLookupNodeConfig
  | ArtifactCollectNodeConfig
) & WorkflowOutputConfig;

/**
 * Trigger node config.
 *
 * `data_event` and `workflow_completed` are the cross-workflow event
 * primitives (AGENTIS-PLATFORM-10X §A2, §A3) that make apps autonomous —
 * a write into the Data layer or the completion of one workflow can start
 * another with no synchronous coupling.
 */
export interface TriggerNodeConfig {
  kind: 'trigger';
  triggerType:
    | 'manual'
    | 'cron'
    | 'webhook'
    | 'persistent_listener'
    | 'data_event'
    | 'workflow_completed';
  triggerId?: string;
  /** For `data_event`: the Data table to watch. */
  table?: string;
  /** For `data_event`: which mutation fires the trigger. */
  event?: 'insert' | 'update' | 'delete' | 'any';
  /** For `data_event`: a SafeConditionParser expression on the record. */
  filter?: string;
  /** For `workflow_completed`: the upstream workflow whose completion fires this. */
  sourceWorkflowId?: string;
  /** For `workflow_completed`: only fire on this terminal status. */
  sourceStatus?: 'COMPLETED' | 'FAILED' | 'any';
}

/**
 * Retry / self-healing policy for an agent task (AGENTIS-PLATFORM-10X §A9).
 * When `selfHeal` is on, a failed agent task is re-dispatched with the error
 * context appended to its prompt so the agent can correct itself.
 */
export interface AgentRetryPolicy {
  selfHeal?: boolean;
  maxSelfHealAttempts?: number;
}

export interface AgentTaskNodeConfig {
  kind: 'agent_task';
  agentId?: string;
  agentPackageRef?: string;
  capabilityTags: string[];
  prompt: string;
  inputKeys: string[];
  outputKeys: string[];
  retryPolicy?: AgentRetryPolicy;
}

/**
 * Direct write into the app's structured Data layer. No agent dispatch, no
 * skill invocation — the engine calls `AppDataService` with the node input.
 */
export interface DataWriteNodeConfig {
  kind: 'data_write';
  table: string;
  operation: 'insert' | 'update' | 'upsert';
  /** JSONPath into the node input to extract the record (defaults to whole input). */
  recordPath?: string;
  /** For update/upsert: the field to match the existing row on. */
  idField?: string;
  /** Explicit app id — only needed for ephemeral runs with no owning app. */
  appId?: string;
}

/**
 * Read records from the app's structured Data layer. No agent dispatch — the
 * engine calls `AppDataService.query` and returns the matched records so
 * downstream nodes can act on accumulated operational data.
 */
export interface DataReadNodeConfig {
  kind: 'data_read';
  table: string;
  /** Literal equality filters: column → value. */
  where?: Record<string, unknown>;
  /** Dynamic equality filters: column → JSONPath into the node input. */
  whereFrom?: Record<string, string>;
  /** SafeConditionParser expression applied per-row (post-SQL filter). */
  filter?: string;
  limit?: number;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  /** Output key for the result (default 'records'). */
  outputKey?: string;
  /** When true, return only the first matching record instead of an array. */
  single?: boolean;
  /** Explicit app id — only needed for ephemeral runs with no owning app. */
  appId?: string;
}

/**
 * Parallel agent fan-out. The engine spawns one task per element of the
 * input array (bounded by `maxParallel`) and merges results.
 */
export interface AgentSwarmNodeConfig {
  kind: 'agent_swarm';
  /** Template prompt — applied to each input element. */
  prompt: string;
  /** JSONPath to the input array; each element becomes one agent task. */
  inputArrayPath: string;
  maxParallel: number;
  mergeStrategy: 'collect_all' | 'first_success' | 'majority_vote';
  capabilityTags: string[];
  /** Optional explicit agent — otherwise resolved by capability tags. */
  agentId?: string;
  outputKey: string;
}

/** Query the Collective Brain graph for the most relevant knowledge atoms. */
export interface BrainLookupNodeConfig {
  kind: 'brain_lookup';
  /** Static query, or pulled dynamically from upstream output. */
  queryMode?: 'static' | 'dynamic';
  query?: string;
  queryPath?: string;
  topK?: number;
  outputKey?: string;
}

/**
 * Collect artifacts (files, media, generated pages) from upstream nodes into a
 * named, versioned collection. The node gathers `ArtifactRef` objects from the
 * input data and writes them to the app's artifact store (AGENTIS-PLATFORM-10X §A12).
 */
export interface ArtifactCollectNodeConfig {
  kind: 'artifact_collect';
  /** Human-readable collection name (e.g. "Campaign Pack Q3"). */
  collectionName: string;
  /** JSONPath into the node input to find artifact refs. Defaults to whole input. */
  artifactPath?: string;
  /** Artifact types to accept. If omitted, all types accepted. */
  acceptTypes?: Array<'html' | 'image' | 'document' | 'code' | 'data'>;
  /** Whether to version the collection (increment on each run). Default true. */
  versioned?: boolean;
  /** Optional approval gate — if true, artifacts are held for operator review. */
  requireApproval?: boolean;
}

export interface SkillTaskNodeConfig {
  kind: 'skill_task';
  skillId: string;
  inputMapping: Record<string, string>;
  outputMapping: Record<string, string>;
}

export interface KnowledgeNodeConfig {
  kind: 'knowledge';
  knowledgeBaseId?: string;
  queryMode?: 'static' | 'dynamic';
  query?: string;
  queryNodeId?: string;
  queryPath?: string;
  retrievalMode?: 'contextual' | 'strict' | 'exploratory';
  topK?: number;
}

export interface RouterNodeConfig {
  kind: 'router';
  routingMode: 'first_match' | 'all_matching' | 'llm_route';
  branches: Array<{ branchId: string; label: string; condition: string }>;
}

export interface MergeNodeConfig {
  kind: 'merge';
  requiredInputs: 'all' | 'any' | string[];
}

export interface CheckpointNodeConfig {
  kind: 'checkpoint';
  approvalMode: 'manual' | 'auto_after_timeout';
  timeoutMs?: number;
}

export interface SubflowNodeConfig {
  kind: 'subflow';
  workflowId: string;
  inputMapping: Record<string, string>;
  outputMapping: Record<string, string>;
}

export interface ScratchpadNodeConfig {
  kind: 'scratchpad';
  operation: 'read' | 'write' | 'append' | 'delete';
  key: string;
  valuePath?: string;
}

// ────────────────────────────────────────────────────────────
// Run state
// ────────────────────────────────────────────────────────────

export type WorkflowRunStatus =
  | 'CREATED'
  | 'PLANNING'
  | 'RUNNING'
  | 'WAITING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type WorkflowNodeStatus =
  | 'PENDING'
  | 'WAITING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED';

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  readyQueue: ReadyQueueItem[];
  waitingInputs: Record<string, WaitingInputBuffer>;
  nodeStates: Record<string, WorkflowNodeState>;
  activeExecutions: Record<string, ActiveExecution>;
  completedNodeIds: string[];
  failedNodeIds: string[];
  skippedNodeIds: string[];
  graphRevision: number;
  replanCount: number;
  lastLedgerSequence: number;
}

export interface ReadyQueueItem {
  nodeId: string;
  priority: number;
  insertedAt: string;
  inputData: Record<string, unknown>;
}

export interface WaitingInputBuffer {
  requiredInputs: string[];
  receivedInputs: Record<string, unknown>;
  sourceNodeIds: string[];
}

export interface WorkflowNodeState {
  nodeId: string;
  status: WorkflowNodeStatus;
  startedAt?: string;
  completedAt?: string;
  inputData?: Record<string, unknown>;
  outputData?: Record<string, unknown>;
  error?: string;
}

export interface ActiveExecution {
  taskId: string;
  nodeId: string;
  executorType: 'agent' | 'skill' | 'subflow' | 'router';
  executorRef: string;
  startedAt: string;
  heartbeatAt?: string;
}

// ────────────────────────────────────────────────────────────
// Graph patches (dynamic edits during a run)
// ────────────────────────────────────────────────────────────

export interface WorkflowGraphPatch {
  patchId: string;
  reason: 'planner_replan' | 'user_edit' | 'hub_package_update';
  baseGraphRevision: number;
  addNodes: WorkflowNode[];
  updateNodes: WorkflowNode[];
  removeNodeIds: string[];
  addEdges: WorkflowEdge[];
  removeEdgeIds: string[];
}
