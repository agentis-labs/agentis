import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export interface StoreWorkspaceFileArgs {
  workspaceId: string;
  userId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  sourceDocumentId?: string | null;
}

export class FileStorageService {
  private readonly rootDir: string;

  constructor(private readonly db: AgentisSqliteDb, dataDir: string) {
    this.rootDir = path.join(dataDir, 'files');
  }

  listFiles(workspaceId: string) {
    return this.db
      .select()
      .from(schema.workspaceFiles)
      .where(eq(schema.workspaceFiles.workspaceId, workspaceId))
      .all()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getFile(workspaceId: string, fileId: string) {
    const file = this.db
      .select()
      .from(schema.workspaceFiles)
      .where(and(eq(schema.workspaceFiles.id, fileId), eq(schema.workspaceFiles.workspaceId, workspaceId)))
      .get();
    if (!file) throw new AgentisError('RESOURCE_NOT_FOUND', 'File not found');
    return file;
  }

  async storeFile(args: StoreWorkspaceFileArgs) {
    if (!args.bytes.length) throw new AgentisError('VALIDATION_FAILED', 'File is empty');
    const id = randomUUID();
    const now = new Date().toISOString();
    const safeName = sanitizeFileName(args.name);
    const storageKey = path.join(args.workspaceId, `${id}-${safeName}`);
    const fullPath = this.resolveStorageKey(storageKey);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, args.bytes);
    const row = {
      id,
      workspaceId: args.workspaceId,
      userId: args.userId,
      name: safeName,
      mimeType: args.mimeType || 'application/octet-stream',
      sizeBytes: args.bytes.byteLength,
      storageKey,
      checksumSha256: createHash('sha256').update(args.bytes).digest('hex'),
      sourceDocumentId: args.sourceDocumentId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.workspaceFiles).values(row).run();
    return row;
  }

  async readFile(workspaceId: string, fileId: string) {
    const file = this.getFile(workspaceId, fileId);
    const bytes = await readFile(this.resolveStorageKey(file.storageKey));
    return { file, bytes };
  }

  async deleteFile(workspaceId: string, fileId: string) {
    const file = this.getFile(workspaceId, fileId);
    this.db
      .delete(schema.workspaceFiles)
      .where(and(eq(schema.workspaceFiles.id, fileId), eq(schema.workspaceFiles.workspaceId, workspaceId)))
      .run();
    try {
      await unlink(this.resolveStorageKey(file.storageKey));
    } catch {
      // Metadata deletion is authoritative; missing local blobs are cleaned up by replacement uploads.
    }
    return { id: fileId };
  }

  private resolveStorageKey(storageKey: string) {
    const resolved = path.resolve(this.rootDir, storageKey);
    const root = path.resolve(this.rootDir);
    if (!resolved.startsWith(root)) throw new AgentisError('VALIDATION_FAILED', 'Invalid storage key');
    return resolved;
  }
}

function sanitizeFileName(name: string): string {
  const safe = path.basename(name || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || 'upload.bin';
}
