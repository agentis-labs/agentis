/**
 * Workflow graph & run-state types.
 *
 * The shape of these types is the contract between the canvas, the engine,
 * and the persistence layer. Touch them here, then propagate.
 *
 * Mirrors V1-SPEC §6.2 and §6.3.
 */

import type { AgentRole } from './specialist.js';
import type { AgentRequirements } from './adapter.js';
import type { ListenerConfig } from './listener.js';

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
  | 'workspace_store'
  | 'scratchpad'
  // Intelligence — LLM-powered
  | 'agent_task'
  | 'agent_session'
  | 'extension_task'
  | 'agent_swarm'
  | 'dynamic_swarm'
  | 'planner'
  | 'evaluator'
  | 'guardrails'
  // Knowledge & enrichment
  | 'knowledge'
  | 'artifact_collect'
  // Output surface — Layer 6
  | 'return_output'
  | 'artifact_save'
  // Native browser control — Layer 3 §3.2
  | 'browser'
  // Human interaction
  | 'checkpoint';

/**
 * How a node's output should be rendered on the operator-facing Output Surface
 * (WORKFLOW-10X-MASTERPLAN §6). Drives viewer selection in the web Output tab.
 */
export type OutputRenderAs = 'html' | 'markdown' | 'table' | 'json' | 'text';

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
 * Mirrors the shape Brain runtime evaluation references for workflow
 * inputs and outputs. Keep this shape stable.
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

/**
 * A phase is both a canvas grouping AND an execution primitive (Layer 5).
 * When `slaDurationMs` / `budgetCents` / `humanGate` are set, the engine
 * enforces them: SLA breach emits an alert (does not kill), budget overrun
 * halts the run, and human gates pause between phases.
 */
export interface WorkflowPhase {
  id: string;
  name: string;
  /** Hex color used for the canvas region background. */
  color: string;
  nodeIds: string[];
  collapsed?: boolean;
  /** SLA window for the whole phase. Breach alerts; it does not kill the run. */
  slaDurationMs?: number;
  /** Cost ceiling (cents) for the phase. Overrun halts the run with BUDGET_LIMIT_EXCEEDED. */
  budgetCents?: number;
  /** Human approval gate evaluated when the phase's first node becomes ready. */
  humanGate?: {
    type: 'approve' | 'provide_input' | 'review_output';
    message?: string;
    approvers?: string[];
    timeoutMs?: number;
    onTimeout?: 'escalate' | 'auto_approve' | 'fail';
    escalateTo?: string;
  };
  /** JS expression evaluated after the phase completes (advisory in V1). */
  successCriteria?: string;
  rollbackPlan?: string;
}

export interface WorkflowOutputConfig {
  /** Marks this node as part of the workflow's operator-facing output surface. */
  isOutput?: boolean;
  /**
   * Declared cost estimate (cents) for this node. Accumulated per-phase by the
   * engine for budget governance (Layer 5.3) and surfaced in the audit trail.
   */
  estimatedCostCents?: number;
}

