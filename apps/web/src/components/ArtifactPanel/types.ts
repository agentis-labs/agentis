import type { ArtifactType } from '@agentis/core';

export type { ArtifactType };
export type ArtifactOrigin = 'agent' | 'app' | 'workflow' | 'channel' | 'manual';

export interface Artifact {
  id: string;
  workspaceId: string;
  userId: string;
  runId: string | null;
  workflowId: string | null;
  agentId: string | null;
  appId: string | null;
  conversationId: string | null;
  nodeId: string | null;
  origin: ArtifactOrigin;
  type: ArtifactType;
  title: string;
  content: string;
  thumbnailUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type PanelState = 'closed' | 'floating' | 'docked' | 'fullscreen';



