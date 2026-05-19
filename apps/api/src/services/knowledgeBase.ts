import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export interface CreateKnowledgeBaseArgs {
  workspaceId: string;
  name: string;
  description?: string | null;
}

export interface AddKnowledgeDocumentArgs {
  workspaceId: string;
  knowledgeBaseId: string;
  name: string;
  mimeType?: string;
  content: string;
}

export interface AddKnowledgeDocumentBytesArgs {
  workspaceId: string;
  knowledgeBaseId: string;
  name: string;
  mimeType?: string;
  bytes: Buffer;
}

export interface UpdateKnowledgeBaseArgs {
  workspaceId: string;
  knowledgeBaseId: string;
  name?: string;
  description?: string | null;
}

export interface SearchKnowledgeArgs {
  workspaceId: string;
  knowledgeBaseId: string;
  query: string;
  topK?: number;
}

export class KnowledgeBaseService {
  constructor(private readonly db: AgentisSqliteDb) {}

  listKnowledgeBases(workspaceId: string) {
    return this.db
      .select()
      .from(schema.knowledgeBases)
      .where(eq(schema.knowledgeBases.workspaceId, workspaceId))
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getKnowledgeBase(workspaceId: string, knowledgeBaseId: string) {
    const kb = this.db
      .select()
      .from(schema.knowledgeBases)
      .where(
        and(
          eq(schema.knowledgeBases.id, knowledgeBaseId),
          eq(schema.knowledgeBases.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!kb) throw new AgentisError('RESOURCE_NOT_FOUND', 'Knowledge base not found');
    return kb;
  }

  createKnowledgeBase(args: CreateKnowledgeBaseArgs) {
    const now = new Date().toISOString();
    const kb = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      name: args.name,
      description: args.description ?? null,
      embeddingModel: 'lexical-v1',
      embeddingDimension: 0,
      chunkingConfig: { maxTokens: 240, overlapTokens: 40 } as unknown as object,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.knowledgeBases).values(kb).run();
    return kb;
  }

  updateKnowledgeBase(args: UpdateKnowledgeBaseArgs) {
    const existing = this.getKnowledgeBase(args.workspaceId, args.knowledgeBaseId);
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.description !== undefined) patch.description = args.description;
    this.db.update(schema.knowledgeBases).set(patch).where(eq(schema.knowledgeBases.id, existing.id)).run();
    return { ...existing, ...patch };
  }

  deleteKnowledgeBase(workspaceId: string, knowledgeBaseId: string) {
    this.getKnowledgeBase(workspaceId, knowledgeBaseId);
    this.db.delete(schema.kbChunks).where(eq(schema.kbChunks.knowledgeBaseId, knowledgeBaseId)).run();
    this.db.delete(schema.kbDocuments).where(eq(schema.kbDocuments.knowledgeBaseId, knowledgeBaseId)).run();
    this.db.delete(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, knowledgeBaseId)).run();
    return { id: knowledgeBaseId, deleted: true };
  }

  listDocuments(workspaceId: string, knowledgeBaseId: string) {
    this.getKnowledgeBase(workspaceId, knowledgeBaseId);
    return this.db
      .select()
      .from(schema.kbDocuments)
      .where(
        and(
          eq(schema.kbDocuments.workspaceId, workspaceId),
          eq(schema.kbDocuments.knowledgeBaseId, knowledgeBaseId),
        ),
      )
      .all()
      .filter((document) => !document.archivedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  addDocument(args: AddKnowledgeDocumentArgs) {
    const knowledgeBase = this.getKnowledgeBase(args.workspaceId, args.knowledgeBaseId);
    const mimeType = args.mimeType ?? mimeTypeFromName(args.name);
    const content = extractText(args.content, mimeType);
    if (!content.trim()) throw new AgentisError('VALIDATION_FAILED', 'Document content is empty');

    return this.persistDocument({
      workspaceId: args.workspaceId,
      knowledgeBaseId: args.knowledgeBaseId,
      name: args.name,
      mimeType,
      content,
    });
  }

  async addDocumentFromBytes(args: AddKnowledgeDocumentBytesArgs) {
    this.getKnowledgeBase(args.workspaceId, args.knowledgeBaseId);
    const mimeType = args.mimeType ?? mimeTypeFromName(args.name);
    const content = await extractTextFromBytes(args.bytes, mimeType, args.name);
    if (!content.trim()) throw new AgentisError('VALIDATION_FAILED', 'Document content is empty');

    return this.persistDocument({
      workspaceId: args.workspaceId,
      knowledgeBaseId: args.knowledgeBaseId,
      name: args.name,
      mimeType,
      content,
    });
  }

  private persistDocument(args: AddKnowledgeDocumentArgs & { content: string }) {
    const now = new Date().toISOString();
    const documentId = randomUUID();
    const chunks = chunkText(args.content);
    const document = {
      id: documentId,
      knowledgeBaseId: args.knowledgeBaseId,
      workspaceId: args.workspaceId,
      name: args.name,
      mimeType: args.mimeType ?? 'text/plain',
      status: 'ready',
      tokenCount: tokenize(args.content).length,
      error: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.kbDocuments).values(document).run();
    const chunkIds: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const chunkId = randomUUID();
      chunkIds.push(chunkId);
      this.db.insert(schema.kbChunks).values({
        id: chunkId,
        documentId,
        knowledgeBaseId: args.knowledgeBaseId,
        workspaceId: args.workspaceId,
        chunkIndex: index,
        content: chunk,
        metadata: { source: args.name } as unknown as object,
        tokenCount: tokenize(chunk).length,
        createdAt: now,
      }).run();
    }

    return { ...document, chunks: chunks.length };
  }

  archiveDocument(workspaceId: string, knowledgeBaseId: string, documentId: string) {
    this.getKnowledgeBase(workspaceId, knowledgeBaseId);
    const document = this.db
      .select()
      .from(schema.kbDocuments)
      .where(
        and(
          eq(schema.kbDocuments.workspaceId, workspaceId),
          eq(schema.kbDocuments.knowledgeBaseId, knowledgeBaseId),
          eq(schema.kbDocuments.id, documentId),
        ),
      )
      .get();
    if (!document) throw new AgentisError('RESOURCE_NOT_FOUND', 'Document not found');
    const now = new Date().toISOString();
    this.db.update(schema.kbDocuments)
      .set({ status: 'archived', archivedAt: now, updatedAt: now })
      .where(eq(schema.kbDocuments.id, documentId))
      .run();
    return { id: documentId, archived: true };
  }

  search(args: SearchKnowledgeArgs) {
    this.getKnowledgeBase(args.workspaceId, args.knowledgeBaseId);
    const queryTokens = new Set(tokenize(args.query));
    if (queryTokens.size === 0) return [];
    const topK = Math.min(Math.max(args.topK ?? 5, 1), 20);
    const chunks = this.db
      .select()
      .from(schema.kbChunks)
      .where(
        and(
          eq(schema.kbChunks.workspaceId, args.workspaceId),
          eq(schema.kbChunks.knowledgeBaseId, args.knowledgeBaseId),
        ),
      )
      .all();

    return chunks
      .filter((chunk) => this.isDocumentActive(args.workspaceId, chunk.documentId))
      .map((chunk) => ({ chunk, score: scoreChunk(queryTokens, chunk.content) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ chunk, score }) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        metadata: chunk.metadata,
        score,
      }));
  }

  private isDocumentActive(workspaceId: string, documentId: string): boolean {
    const document = this.db.select({ archivedAt: schema.kbDocuments.archivedAt })
      .from(schema.kbDocuments)
      .where(and(eq(schema.kbDocuments.workspaceId, workspaceId), eq(schema.kbDocuments.id, documentId)))
      .get();
    return Boolean(document && !document.archivedAt);
  }
}