export type WorkflowNodeConfig = (
  | TriggerNodeConfig
  | AgentTaskNodeConfig
  | AgentSessionNodeConfig
  | ExtensionTaskNodeConfig
  | KnowledgeNodeConfig
  | RouterNodeConfig
  | MergeNodeConfig
  | CheckpointNodeConfig
  | SubflowNodeConfig
  | ScratchpadNodeConfig
  | AgentSwarmNodeConfig
  | DynamicSwarmNodeConfig
  | PlannerNodeConfig
  | ArtifactCollectNodeConfig
  | WaitNodeConfig
  | TransformNodeConfig
  | FilterNodeConfig
  | IntegrationNodeConfig
  | HttpRequestNodeConfig
  | WorkflowStoreNodeConfig
  | WorkspaceStoreNodeConfig
  | EvaluatorNodeConfig
  | GuardrailsNodeConfig
  | LoopNodeConfig
  | ParallelNodeConfig
  | ReturnOutputNodeConfig
  | ArtifactSaveNodeConfig
  | BrowserNodeConfig
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
  /** Five-field cron expression authored on the canvas. */
  schedule?: string;
  /** IANA timezone used by node-cron. Defaults to UTC. */
  timezone?: string;
  /** Structured persistent-listener authoring config. */
  listenerConfig?: ListenerConfig;
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
  /**
   * Reference a specialist by role; the engine resolves it to the workspace's
   * agent carrying that role at dispatch time (Layer 2 §2.2). `agentId` wins
   * when both are set.
   */
  agentRole?: AgentRole;
  agentPackageRef?: string;
  capabilityTags: string[];
  /** Required runtime affordances used for capability-aware routing. */
  requires?: AgentRequirements;
  prompt: string;
  inputKeys: string[];
  outputKeys: string[];
  retryPolicy?: AgentRetryPolicy;
  /** Legacy/operator-facing protocol hints preserved for imported graphs. Prefer `extensions` for new runtime behavior. */
  skills?: string[];
  /** Optional behavioral protocol names injected into the prompt at dispatch. */
  extensions?: string[];
  /** Per-node model override (does not change the agent's global config). */
  modelOverride?: string;
  /** One-sentence rationale for the chosen specialist role (shown in the inspector). */
  castingReason?: string;
  /**
   * Run this task in-process via the agentic tool-use loop (§2.2) instead of
   * dispatching to an external adapter. Requires `agentRole` + a configured LLM
   * runtime; the loop is bounded by the role's tool manifest and `maxToolSteps`.
   */
  useRoleTools?: boolean;
  /** Cap on tool-use loop steps when `useRoleTools` is set (default 6, max 12). */
  maxToolSteps?: number;
  /**
   * Memory write-policy override (Brain Memory Formation §4.1). Controls what
   * this task may write to the Brain: `form` (may form durable memory),
   * `episodic_only` (one decaying outcome marker), or `none`. When unset, the
   * engine resolves a policy from the task's role and output shape.
   */
  memoryPolicy?: 'form' | 'episodic_only' | 'none';
  /**
   * Run this task as a persistent AgentSession (SMARTER-AGENTS-10X §VI) instead
   * of a one-shot dispatch: working memory, suspend/wake yield points, and
   * context compaction. Requires a configured session adapter. `agent_session`
   * nodes are the explicit form; this flag is the compat bridge for existing
   * `agent_task` nodes.
   */
  useSession?: boolean;
}

/**
 * A persistent agent session node (SMARTER-AGENTS-10X §VI). The engine drives a
 * thinking⇄doing loop with working memory and yield points (delegate, await
 * event, sleep, request approval) until the agent calls `complete_task`. Between
 * steps the session is a DB row, so a node can suspend for hours at zero cost.
 */
export interface AgentSessionNodeConfig {
  kind: 'agent_session';
  agentId?: string;
  agentRole?: AgentRole;
  /** The objective handed to the agent — seeds its `task` memory block. */
  prompt: string;
  /** Optional persona override; the specialist role's system prompt is used otherwise. */
  persona?: string;
  inputKeys: string[];
  outputKeys: string[];
  /** Hard cap on cognitive steps (engine-bounded regardless). */
  maxSteps?: number;
  capabilityTags: string[];
  /** Required runtime affordances used for capability-aware routing. */
  requires?: AgentRequirements;
}

/**
 * Dynamic swarm (SMARTER-AGENTS-10X §VII). A planner agent decides the task list
 * at runtime from a goal, then the engine fans those tasks out across worker
 * agents — bounded by `maxTasks`/`maxParallel`. Unlike `agent_swarm`, the task
 * set is not a static input array; it is synthesized per run.
 */
export interface DynamicSwarmNodeConfig {
  kind: 'dynamic_swarm';
  /** The objective the planner decomposes into parallel worker tasks. */
  goal: string;
  /** Worker specialist role applied to every synthesized task. */
  agentRole?: AgentRole;
  /** Planner specialist role that decides the task list (defaults to 'planner'). */
  plannerRole?: AgentRole;
  /** Hard cap on synthesized tasks (determinism cage). */
  maxTasks: number;
  maxParallel: number;
  mergeStrategy: 'collect_all' | 'first_success' | 'majority_vote';
  outputKey: string;
  capabilityTags: string[];
  /** Required runtime affordances applied to each worker session. */
  requires?: AgentRequirements;
}

