export type ArtifactType = 'html' | 'image' | 'document' | 'code' | 'data';

export interface Artifact {
  id: string;
  workspaceId: string;
  userId: string;
  runId: string | null;
  workflowId: string | null;
  agentId: string | null;
  conversationId: string | null;
  nodeId: string | null;
  type: ArtifactType;
  title: string;
  content: string;
  thumbnailUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type PanelState = 'closed' | 'floating' | 'docked' | 'fullscreen';
