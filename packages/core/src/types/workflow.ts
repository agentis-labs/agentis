/**
 * Workflow graph & run-state types.
 *
 * The shape of these types is the contract between the canvas, the engine,
 * and the persistence layer. Touch them here, then propagate.
 *
 * Mirrors V1-SPEC §6.2 and §6.3.
 */

export type WorkflowNodeType =
  // Control flow
  | 'trigger'
  | 'router'
  | 'merge'
  | 'subflow'
  | 'wait'
  | 'loop'
  | 'parallel'
  // Data & logic — deterministic, zero LLM tokens
  | 'transform'
  | 'filter'
  | 'integration'
  | 'http_request'
  | 'workflow_store'
  | 'scratchpad'
  // Intelligence — LLM-powered
  | 'agent_task'
  | 'skill_task'
  | 'agent_swarm'
  | 'evaluator'
  | 'guardrails'
  // Knowledge & enrichment
  | 'knowledge'
  | 'artifact_collect'
  // Human interaction
  | 'checkpoint';

export interface WorkflowGraph {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  viewport: { x: number; y: number; zoom: number };
  /** Optional input/output contracts — declared shape of what triggers this workflow + what it produces. */
  inputContract?: WorkflowContract;
  outputContract?: WorkflowContract;
  /** Named phase groups for large graphs. */
  phases?: WorkflowPhase[];
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
  /**
   * Edge semantics. Defaults to `'default'`.
   * - `'default'`  → normal success edge.
   * - `'error'`    → only traversed when the source node fails. Replaces run termination.
   * - `'condition'`→ traversed when the (already-evaluated) condition is truthy. Hint for renderer.
   */
  type?: 'default' | 'error' | 'condition';
}

/**
 * Declared contract for what a workflow accepts as trigger input or produces as final output.
 * Mirrors the shape brain-apps' `AppRuntimeContract` will reference — an "app" is, structurally,
 * a workflow with a named outputContract. Keep this shape stable.
 */
export interface WorkflowContract {
  fields: Array<{
    key: string;
    type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
    required?: boolean;
    description?: string;
    /** JSON Schema string for additional validation when `type` is `'object'` or `'array'`. */
    schema?: string;
  }>;
}

/** A named group of nodes used by the canvas for collapse/expand in large graphs. */
export interface WorkflowPhase {
  id: string;
  name: string;
  /** Hex color used for the canvas region background. */
  color: string;
  nodeIds: string[];
  collapsed?: boolean;
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
  | AgentSwarmNodeConfig
  | ArtifactCollectNodeConfig
  | WaitNodeConfig
  | TransformNodeConfig
  | FilterNodeConfig
  | IntegrationNodeConfig
  | HttpRequestNodeConfig
  | WorkflowStoreNodeConfig
  | EvaluatorNodeConfig
  | GuardrailsNodeConfig
  | LoopNodeConfig
  | ParallelNodeConfig
) & WorkflowOutputConfig;

