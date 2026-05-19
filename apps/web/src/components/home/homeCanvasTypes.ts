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
  | 'app'
  | 'workflow'
  | 'knowledge'
  | 'artifact'
  | 'approval'
  | 'ghost';

export type CanvasEdgeType = 'command' | 'resource';

export interface HomeApp {
  id: string;
  slug: string;
  name: string;
  status?: string;
  deployStatus?: string | null;
  entryWorkflowId?: string | null;
  spaceId?: string | null;
  iconGlyph?: string;
  iconColor?: string;
  iconUrl?: string | null;
  imageUrl?: string | null;
  logoUrl?: string | null;
  avatarUrl?: string | null;
  category?: string;
}

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
}

export interface HomeKnowledgeBase {
  id: string;
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  imageUrl?: string | null;
}

export interface EcosystemData {
  apps: HomeApp[];
  workflows: HomeWorkflow[];
  knowledgeBases: HomeKnowledgeBase[];
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
  ghost?: boolean;
  role?: 'orchestrator' | 'manager' | 'worker';
  status?: string;
  route?: string;
  accent?: string;
  imageUrl?: string | null;
  icon?: ReactNode;
  currentTask?: string;
  progress?: number;
  startedAt?: string;
  tooltipLines: string[];
  agent?: WorkspaceAgent;
  app?: HomeApp;
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
  idleAgents: number;
  attentionCount: number;
  workflows: number;
  apps: number;
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
