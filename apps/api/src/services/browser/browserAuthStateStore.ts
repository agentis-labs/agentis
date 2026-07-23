/**
 * BrowserAuthStateStore — encrypted, workspace-scoped persistence for browser
 * session auth state ("log in once, reuse across runs", BROWSERPOOL-10X §Auth).
 *
 * A Playwright `storageState` is cookies + localStorage — credential-equivalent —
 * so it is AES-256-GCM encrypted via the existing {@link CredentialVault} before
 * it touches disk, exactly like WhatsApp device creds
 * (adapters/channels/whatsappVaultAuthState.ts). Rows live in `browser_auth_states`
 * keyed uniquely by (workspace_id, name); scoping is enforced in every query so
 * workspace A can never load B's profile.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CredentialVault } from '../credentialVault.js';
import type { PWStorageState } from '../browserPool.js';
import type { BrowserAuthStore } from './browserSessionManager.js';

export class BrowserAuthStateStore implements BrowserAuthStore {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly vault: CredentialVault,
  ) {}

  async load(workspaceId: string, name: string): Promise<PWStorageState | null> {
    const row = this.db
      .select({ value: schema.browserAuthStates.encryptedValue })
      .from(schema.browserAuthStates)
      .where(and(eq(schema.browserAuthStates.workspaceId, workspaceId), eq(schema.browserAuthStates.name, name)))
      .get();
    if (!row) return null;
    try {
      return JSON.parse(this.vault.decrypt(row.value)) as PWStorageState;
    } catch {
      // Tamper/decrypt failure → treat as absent rather than crash the session open.
      return null;
    }
  }

  async save(workspaceId: string, userId: string | null, name: string, state: PWStorageState): Promise<void> {
    const encrypted = this.vault.encrypt(JSON.stringify(state));
    const now = new Date().toISOString();
    this.db
      .insert(schema.browserAuthStates)
      .values({ id: randomUUID(), workspaceId, userId, name, encryptedValue: encrypted, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.browserAuthStates.workspaceId, schema.browserAuthStates.name],
        set: { userId, encryptedValue: encrypted, updatedAt: now },
      })
      .run();
  }

  /** Remove a saved profile (workspace-scoped). Returns true if a row was deleted. */
  async remove(workspaceId: string, name: string): Promise<boolean> {
    const res = this.db
      .delete(schema.browserAuthStates)
      .where(and(eq(schema.browserAuthStates.workspaceId, workspaceId), eq(schema.browserAuthStates.name, name)))
      .run();
    return (res.changes ?? 0) > 0;
  }
}
