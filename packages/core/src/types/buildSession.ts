/**
 * Durable construction contracts shared by chat, tools, HTTP and operator UI.
 *
 * These records deliberately separate semantic identity from revision history:
 * an App keeps one stable name while its blueprint receives monotonic revisions.
 */

export type BuildStage =
  | 'discover'
  | 'plan'
  | 'validate'
  | 'materialize'
  | 'execute'
  | 'verify'
  | 'repair'
  | 'deliver';

export type BuildSessionStatus =
  | 'running'
  | 'validated'
  | 'blocked'
  | 'failed'
  | 'completed';

export interface WorkspaceSnapshotResource {
  id: string;
  name: string;
  status?: string | null;
  kind?: string | null;
  appId?: string | null;
  ownerAgentId?: string | null;
  revisionId?: string | null;
}

/** Tool-backed, point-in-time inventory. Models may only assert workspace facts present here. */
export interface WorkspaceSnapshot {
  workspaceId: string;
  capturedAt: string;
  capabilityCatalogHash?: string | null;
  apps: WorkspaceSnapshotResource[];
  workflows: WorkspaceSnapshotResource[];
  agents: WorkspaceSnapshotResource[];
  extensions: WorkspaceSnapshotResource[];
  knowledgeBases: WorkspaceSnapshotResource[];
}

export interface BlueprintPort {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
  required?: boolean;
  description?: string;
}

export interface BlueprintRuntimeRequirement {
  runtime?: string;
  model?: string;
  capabilities?: string[];
}

export interface BlueprintRole {
  key: string;
  role: string;
  name?: string;
  /** Enduring App roles only. Temporary workers belong in `swarms`. */
  durable: true;
  runtime?: BlueprintRuntimeRequirement;
  skillIds?: string[];
  brainIds?: string[];
}

export interface SwarmTemplate {
  key: string;
  purpose: string;
  workerRole: string;
  maxWorkers: number;
  runtime?: BlueprintRuntimeRequirement;
  skillIds?: string[];
  brainIds?: string[];
  persist: 'evidence_only';
}

export interface WorkflowPort {
  key: string;
  title: string;
  purpose: string;
  dependsOn: string[];
  activation: 'after_success' | 'event' | 'operator';
  trigger?: string;
  ownerRoleKey?: string;
  swarmKey?: string;
  inputs: BlueprintPort[];
  outputs: BlueprintPort[];
  acceptanceCriteria: string[];
}

export interface AppBlueprint {
  id: string;
  workspaceId: string;
  appId?: string | null;
  semanticKey: string;
  name: string;
  intent: string;
  revision: number;
  status: 'draft' | 'validated' | 'materializing' | 'verified' | 'rejected';
  roles: BlueprintRole[];
  swarms: SwarmTemplate[];
  workflows: WorkflowPort[];
  collections: Array<{ key: string; purpose?: string }>;
  interfaces: Array<{ key: string; title: string; purpose: string }>;
  acceptanceCriteria: string[];
  validation: BlueprintValidationResult;
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintValidationIssue {
  code:
    | 'EMPTY_BLUEPRINT'
    | 'DUPLICATE_KEY'
    | 'UNKNOWN_DEPENDENCY'
    | 'DEPENDENCY_CYCLE'
    | 'UNKNOWN_ROLE'
    | 'UNKNOWN_SWARM'
    | 'MISSING_ACCEPTANCE'
    | 'ORDINAL_FEATURE_NAME';
  path: string;
  message: string;
}

export interface BlueprintValidationResult {
  valid: boolean;
  issues: BlueprintValidationIssue[];
}

export interface BuildEvidence {
  id: string;
  kind: 'snapshot' | 'tool' | 'mutation' | 'artifact' | 'run' | 'verification';
  label: string;
  at: string;
  resourceType?: string;
  resourceId?: string;
  payload?: unknown;
}

export interface BuildDiagnostic {
  code: string;
  message: string;
  stage: BuildStage;
  resourceType?: string;
  resourceId?: string;
  retryable: boolean;
  remediation?: string;
}

export interface BuildSession {
  id: string;
  workspaceId: string;
  blueprintId: string;
  appId?: string | null;
  conversationId?: string | null;
  ownerAgentId?: string | null;
  stage: BuildStage;
  status: BuildSessionStatus;
  snapshot: WorkspaceSnapshot;
  evidence: BuildEvidence[];
  diagnostic?: BuildDiagnostic | null;
  repairAttempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

/** Persisted facts for one concrete execution, including resolution precedence. */
export interface ExecutionEnvelope {
  requestedModel?: string | null;
  nodeModelOverride?: string | null;
  agentRuntime?: string | null;
  agentModel?: string | null;
  workspaceRuntime?: string | null;
  workspaceModel?: string | null;
  resolvedRuntime: string;
  resolvedModel?: string | null;
  resolvedFrom: 'node' | 'agent' | 'workspace';
  capabilities: string[];
  skillIds: string[];
  brainIds: string[];
  resolvedAt: string;
}

/** Stable operator-facing projection of the durable observability stream. */
export interface OperatorEvent {
  id: string;
  workspaceId: string;
  at: string;
  title: string;
  summary?: string;
  status: 'info' | 'running' | 'success' | 'warning' | 'error';
  tool?: string;
  gatewayTool?: string;
  resourceType?: string;
  resourceId?: string;
  durationMs?: number;
  failureCategory?: string;
}
