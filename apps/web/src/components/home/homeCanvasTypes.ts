import type { ReactNode } from 'react';
import type {
  WorkspaceActiveRun,
  WorkspaceAgent,
  WorkspaceApproval,
  WorkspaceArtifact,
} from '../../lib/workspaceData';

export interface Vec2 {
  x: number;
  y: number;
}

export type CanvasNodeKind =
  | 'orchestrator'
  | 'manager'
  | 'worker'
  | 'workflow'
  | 'knowledge'
  | 'artifact'
  | 'approval'
  | 'ghost';

export type CanvasEdgeType = 'command' | 'resource';
export type CanvasOperationalState = 'active' | 'idle' | 'attention' | 'error' | 'offline';

export interface HomeWorkflow {
  id: string;
  title?: string;
  name?: string;
  status?: string;
  spaceId?: string | null;
  iconUrl?: string | null;
  imageUrl?: string | null;
  coverUrl?: string | null;
  avatarUrl?: string | null;
  settings?: Record<string, unknown> | null;
  graph?: {
    nodes?: Array<{
      id: string;
      type: string;
      title: string;
      position?: { x: number; y: number };
      config?: { kind: string; [k: string]: any };
    }>;
    edges?: Array<{ id: string; source: string; target: string }>;
  } | null;
}

export interface HomeKnowledgeBase {
  id: string;
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  imageUrl?: string | null;
}

export interface HomeSpace {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  colorHex?: string | null;
  icon?: string | null;
}

export interface EcosystemData {
  workflows: HomeWorkflow[];
  knowledgeBases: HomeKnowledgeBase[];
  spaces: HomeSpace[];
  loading: boolean;
}

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  tier: number;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  width: number;
  height: number;
  active?: boolean;
  warn?: boolean;
  outOfCredits?: boolean;
  ghost?: boolean;
  role?: 'orchestrator' | 'manager' | 'worker';
  status?: string;
  online?: boolean;
  operationalState?: CanvasOperationalState;
  route?: string;
  spaceId?: string | null;
  spaceName?: string | null;
  accent?: string;
  artifactCount?: number;
  imageUrl?: string | null;
  icon?: ReactNode;
  currentTask?: string;
  currentTool?: string | null;
  outputLines?: string[];
  runtimeError?: string | null;
  progress?: number;
  startedAt?: string;
  tooltipLines: string[];
  agent?: WorkspaceAgent;
  workflow?: HomeWorkflow;
  knowledge?: HomeKnowledgeBase;
  artifact?: WorkspaceArtifact;
  approval?: WorkspaceApproval;
  connectedAgentIds?: string[];
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  type: CanvasEdgeType;
  activeRunCount: number;
  active?: boolean;
  busy?: boolean;
}

export interface EdgeAnimation {
  count: number;
  dur: number;
  opacity: number;
  strokeColor: string;
  strokeWidth: number;
}

export interface CanvasActivityItem {
  id: string;
  label: string;
  title: string;
  detail?: string;
  timestamp: string;
  route: string;
  tone: 'accent' | 'warn' | 'danger' | 'muted';
}

export interface CanvasModel {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  orchestratorId: string | null;
  activeAgentIds: Set<string>;
}

export interface FleetCounts {
  activeAgents: number;
  runningAgents?: number;
  idleAgents: number;
  attentionCount: number;
  approvalCount: number;
  failedRunCount: number;
  workflows: number;
  artifactsToday?: number;
}

export interface ComposerRecentCompletion {
  workflowName: string;
  completedAt: number;
}

export interface ComposerUser {
  firstName?: string;
  name?: string;
}

export type ComposerContextAgent = WorkspaceAgent & {
  role?: string | null;
  runtimeModel?: string | null;
  adapterType?: string | null;
};

export type ComposerContextRun = WorkspaceActiveRun;
