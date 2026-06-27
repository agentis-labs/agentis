export type PlanStage = 'goal' | 'decisions' | 'build' | 'verify' | 'activate';
export type PlanNodeKind = 'goal' | 'decision' | 'action' | 'resource' | 'gate' | 'validation';
export type PlanRisk = 'low' | 'medium' | 'high' | 'destructive';
export type PlanStatus =
  | 'draft'
  | 'ready'
  | 'approved'
  | 'executing'
  | 'verifying'
  | 'blocked'
  | 'completed'
  | 'failed';
export type PlanNodeStatus = 'proposed' | 'unresolved' | 'blocked' | 'ready' | 'running' | 'completed' | 'failed';

export interface PlanEstimate {
  durationMinutes?: number;
  costCents?: number;
  reversible?: boolean;
}

export interface PlanDecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface PlanNode {
  id: string;
  kind: PlanNodeKind;
  stage: PlanStage;
  title: string;
  summary: string;
  status: PlanNodeStatus;
  position?: { x: number; y: number };
  resourceKind?: string;
  toolId?: string;
  toolArgs?: Record<string, unknown>;
  owner?: string;
  risk?: PlanRisk;
  required?: boolean;
  acknowledged?: boolean;
  options?: PlanDecisionOption[];
  selectedOptionId?: string;
  inputs?: string[];
  outputs?: string[];
  acceptanceCriteria?: string[];
  estimate?: PlanEstimate;
  evidence?: Array<{ label: string; url?: string }>;
}

export interface PlanEdge {
  id: string;
  source: string;
  target: string;
  optional?: boolean;
  animated?: boolean;
}

export interface PlanViewport {
  x: number;
  y: number;
  zoom: number;
  semanticZoom?: 'overview' | 'plan' | 'detail';
}

export interface PlanEvidenceRef {
  label: string;
  url?: string;
  runId?: string;
  sessionId?: string;
  nodeId?: string;
  toolCallId?: string;
  payload?: unknown;
}

export interface PlanDecisionRecord {
  id: string;
  summary: string;
  rationale?: string;
  actorId?: string;
  runId?: string;
  sessionId?: string;
  nodeId?: string;
  evidence?: PlanEvidenceRef[];
  createdAt: string;
}

export type PlanDeviationKind = 'reject_input' | 'rescope' | 'blocked';

export interface PlanDeviationRecord {
  id: string;
  kind: PlanDeviationKind;
  reason: string;
  proposed?: string;
  actorId?: string;
  runId?: string;
  sessionId?: string;
  nodeId?: string;
  evidence?: PlanEvidenceRef[];
  createdAt: string;
}

export interface PlanVerificationCriterion {
  criterion: string;
  passed: boolean;
  reason: string;
  evidence?: PlanEvidenceRef[];
}

export interface PlanVerification {
  id: string;
  status: 'passed' | 'failed';
  criteria: PlanVerificationCriterion[];
  output?: unknown;
  verifiedAt: string;
  verifier: 'deterministic' | 'judge';
}

export interface PlanPatch {
  addNodes?: PlanNode[];
  updateNodes?: Array<{ id: string; changes: Partial<PlanNode> }>;
  removeNodeIds?: string[];
  addEdges?: PlanEdge[];
  removeEdgeIds?: string[];
  viewport?: PlanViewport;
}

export interface ChatPlan {
  id: string;
  conversationId?: string | null;
  messageId?: string;
  runIds?: string[];
  sessionId?: string | null;
  version: number;
  approvedVersion?: number;
  status: PlanStatus;
  title: string;
  objective: string;
  summary: string;
  nodes: PlanNode[];
  edges: PlanEdge[];
  viewport?: PlanViewport;
  assumptions?: string[];
  acceptanceCriteria?: string[];
  decisions?: PlanDecisionRecord[];
  deviations?: PlanDeviationRecord[];
  verification?: PlanVerification;
  createdAt: string;
  updatedAt: string;
}

/**
 * Linear, surface-agnostic progress projection. One `WorkStep[]` is produced
 * from a ChatPlan's build-stage nodes (first-class) or derived from runtime
 * signals (fallback), and rendered identically in chat, the Live Workspace, and
 * channels via the shared StepTrack component.
 */
export type WorkStepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface WorkStep {
  id: string;
  label: string;
  status: WorkStepStatus;
  detail?: string;
}

export interface WorkStepTrack {
  steps: WorkStep[];
  /** 1-based index of the active (or last-completed) step; 0 when none started. */
  current: number;
  total: number;
}

function planNodeStatusToWorkStep(status: PlanNodeStatus): WorkStepStatus {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  return 'pending';
}

/** Roll an ordered step list into `{ current, total }` for the collapsed view. */
export function summarizeWorkSteps(steps: WorkStep[]): WorkStepTrack {
  const total = steps.length;
  const runningIndex = steps.findIndex((step) => step.status === 'running');
  const settled = steps.filter((step) => step.status === 'done' || step.status === 'failed').length;
  const current = runningIndex >= 0 ? runningIndex + 1 : settled;
  return { steps, current: Math.min(current, total), total };
}

/**
 * Canonical projection of a ChatPlan's build-stage nodes into the linear
 * `WorkStepTrack`. Shared by the API (channel progress text) and the web
 * StepTrack so the two never drift.
 */
export function projectPlanSteps(plan: Pick<ChatPlan, 'nodes'>): WorkStepTrack {
  const steps: WorkStep[] = plan.nodes
    .filter((node) => node.stage === 'build')
    .map((node) => ({
      id: node.id,
      label: node.title,
      status: planNodeStatusToWorkStep(node.status),
      ...(node.summary ? { detail: node.summary } : {}),
    }));
  return summarizeWorkSteps(steps);
}

export type PlanLifecycleEvent =
  | 'goal'
  | 'research'
  | 'decision'
  | 'node'
  | 'edge'
  | 'review'
  | 'ready'
  | 'version'
  | 'approved'
  | 'execution';
