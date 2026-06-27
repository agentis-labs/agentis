import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AuthService } from '../services/auth.js';
import type { KnowledgeBaseService } from '../services/knowledgeBase.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const createKnowledgeBaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  scopeId: z.string().trim().min(1).optional(),
});

const updateKnowledgeBaseSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
});

const updateKnowledgeDocumentSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  chunks: z.array(z.object({
    id: z.string().trim().min(1),
    content: z.string().trim().min(1),
  })).optional(),
});

const addDocumentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120).default('text/plain'),
  content: z.string().min(1).optional(),
  contentBase64: z.string().min(1).optional(),
  describeImage: z.boolean().optional(),
}).refine((value) => Boolean(value.content || value.contentBase64), {
  message: 'content or contentBase64 is required',
});

const searchSchema = z.object({
  query: z.string().trim().min(1),
  topK: z.number().int().min(1).max(20).optional(),
  retrievalMode: z.enum(['contextual', 'strict', 'exploratory']).optional(),
});

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export function buildKnowledgeBaseRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; knowledge: KnowledgeBaseService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const scopeId = workflowScope(deps.db, ws.workspaceId, c.req.query('scopeId'));
    const knowledgeBases = deps.knowledge
      .listKnowledgeBases(ws.workspaceId, scopeId === undefined ? undefined : { scopeId })
      .map((base) => presentKnowledgeBase(deps.db, ws.workspaceId, base));
    return c.json({ knowledgeBases });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createKnowledgeBaseSchema.parse(await c.req.json());
    const queryScopeId = c.req.query('scopeId');
    if (body.scopeId && queryScopeId && body.scopeId !== queryScopeId) {
      throw new AgentisError('VALIDATION_FAILED', 'Knowledge base scope does not match the requested workflow');
    }
    const scopeId = workflowScope(deps.db, ws.workspaceId, body.scopeId ?? queryScopeId);
    const knowledgeBase = deps.knowledge.createKnowledgeBase({ workspaceId: ws.workspaceId, ...body, ...(scopeId ? { scopeId } : {}) });
    return c.json({ knowledgeBase: presentKnowledgeBase(deps.db, ws.workspaceId, knowledgeBase) }, 201);
  });

  app.get('/:knowledgeBaseId', (c) => {
    const ws = getWorkspace(c);
    const knowledgeBase = deps.knowledge.getKnowledgeBase(ws.workspaceId, c.req.param('knowledgeBaseId'));
    return c.json({ knowledgeBase: presentKnowledgeBase(deps.db, ws.workspaceId, knowledgeBase) });
  });

  app.patch('/:knowledgeBaseId', async (c) => {
    const ws = getWorkspace(c);
    const body = updateKnowledgeBaseSchema.parse(await c.req.json());
    const knowledgeBase = deps.knowledge.updateKnowledgeBase({
      workspaceId: ws.workspaceId,
      knowledgeBaseId: c.req.param('knowledgeBaseId'),
      ...body,
    });
    return c.json({ knowledgeBase: presentKnowledgeBase(deps.db, ws.workspaceId, knowledgeBase) });
  });

  app.delete('/:knowledgeBaseId', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.knowledge.deleteKnowledgeBase(ws.workspaceId, c.req.param('knowledgeBaseId')));
  });

  app.get('/:knowledgeBaseId/documents', (c) => {
    const ws = getWorkspace(c);
    const documents = deps.knowledge.listDocuments(ws.workspaceId, c.req.param('knowledgeBaseId'));
    return c.json({ documents });
  });

  app.get('/:knowledgeBaseId/documents/:documentId', (c) => {
    const ws = getWorkspace(c);
    const knowledgeBaseId = c.req.param('knowledgeBaseId');
    const documentId = c.req.param('documentId');
    const document = deps.knowledge.getDocument(ws.workspaceId, knowledgeBaseId, documentId);
    const chunks = deps.knowledge.listDocumentChunks(ws.workspaceId, knowledgeBaseId, documentId);
    return c.json({ document, chunks });
  });

  app.patch('/:knowledgeBaseId/documents/:documentId', async (c) => {
    const ws = getWorkspace(c);
    const body = updateKnowledgeDocumentSchema.parse(await c.req.json());
    const document = deps.knowledge.updateDocument({
      workspaceId: ws.workspaceId,
      knowledgeBaseId: c.req.param('knowledgeBaseId'),
      documentId: c.req.param('documentId'),
      ...body,
    });
    const chunks = deps.knowledge.listDocumentChunks(ws.workspaceId, c.req.param('knowledgeBaseId'), c.req.param('documentId'));
    return c.json({ document, chunks });
  });

  app.post('/:knowledgeBaseId/documents', async (c) => {
    const ws = getWorkspace(c);
    const body = await readDocumentUpload(c);
    const document = body.bytes
      ? await deps.knowledge.addDocumentFromBytes({
          workspaceId: ws.workspaceId,
          knowledgeBaseId: c.req.param('knowledgeBaseId'),
          name: body.name,
          mimeType: body.mimeType,
          bytes: body.bytes,
          describeImage: body.describeImage,
        })
      : await deps.knowledge.addDocument({
          workspaceId: ws.workspaceId,
          knowledgeBaseId: c.req.param('knowledgeBaseId'),
          name: body.name,
          mimeType: body.mimeType,
          content: body.content ?? '',
        });
    return c.json({ document }, 201);
  });

  app.delete('/:knowledgeBaseId/documents/:documentId', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.knowledge.archiveDocument(
      ws.workspaceId,
      c.req.param('knowledgeBaseId'),
      c.req.param('documentId'),
    ));
  });

  app.post('/:knowledgeBaseId/search', async (c) => {
    const ws = getWorkspace(c);
    const body = searchSchema.parse(await c.req.json());
    const results = await deps.knowledge.search({
      workspaceId: ws.workspaceId,
      knowledgeBaseId: c.req.param('knowledgeBaseId'),
      ...body,
    });
    return c.json({ results });
  });

  return app;
}