function extractText(content: string, mimeType: string): string {
  const normalizedType = mimeType.toLowerCase();
  if (isHtmlDocument(normalizedType)) {
    return htmlToText(content);
  }
  if (normalizedType.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }
  return content;
}

async function extractTextFromBytes(bytes: Buffer, mimeType: string, fileName: string): Promise<string> {
  const normalizedType = mimeType.toLowerCase();
  const normalizedName = fileName.toLowerCase();
  if (normalizedType.includes('pdf') || normalizedName.endsWith('.pdf')) {
    try {
      const { PDFParse } = await import('pdf-parse') as typeof import('pdf-parse');
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        return result.text ?? '';
      } finally {
        await parser.destroy();
      }
    } catch (err) {
      throw new AgentisError('VALIDATION_FAILED', `Could not extract text from PDF: ${(err as Error).message}`);
    }
  }

  if (
    normalizedType.includes('wordprocessingml.document')
    || normalizedType.includes('msword')
    || normalizedName.endsWith('.docx')
  ) {
    try {
      const mammoth = await import('mammoth') as typeof import('mammoth');
      const result = await mammoth.extractRawText({ buffer: bytes });
      return result.value ?? '';
    } catch (err) {
      throw new AgentisError('VALIDATION_FAILED', `Could not extract text from DOCX: ${(err as Error).message}`);
    }
  }

  const text = bytes.toString('utf8');
  if (looksBinary(text)) {
    throw new AgentisError('VALIDATION_FAILED', 'Unsupported binary document type. Upload PDF, DOCX, HTML, Markdown, text, CSV, or JSON.');
  }
  return isHtmlDocument(mimeType, fileName) ? htmlToText(text) : extractText(text, mimeType);
}

function looksBinary(text: string): boolean {
  if (!text) return false;
  const replacementChars = (text.match(/\uFFFD/g) ?? []).length;
  const nullChars = (text.match(/\0/g) ?? []).length;
  return replacementChars + nullChars > Math.max(8, text.length * 0.01);
}

function mimeTypeFromName(fileName: string): string {
  const name = fileName.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'text/html';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'text/markdown';
  return 'text/plain';
}

function isHtmlDocument(mimeType: string, fileName = ''): boolean {
  const type = mimeType.toLowerCase();
  const name = fileName.toLowerCase();
  return type.includes('html') || name.endsWith('.html') || name.endsWith('.htm');
}

function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|header|footer|main|aside|li|ul|ol|table|thead|tbody|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(withBreaks)
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    return named[lower] ?? match;
  });
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10FFFF;
}

function chunkText(content: string, maxTokens = 240, overlapTokens = 40): string[] {
  const words = content.split(/\s+/).filter(Boolean);
  if (words.length <= maxTokens) return [content.trim()];
  const chunks: string[] = [];
  const step = Math.max(maxTokens - overlapTokens, 1);
  for (let start = 0; start < words.length; start += step) {
    chunks.push(words.slice(start, start + maxTokens).join(' '));
    if (start + maxTokens >= words.length) break;
  }
  return chunks;
}

function scoreChunk(queryTokens: Set<string>, content: string): number {
  const contentTokens = new Set(tokenize(content));
  if (contentTokens.size === 0) return 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) hits += 1;
  }
  return hits / Math.sqrt(queryTokens.size * contentTokens.size);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}
