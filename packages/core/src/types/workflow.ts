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
  | 'router'
  | 'merge'
  | 'checkpoint'
  | 'subflow'
  | 'scratchpad';

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

export type WorkflowNodeConfig =
  | TriggerNodeConfig
  | AgentTaskNodeConfig
  | SkillTaskNodeConfig
  | RouterNodeConfig
  | MergeNodeConfig
  | CheckpointNodeConfig
  | SubflowNodeConfig
  | ScratchpadNodeConfig;

export interface TriggerNodeConfig {
  kind: 'trigger';
  triggerType: 'manual' | 'cron' | 'webhook' | 'persistent_listener';
  triggerId?: string;
}

export interface AgentTaskNodeConfig {
  kind: 'agent_task';
  agentId?: string;
  agentPackageRef?: string;
  capabilityTags: string[];
  prompt: string;
  inputKeys: string[];
  outputKeys: string[];
}

export interface SkillTaskNodeConfig {
  kind: 'skill_task';
  skillId: string;
  inputMapping: Record<string, string>;
  outputMapping: Record<string, string>;
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