/**
 * Validate that a requested scoped Knowledge surface belongs to this workspace.
 * A scope is a Workflow OR an Agentic App (the App Brain → Knowledge facet binds
 * knowledge to `app.id`); either is a valid owner of a scoped Knowledge brain.
 */
function workflowScope(db: AgentisSqliteDb, workspaceId: string, scopeId: string | undefined): string | undefined {
  if (!scopeId) return undefined;
  const workflow = db.select({ id: schema.workflows.id })
    .from(schema.workflows)
    .where(and(eq(schema.workflows.id, scopeId), eq(schema.workflows.workspaceId, workspaceId)))
    .get();
  if (workflow) return workflow.id;
  const app = db.select({ id: schema.apps.id })
    .from(schema.apps)
    .where(and(eq(schema.apps.id, scopeId), eq(schema.apps.workspaceId, workspaceId)))
    .get();
  if (app) return app.id;
  // An Agent can also own a scoped Knowledge brain (Agent Brain → Knowledge).
  const agent = db.select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, scopeId), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (agent) return agent.id;
  throw new AgentisError('RESOURCE_NOT_FOUND', 'Knowledge scope not found');
}

function presentKnowledgeBase(
  db: AgentisSqliteDb,
  workspaceId: string,
  base: typeof schema.knowledgeBases.$inferSelect,
) {
  const ownerWorkflow = base.scopeId
    ? (db.select({ id: schema.workflows.id, title: schema.workflows.title })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, base.scopeId), eq(schema.workflows.workspaceId, workspaceId)))
        .get()
      // App-scoped brains own the knowledge via app.id — surface the App's name.
      ?? db.select({ id: schema.apps.id, title: schema.apps.name })
        .from(schema.apps)
        .where(and(eq(schema.apps.id, base.scopeId), eq(schema.apps.workspaceId, workspaceId)))
        .get()
      // Agent-scoped brains own knowledge via agent.id — surface the Agent's name.
      ?? db.select({ id: schema.agents.id, title: schema.agents.name })
        .from(schema.agents)
        .where(and(eq(schema.agents.id, base.scopeId), eq(schema.agents.workspaceId, workspaceId)))
        .get()
      ?? null)
    : null;
  const documentCountRow = db.select({ count: sql<number>`count(*)` })
    .from(schema.kbDocuments)
    .where(and(
      eq(schema.kbDocuments.workspaceId, workspaceId),
      eq(schema.kbDocuments.knowledgeBaseId, base.id),
      isNull(schema.kbDocuments.archivedAt),
    ))
    .get();

  return {
    ...base,
    scopeKind: base.scopeId ? 'workflow' as const : 'workspace' as const,
    ownerWorkflow,
    documentCount: Number(documentCountRow?.count ?? 0),
  };
}

type DocumentUpload = {
  name: string;
  mimeType: string;
  content?: string;
  bytes?: Buffer;
  describeImage?: boolean;
};

async function readDocumentUpload(c: Context): Promise<DocumentUpload> {
  const contentType = c.req.header('content-type') ?? 'application/json';
  if (contentType.startsWith('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!isFileLike(file)) throw new AgentisError('VALIDATION_FAILED', 'multipart/form-data must include a file field');
    const name = stringField(form.get('name')) ?? file.name ?? 'document';
    return {
      name,
      mimeType: stringField(form.get('mimeType')) ?? file.type ?? mimeTypeFromName(name),
      bytes: checkedBytes(Buffer.from(await file.arrayBuffer())),
      describeImage: stringField(form.get('describeImage')) === 'true',
    };
  }

  if (contentType.includes('application/octet-stream') || contentType.includes('application/pdf')) {
    const name = c.req.query('name') ?? c.req.header('x-file-name') ?? 'document';
    return {
      name,
      mimeType: c.req.header('x-file-type') ?? contentType.split(';')[0] ?? mimeTypeFromName(name),
      bytes: checkedBytes(Buffer.from(await c.req.arrayBuffer())),
    };
  }

  const body = addDocumentSchema.parse(await c.req.json());
  if (body.contentBase64) {
    return {
      name: body.name,
      mimeType: body.mimeType,
      bytes: checkedBytes(Buffer.from(stripDataUrlPrefix(body.contentBase64), 'base64')),
      describeImage: body.describeImage,
    };
  }
  assertDocumentBytes(Buffer.byteLength(body.content ?? '', 'utf8'));
  return {
    name: body.name,
    mimeType: body.mimeType,
    content: body.content,
  };
}

function checkedBytes(bytes: Buffer): Buffer {
  assertDocumentBytes(bytes.byteLength);
  return bytes;
}

function assertDocumentBytes(size: number): void {
  if (size > MAX_DOCUMENT_BYTES) {
    throw new AgentisError('VALIDATION_FAILED', 'Document exceeds the 10 MiB upload limit');
  }
}

function isFileLike(value: FormDataEntryValue | null): value is File {
  return Boolean(value && typeof value !== 'string' && typeof value.arrayBuffer === 'function');
}

function stringField(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stripDataUrlPrefix(value: string): string {
  const marker = ';base64,';
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
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