/**
 * Planner node (SMARTER-AGENTS-10X §VII). A planner agent decomposes a goal into
 * a subgraph of `agent_session` steps and splices them into the live run via a
 * validated graph patch. The determinism cage bounds how many nodes one pass may
 * add.
 */
export interface PlannerNodeConfig {
  kind: 'planner';
  /** The objective to decompose. */
  goal: string;
  /** Planner specialist role (defaults to 'planner'). */
  agentRole?: AgentRole;
  agentId?: string;
  /** Worker role assigned to each synthesized plan step. */
  workerRole?: AgentRole;
  /** Max nodes the planner may add in one pass. */
  maxNodes?: number;
  inputKeys: string[];
  outputKeys: string[];
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
  /** Optional specialist role; resolved to a workspace agent at dispatch (Layer 2). */
  agentRole?: AgentRole;
  /** Required runtime affordances used when selecting the swarm worker agent. */
  requires?: AgentRequirements;
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

export interface ExtensionTaskNodeConfig {
  kind: 'extension_task';
  extensionId?: string;
  extensionSlug?: string;
  operationName: string;
  version?: string;
  inputMapping: Record<string, string>;
  outputMapping: Record<string, string>;
  timeoutMs?: number;
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
  routingMode: 'first_match' | 'all_matching' | 'llm_route' | 'space_route';
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
  /** Optional bounded execution deadline. The engine derives workload headroom when omitted. */
  timeoutMs?: number;
}

/** Boolean gate. Truthy → `pass` handle; falsy → `skip` handle. */
export interface FilterNodeConfig {
  kind: 'filter';
  /** Boolean JS expression. Receives `input`. */
  condition: string;
  passLabel?: string;
  skipLabel?: string;
  /** Optional bounded execution deadline. The engine derives workload headroom when omitted. */
  timeoutMs?: number;
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
    | { type: 'bearer'; credentialId: string }
    | { type: 'api_key'; header: string; credentialId: string }
    | { type: 'basic'; credentialId: string };
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
 * The Brain will index these entries as structured facts; the schema carries
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

/**
 * Workspace-scoped persistent KV (Tier 3). Same operation shape as
 * `workflow_store`, but the key space is shared across every workflow in the
 * workspace. Surfaced to templates as `{{workspace.kv.*}}`.
 */
export interface WorkspaceStoreNodeConfig {
  kind: 'workspace_store';
  operations: Array<{
    op: 'get' | 'set' | 'delete' | 'increment' | 'append' | 'get_all';
    key?: string;
    value?: string;
    outputKey?: string;
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
// Output surface — Layer 6
// ────────────────────────────────────────────────────────────

/**
 * Terminal output node. Declares the run's operator-facing result and how to
 * render it. Always part of the output surface (treated as `isOutput`). The
 * resolved value is what the Output tab renders via the viewer registry.
 *
 * This replaces the older "transform + isOutput" idiom for declaring output —
 * a `return_output` node makes the intent explicit and carries `renderAs` so
 * the Output Surface picks the right viewer (iframe for html, table for rows…).
 */
export interface ReturnOutputNodeConfig {
  kind: 'return_output';
  /** Viewer hint for the Output Surface. Defaults to `'json'`. */
  renderAs?: OutputRenderAs;
  /** Optional human label shown above the rendered output. */
  title?: string;
  /**
   * Dot path into the node input selecting the value to render. When omitted,
   * the whole merged input is the output. Supports `{{variable}}` templates too.
   */
  valuePath?: string;
}

/**
 * Persist a value as a workspace artifact (immutable run receipt). V1 stores
 * content inline in the `artifacts` table (same store as `artifact_collect`);
 * a future ArtifactStore backend swaps in transparently. Emits an artifact ref
 * downstream so subsequent nodes / the Output tab can reference it.
 */
export interface ArtifactSaveNodeConfig {
  kind: 'artifact_save';
  /** Artifact filename, e.g. "report.html". Supports `{{variable}}`. */
  name: string;
  /** Coarse artifact class used by the Output gallery / viewers. */
  artifactType?: 'html' | 'image' | 'document' | 'code' | 'data';
  /** Dot path into input for the content to persist. Defaults to whole input (JSON-encoded). */
  contentPath?: string;
  /** Dot path into input for an optional title. */
  titlePath?: string;
}

// ────────────────────────────────────────────────────────────
// Native browser control — Layer 3 §3.2
// ────────────────────────────────────────────────────────────

/**
 * Native Playwright-backed browser node. Renders HTML / navigates URLs and
 * produces artifacts (screenshot PNG, PDF) — no external screenshot service.
 * Runs in the engine's BrowserPool (headless Chromium, capped concurrency).
 */
export interface BrowserNodeConfig {
  kind: 'browser';
  operation:
    | 'serve_html'      // render an HTML string, screenshot it, emit html + image artifact
    | 'screenshot'      // screenshot a URL (or inline html) → image artifact
    | 'pdf'             // print a URL (or inline html) to PDF → document artifact
    | 'navigate'        // load a URL, return { title, text, html }
    | 'extract_text'    // load a URL/html, return visible text under selector
    | 'fill_form'       // fill fields by selector, optionally submit
    | 'extract_table';  // extract a <table> into row objects
  /** Target URL. Supports `{{variable}}` interpolation. */
  url?: string;
  /** Inline HTML to render (serve_html / screenshot / pdf). Supports templates. */
  html?: string;
  /** Dot path into the node input to read the HTML from (chains after a transform). */
  htmlPath?: string;
  /** CSS selector for extract_text / extract_table (defaults to body / first table). */
  selector?: string;
  /** For fill_form: selector → value map. Supports `{{variable}}` in values. */
  formData?: Record<string, string>;
  /** For fill_form: optional element to click after filling (submit). */
  submitSelector?: string;
  /** Full-page screenshot (default true). */
  fullPage?: boolean;
  /** Open a visible browser window on the operator's desktop (default false → headless). */
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Per-op timeout (default 30000ms). */
  timeout?: number;
  /** Artifact filename for the produced screenshot/pdf. */
  artifactName?: string;
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
  /** The graph reached the end but a node errored (even if "handled" by an error edge) — NOT a clean success. Treated as a failure for surfacing + diagnosis. */
  | 'COMPLETED_WITH_ERRORS'
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
  /**
   * AEJ idempotency key (NATIVE-ADVANCEMENT Proposal 1). Set when a node is
   * re-dispatched after crash recovery so dedup-capable handlers/connectors
   * (e.g. an HTTP `Idempotency-Key` header) make the retry effectively once.
   */
  idempotencyKey?: string;
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
  /** Immutable presentation-safe snapshot of a message delivered by an integration. */
  deliveryReceipt?: IntegrationDeliveryReceipt;
  error?: string;
  /**
   * Set when the node is PAUSED (status WAITING) on a recoverable infrastructure
   * failure — e.g. the agent's model ran out of credits. Carries a plain-language
   * reason; cleared on resume. Distinguishes an operator-actionable pause from a
   * scheduled/approval WAITING.
   */
  blockedReason?: string;
}

export interface IntegrationDeliveryReceipt {
  integrationId: string;
  operationId: string;
  recipient?: string;
  subject?: string;
  contentType: 'html' | 'markdown' | 'text';
  content: string;
  /** Plain-text alternative when the delivered content was rich text. */
  text?: string;
  capturedAt?: string;
}

export interface ActiveExecution {
  taskId: string;
  nodeId: string;
  executorType:
    | 'agent'
    | 'extension'
    | 'subflow'
    | 'router'
    | 'wait'
    | 'http'
    | 'integration'
    | 'evaluator'
    | 'loop'
    | 'browser'
    | 'session';
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
