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
