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

