import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthService } from '../services/auth.js';
import type { FileStorageService } from '../services/fileStorage.js';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const jsonUploadSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120).default('text/plain'),
  content: z.string().min(1).optional(),
  base64: z.string().min(1).optional(),
  sourceDocumentId: z.string().uuid().nullable().optional(),
});

export function buildFileRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; files: FileStorageService }) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ files: deps.files.listFiles(ws.workspaceId) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      const file = body.file as { arrayBuffer?: () => Promise<ArrayBuffer>; name?: string; type?: string } | undefined;
      if (!file?.arrayBuffer) return c.json({ error: { message: 'file field is required' } }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stored = await deps.files.storeFile({
        workspaceId: ws.workspaceId,
        userId: ws.user.id,
        name: file.name ?? 'upload.bin',
        mimeType: file.type ?? 'application/octet-stream',
        bytes,
        sourceDocumentId: typeof body.sourceDocumentId === 'string' ? body.sourceDocumentId : null,
      });
      return c.json({ file: stored }, 201);
    }

    const body = jsonUploadSchema.parse(await c.req.json());
    const bytes = body.base64
      ? Uint8Array.from(Buffer.from(body.base64, 'base64'))
      : Uint8Array.from(Buffer.from(body.content ?? '', 'utf8'));
    const stored = await deps.files.storeFile({
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      name: body.name,
      mimeType: body.mimeType,
      bytes,
      sourceDocumentId: body.sourceDocumentId ?? null,
    });
    return c.json({ file: stored }, 201);
  });

  app.get('/:fileId', async (c) => {
    const ws = getWorkspace(c);
    const { file, bytes } = await deps.files.readFile(ws.workspaceId, c.req.param('fileId'));
    return c.body(bytes, 200, {
      'content-type': file.mimeType,
      'content-length': String(file.sizeBytes),
      'content-disposition': `attachment; filename="${file.name.replace(/"/g, '')}"`,
    });
  });

  app.delete('/:fileId', async (c) => {
    const ws = getWorkspace(c);
    const file = await deps.files.deleteFile(ws.workspaceId, c.req.param('fileId'));
    return c.json({ file });
  });

  return app;
}
