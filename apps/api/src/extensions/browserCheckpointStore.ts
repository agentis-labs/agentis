import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { PWStorageState } from '../services/browserPool.js';
import type { CredentialVault } from '../services/credentialVault.js';

export interface ExtensionBrowserCheckpoint {
  storageState: PWStorageState;
  lastUrl: string;
  viewport?: { width: number; height: number };
  savedAt: string;
}

/** Credential-grade persistence for extension-owned browser sessions. */
export class ExtensionBrowserCheckpointStore {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly vault: CredentialVault,
  ) {}

  load(workspaceId: string, extensionId: string, sessionName: string): ExtensionBrowserCheckpoint | null {
    const row = this.db
      .select({ encryptedValue: schema.extensionBrowserCheckpoints.encryptedValue })
      .from(schema.extensionBrowserCheckpoints)
      .where(and(
        eq(schema.extensionBrowserCheckpoints.workspaceId, workspaceId),
        eq(schema.extensionBrowserCheckpoints.extensionId, extensionId),
        eq(schema.extensionBrowserCheckpoints.sessionName, sessionName),
      ))
      .get();
    if (!row) return null;
    try {
      const parsed = JSON.parse(this.vault.decrypt(row.encryptedValue)) as ExtensionBrowserCheckpoint;
      if (!parsed || typeof parsed !== 'object' || !parsed.storageState || typeof parsed.lastUrl !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  save(
    workspaceId: string,
    extensionId: string,
    sessionName: string,
    checkpoint: Omit<ExtensionBrowserCheckpoint, 'savedAt'>,
  ): void {
    const now = new Date().toISOString();
    const encryptedValue = this.vault.encrypt(JSON.stringify({ ...checkpoint, savedAt: now }));
    this.db
      .insert(schema.extensionBrowserCheckpoints)
      .values({
        id: randomUUID(),
        workspaceId,
        extensionId,
        sessionName,
        encryptedValue,
        lastUsedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.extensionBrowserCheckpoints.workspaceId,
          schema.extensionBrowserCheckpoints.extensionId,
          schema.extensionBrowserCheckpoints.sessionName,
        ],
        set: { encryptedValue, lastUsedAt: now, updatedAt: now },
      })
      .run();
  }

  remove(workspaceId: string, extensionId: string, sessionName: string): boolean {
    const result = this.db
      .delete(schema.extensionBrowserCheckpoints)
      .where(and(
        eq(schema.extensionBrowserCheckpoints.workspaceId, workspaceId),
        eq(schema.extensionBrowserCheckpoints.extensionId, extensionId),
        eq(schema.extensionBrowserCheckpoints.sessionName, sessionName),
      ))
      .run();
    return (result.changes ?? 0) > 0;
  }

  removeExtension(workspaceId: string, extensionId: string): number {
    const result = this.db
      .delete(schema.extensionBrowserCheckpoints)
      .where(and(
        eq(schema.extensionBrowserCheckpoints.workspaceId, workspaceId),
        eq(schema.extensionBrowserCheckpoints.extensionId, extensionId),
      ))
      .run();
    return result.changes ?? 0;
  }

  count(workspaceId?: string): number {
    const rows = workspaceId
      ? this.db.select({ id: schema.extensionBrowserCheckpoints.id })
        .from(schema.extensionBrowserCheckpoints)
        .where(eq(schema.extensionBrowserCheckpoints.workspaceId, workspaceId)).all()
      : this.db.select({ id: schema.extensionBrowserCheckpoints.id })
        .from(schema.extensionBrowserCheckpoints).all();
    return rows.length;
  }
}
