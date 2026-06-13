export interface KnowledgeBaseRow {
  id: string;
  name: string;
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface KnowledgeDocumentRow {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName?: string;
  name: string;
  mimeType: string;
  status: string;
  tokenCount?: number;
  chunks?: number;
  createdAt?: string;
  updatedAt?: string;
}


// Brain — memory + episode row shapes (workspace Brain manage views).
export type MemoryKind = 'fact' | 'rule' | 'preference' | 'pattern' | 'lesson';

export interface MemoryRecordRowData {
  id: string;
  kind?: string;
  type?: string;
  title?: string;
  content: string;
  source?: string;
  sourceType?: string;
  trust?: number;
  confidence?: number;
  importance?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface EpisodeRowData {
  id: string;
  type: string;
  title?: string;
  summary: string;
  details?: string | null;
  confidence?: number;
  trust?: number;
  importance?: number;
  source?: string;
  runId?: string | null;
  workflowId?: string | null;
  scopeId?: string | null;
  createdAt?: string;
}
