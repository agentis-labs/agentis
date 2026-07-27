/**
 * CustomOAuthProviderService — CRUD for user-configured "bring your own OAuth
 * app" providers (INTEGRATION-CEILING-10X §2). A workspace can register a
 * fully custom OAuth2 app (any authUrl/tokenUrl/scopes/client credentials) for
 * a service Agentis-core has never heard of — the same generic flow mechanics
 * (oauthFlow.ts) that back the built-in provider list, just data instead of code.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError } from '@agentis/core';
import type { CredentialVault } from './credentialVault.js';
import type { GenericOAuthProviderDef, OAuthClientCreds } from './oauthFlow.js';

export interface CustomOAuthProviderDef extends GenericOAuthProviderDef, OAuthClientCreds {
  providerId: string;
  label: string;
  scopes: string[];
}

/** Public projection — never exposes the client secret, only whether one is set. */
export interface PublicCustomOAuthProvider {
  providerId: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  scopeSeparator: ' ' | ',';
  pkce: boolean;
  tokenAuth: 'body' | 'basic';
  tokenBodyFormat: 'form' | 'json';
  clientId: string;
  hasClientSecret: boolean;
  updatedAt: string;
}

export interface SetCustomOAuthProviderArgs {
  workspaceId: string;
  providerId: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes?: string[];
  scopeSeparator?: ' ' | ',';
  pkce?: boolean;
  tokenAuth?: 'body' | 'basic';
  tokenBodyFormat?: 'form' | 'json';
  clientId: string;
  /** Omit to keep the existing secret when updating; required on first create. */
  clientSecret?: string;
}

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export class CustomOAuthProviderService {
  constructor(private readonly deps: { db: AgentisSqliteDb; vault: CredentialVault }) {}

  list(workspaceId: string): PublicCustomOAuthProvider[] {
    return this.deps.db
      .select()
      .from(schema.oauthCustomProviders)
      .where(eq(schema.oauthCustomProviders.workspaceId, workspaceId))
      .all()
      .map((r) => this.#toPublic(r));
  }

  /** Full definition (decrypted secret) for the authorize/callback flow. Returns null if not found. */
  get(workspaceId: string, providerId: string): CustomOAuthProviderDef | null {
    const row = this.#row(workspaceId, providerId);
    if (!row) return null;
    return {
      providerId: row.providerId,
      label: row.label,
      authUrl: row.authUrl,
      tokenUrl: row.tokenUrl,
      scopes: parseScopes(row.scopes),
      scopeSeparator: row.scopeSeparator as ' ' | ',',
      pkce: row.pkce,
      tokenAuth: row.tokenAuth as 'body' | 'basic',
      tokenBodyFormat: row.tokenBodyFormat as 'form' | 'json',
      clientId: row.clientId,
      clientSecret: this.deps.vault.decrypt(row.clientSecretEncrypted),
    };
  }

  set(args: SetCustomOAuthProviderArgs): PublicCustomOAuthProvider {
    const providerId = args.providerId.trim().toLowerCase();
    if (!PROVIDER_ID_RE.test(providerId)) {
      throw new AgentisError('VALIDATION_FAILED', 'providerId must be lowercase letters/digits/hyphen/underscore, 2-64 chars');
    }
    try {
      new URL(args.authUrl);
      new URL(args.tokenUrl);
    } catch {
      throw new AgentisError('VALIDATION_FAILED', 'authUrl and tokenUrl must be valid URLs');
    }
    const existing = this.#row(args.workspaceId, providerId);
    let clientSecretEncrypted: string;
    if (args.clientSecret) clientSecretEncrypted = this.deps.vault.encrypt(args.clientSecret);
    else if (existing?.clientSecretEncrypted) clientSecretEncrypted = existing.clientSecretEncrypted;
    else throw new AgentisError('VALIDATION_FAILED', 'clientSecret is required when creating a new custom provider');

    const now = new Date().toISOString();
    const row = {
      label: args.label.trim(),
      authUrl: args.authUrl.trim(),
      tokenUrl: args.tokenUrl.trim(),
      scopes: JSON.stringify(args.scopes ?? []),
      scopeSeparator: args.scopeSeparator ?? ' ',
      pkce: args.pkce ?? false,
      tokenAuth: args.tokenAuth ?? 'body',
      tokenBodyFormat: args.tokenBodyFormat ?? 'form',
      clientId: args.clientId.trim(),
      clientSecretEncrypted,
      updatedAt: now,
    };
    if (existing) {
      this.deps.db.update(schema.oauthCustomProviders).set(row).where(eq(schema.oauthCustomProviders.id, existing.id)).run();
    } else {
      this.deps.db.insert(schema.oauthCustomProviders).values({
        id: randomUUID(),
        workspaceId: args.workspaceId,
        providerId,
        createdAt: now,
        ...row,
      }).run();
    }
    return this.#toPublic({ ...row, providerId });
  }

  delete(workspaceId: string, providerId: string): void {
    this.deps.db
      .delete(schema.oauthCustomProviders)
      .where(and(eq(schema.oauthCustomProviders.workspaceId, workspaceId), eq(schema.oauthCustomProviders.providerId, providerId)))
      .run();
  }

  #row(workspaceId: string, providerId: string) {
    return this.deps.db
      .select()
      .from(schema.oauthCustomProviders)
      .where(and(eq(schema.oauthCustomProviders.workspaceId, workspaceId), eq(schema.oauthCustomProviders.providerId, providerId)))
      .get();
  }

  #toPublic(row: {
    providerId: string; label: string; authUrl: string; tokenUrl: string; scopes: string;
    scopeSeparator: string; pkce: boolean; tokenAuth: string; tokenBodyFormat: string;
    clientId: string; clientSecretEncrypted?: string; updatedAt: string;
  }): PublicCustomOAuthProvider {
    return {
      providerId: row.providerId,
      label: row.label,
      authUrl: row.authUrl,
      tokenUrl: row.tokenUrl,
      scopes: parseScopes(row.scopes),
      scopeSeparator: row.scopeSeparator as ' ' | ',',
      pkce: row.pkce,
      tokenAuth: row.tokenAuth as 'body' | 'basic',
      tokenBodyFormat: row.tokenBodyFormat as 'form' | 'json',
      clientId: row.clientId,
      hasClientSecret: Boolean(row.clientSecretEncrypted),
      updatedAt: row.updatedAt,
    };
  }
}

function parseScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