/** Trigger node config. */
export interface TriggerNodeConfig {
  kind: 'trigger';
  triggerType:
    | 'manual'
    | 'cron'
    | 'webhook'
    | 'persistent_listener';
  triggerId?: string;
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

/**
 * Collect artifacts (files, media, generated pages) from upstream nodes into a
 * named, versioned collection. The node gathers `ArtifactRef` objects from the
 * input data and writes them to the artifact store.
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
// Control-flow & deterministic primitives
// ────────────────────────────────────────────────────────────

/** Time-based delay. Resumes the downstream chain after `delayMs`. */
export interface WaitNodeConfig {
  kind: 'wait';
  /** Delay in milliseconds. ≤0 completes instantly. */
  delayMs: number;
}

/** JS expression evaluated against `input`. Output replaces the node's outputData. */
export interface TransformNodeConfig {
  kind: 'transform';
  /** A JS expression. Receives `input` bound to inputData. Must return the output object. */
  expression: string;
  /** Optional key under which the result is also stored; otherwise the result is the whole output. */
  outputKey?: string;
}

/** Boolean gate. Truthy → `pass` handle; falsy → `skip` handle. */
export interface FilterNodeConfig {
  kind: 'filter';
  /** Boolean JS expression. Receives `input`. */
  condition: string;
  passLabel?: string;
  skipLabel?: string;
}

/** Call a registered integration connector (Slack / Gmail / GitHub / Sheets / HTTP …). */
export interface IntegrationNodeConfig {
  kind: 'integration';
  /** Connector slug from `ConnectorRegistry.list()`. */
  integrationId: string;
  /** Operation slug from the connector's manifest. */
  operationId: string;
  /** Resolved at dispatch time — values may contain `{{variable}}` templates. */
  inputs: Record<string, string>;
  /** Credential ID from the workspace credential store. Optional for connectors that don't require auth. */
  credentialId?: string;
}

/** Raw outbound HTTP for cases without a named connector. */
export interface HttpRequestNodeConfig {
  kind: 'http_request';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** URL template — supports `{{variable}}`. */
  url: string;
  /** Header templates. */
  headers?: Record<string, string>;
  /** Body template. Sent as-is when present. */
  body?: string;
  auth?:
    | { type: 'none' }
    | { type: 'bearer'; token: string }
    | { type: 'api_key'; header: string; token: string }
    | { type: 'basic'; username: string; password: string };
  /** Optional response extraction. */
  responseMapping?: {
    /** JSON-path-like dot notation (e.g. `data.items[0].id`). */
    bodyPath?: string;
    /** Key under which the extracted value is stored. */
    outputKey: string;
  };
  /** Status codes that trigger a retry (e.g. `[429, 503]`). */
  retryOn?: number[];
  /** Max retry attempts after the initial dispatch (default 0). */
  maxRetries?: number;
  /** Per-request timeout (default 30000). */
  timeoutMs?: number;
}

/**
 * Workflow-scoped persistent KV.
 *
 * Distinct from `scratchpad` (run-scoped, disposed on completion). `workflow_store`
 * survives run boundaries — a daily workflow can accumulate state across 30+ runs.
 * Brain-apps will index these entries as structured facts; the schema carries
 * `workspaceId` to support that without later migration.
 */
export interface WorkflowStoreNodeConfig {
  kind: 'workflow_store';
  operations: Array<{
    op: 'get' | 'set' | 'delete' | 'increment' | 'append' | 'get_all';
    /** Key template — supports `{{variable}}`. Required for everything except `get_all`. */
    key?: string;
    /** Value template — supports `{{variable}}`. Required for `set` / `append`. */
    value?: string;
    /** Result is stored under this key in the node's output. Defaults to the key name. */
    outputKey?: string;
    /** For `increment`. Defaults to 1. */
    incrementBy?: number;
  }>;
}

// ────────────────────────────────────────────────────────────
// Intelligence
// ────────────────────────────────────────────────────────────

/** LLM-as-judge: scores an upstream output and routes pass/fail. */
export interface EvaluatorNodeConfig {
  kind: 'evaluator';
  /** Path into the node's input to find what should be evaluated (dot notation). */
  targetPath: string;
  /** Natural-language acceptance criteria. */
  criteria: string;
  /** Minimum score (0–10) to pass. Default 7. */
  passThreshold?: number;
  /** Max times the FAIL edge may cycle back before terminating. Default 3. */
  maxRetries?: number;
  /** Optional rubric dimensions for multi-axis scoring. */
  rubric?: Array<{ dimension: string; weight: number }>;
}

/** Deterministic policy enforcement — rule-based, no LLM. */
export interface GuardrailsNodeConfig {
  kind: 'guardrails';
  rules: Array<{
    type: 'not_empty' | 'min_length' | 'max_length' | 'contains' | 'not_contains' | 'regex' | 'json_schema';
    /** Dot-notation path into input data. */
    target: string;
    /** Match string, regex pattern, or JSON Schema string depending on `type`. */
    value?: string;
    /** Length bound for `min_length` / `max_length`. */
    limit?: number;
    /** Human-readable message attached to violations. */
    message?: string;
  }>;
  /** `block` routes to the error edge; `flag` adds the violation array to output and continues. */
  onViolation: 'block' | 'flag';
}

// ────────────────────────────────────────────────────────────
// Loop / Parallel
// ────────────────────────────────────────────────────────────

/** Array iteration. Each item dispatches a child subflow with `{{loop.item}}` / `{{loop.index}}` bound. */
export interface LoopNodeConfig {
  kind: 'loop';
  /** Template expression resolving to the array (e.g. `{{nodes.step1.results}}`). */
  itemsExpression: string;
  /** Concurrency cap — 1 is sequential, >1 fans out in parallel. */
  maxConcurrency: number;
  /** Body workflow ID — invoked once per item via SubflowExecutor. */
  bodyWorkflowId: string;
  /** What happens when a single iteration fails. */
  onIterationError: 'stop_all' | 'continue' | 'collect_errors';
  /** Key under which iteration outputs are collected. */
  outputArrayKey: string;
  /**
   * For very large arrays: process this many at a time. Engine emits LOOP_PROGRESS
   * after each chunk completes. Defaults to processing all items at once.
   */
  chunkSize?: number;
}

/** Structural fan-out: every outgoing edge is a branch executed simultaneously. */
export interface ParallelNodeConfig {
  kind: 'parallel';
  /** `all` waits for every branch; `first` settles when any single branch completes. */
  waitFor: 'all' | 'first';
  onBranchError: 'fail_all' | 'continue_with_results';
  mergeStrategy: 'merge_keys' | 'collect_all' | 'first_non_null';
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
  /** The graph ran to completion but the final output did not match the declared outputContract. */
  | 'COMPLETED_WITH_CONTRACT_VIOLATION'
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
  executorType:
    | 'agent'
    | 'skill'
    | 'subflow'
    | 'router'
    | 'wait'
    | 'http'
    | 'integration'
    | 'evaluator'
    | 'loop';
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
