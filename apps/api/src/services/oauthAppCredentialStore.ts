/**
 * OAuthAppCredentialStore — BYOC OAuth app credentials (client id/secret per
 * provider), persisted so an operator can paste them into Settings →
 * Integrations instead of editing OAUTH_<PROVIDER>_CLIENT_ID/SECRET env vars
 * and restarting the process.
 *
 * Instance-wide, not workspace-scoped (see schema.oauthAppCredentials): the
 * OAuth redirect URI registered with the provider is fixed per deployment
 * (AGENTIS_PUBLIC_URL), not per workspace. Every authenticated user is
 * already treated as the instance operator elsewhere in this codebase (no
 * admin/role system exists), so this store follows the same assumption.
 */

import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import type { CredentialVault } from './credentialVault.js';
import type { OAuthProviderId } from './oauthService.js';

export interface OAuthAppCredential {
  clientId: string;
  clientSecret: string;
}

export class OAuthAppCredentialStore {
  constructor(private readonly db: AgentisSqliteDb, private readonly vault: CredentialVault) {}

  get(provider: OAuthProviderId): OAuthAppCredential | null {
    const row = this.db.select().from(schema.oauthAppCredentials)
      .where(eq(schema.oauthAppCredentials.provider, provider)).get();
    if (!row) return null;
    return JSON.parse(this.vault.decrypt(row.encryptedValue)) as OAuthAppCredential;
  }

  /** provider → whether a credential is stored (never returns secrets). */
  list(): Partial<Record<OAuthProviderId, true>> {
    const rows = this.db.select({ provider: schema.oauthAppCredentials.provider }).from(schema.oauthAppCredentials).all();
    const present: Partial<Record<OAuthProviderId, true>> = {};
    for (const row of rows) present[row.provider as OAuthProviderId] = true;
    return present;
  }

  set(provider: OAuthProviderId, credential: OAuthAppCredential): void {
    const encryptedValue = this.vault.encrypt(JSON.stringify(credential));
    const now = new Date().toISOString();
    this.db.insert(schema.oauthAppCredentials)
      .values({ provider, encryptedValue, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: schema.oauthAppCredentials.provider, set: { encryptedValue, updatedAt: now } })
      .run();
  }

  delete(provider: OAuthProviderId): void {
    this.db.delete(schema.oauthAppCredentials).where(eq(schema.oauthAppCredentials.provider, provider)).run();
  }
}
