/**
 * WorkspaceMediaConfigService — per-workspace media-generation model overrides
 * (INTEGRATION-CEILING-10X §1).
 *
 * Mirrors WorkspaceModelConfigService exactly, but keyed by media MODALITY
 * ('image' today; 'audio'/'video' slot in later) instead of a chat cognition
 * role — media generation gets the same "bring your own model/endpoint, no
 * restart" treatment chat models already had. A row stores `{ baseUrl?, model,
 * apiKey? }`; missing baseUrl/apiKey inherit the env default for that modality
 * (merge happens in MediaService). API keys are vault-encrypted at rest and
 * never returned.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CredentialVault } from '../credentialVault.js';
import type { Logger } from '../../logger.js';
import type { MediaModality } from '@agentis/core';

/** Public projection — never exposes the API key, only whether one is set. */
export interface PublicMediaModalityConfig {
  modality: MediaModality;
  baseUrl: string | null;
  model: string;
  hasApiKey: boolean;
  updatedAt: string;
}

/** A per-workspace override as MediaService consumes it (baseUrl/apiKey optional). */
export interface MediaModalityOverride {
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export class WorkspaceMediaConfigService {
  constructor(private readonly deps: { db: AgentisSqliteDb; vault: CredentialVault; logger?: Logger }) {}

  /** All modality overrides for a workspace, key-redacted for API responses. */
  list(workspaceId: string): PublicMediaModalityConfig[] {
    return this.deps.db
      .select()
      .from(schema.workspaceMediaConfig)
      .where(eq(schema.workspaceMediaConfig.workspaceId, workspaceId))
      .all()
      .map((r) => ({
        modality: r.modality as MediaModality,
        baseUrl: r.baseUrl ?? null,
        model: r.model,
        hasApiKey: Boolean(r.apiKeyEncrypted),
        updatedAt: r.updatedAt,
      }));
  }

  /** Upsert a modality override. Omitting apiKey keeps the existing one. */
  set(args: {
    workspaceId: string;
    modality: MediaModality;
    model: string;
    baseUrl?: string | null;
    apiKey?: string | null;
  }): PublicMediaModalityConfig {
    const existing = this.#row(args.workspaceId, args.modality);
    // apiKey: undefined → keep, null/'' → clear, string → set (encrypted).
    let apiKeyEncrypted: string | null | undefined;
    if (args.apiKey === undefined) apiKeyEncrypted = existing?.apiKeyEncrypted ?? null;
    else if (args.apiKey) apiKeyEncrypted = this.deps.vault.encrypt(args.apiKey);
    else apiKeyEncrypted = null;

    const now = new Date().toISOString();
    if (existing) {
      this.deps.db
        .update(schema.workspaceMediaConfig)
        .set({ model: args.model, baseUrl: args.baseUrl ?? null, apiKeyEncrypted, updatedAt: now })
        .where(eq(schema.workspaceMediaConfig.id, existing.id))
        .run();
    } else {
      this.deps.db
        .insert(schema.workspaceMediaConfig)
        .values({
          id: randomUUID(),
          workspaceId: args.workspaceId,
          modality: args.modality,
          model: args.model,
          baseUrl: args.baseUrl ?? null,
          apiKeyEncrypted: apiKeyEncrypted ?? null,
          updatedAt: now,
        })
        .run();
    }
    return {
      modality: args.modality,
      baseUrl: args.baseUrl ?? null,
      model: args.model,
      hasApiKey: Boolean(apiKeyEncrypted),
      updatedAt: now,
    };
  }

  /** Remove a modality override (revert to the env default / no provider). */
  clear(workspaceId: string, modality: MediaModality): void {
    this.deps.db
      .delete(schema.workspaceMediaConfig)
      .where(and(
        eq(schema.workspaceMediaConfig.workspaceId, workspaceId),
        eq(schema.workspaceMediaConfig.modality, modality),
      ))
      .run();
  }

  /**
   * Resolve a workspace override for MediaService. Returns the stored model
   * plus any baseUrl/apiKey (decrypted); the caller merges missing fields from
   * the env default. Returns null when no override exists. Never throws.
   */
  resolveOverride(workspaceId: string, modality: MediaModality): MediaModalityOverride | null {
    try {
      const row = this.#row(workspaceId, modality);
      if (!row?.model) return null;
      const override: MediaModalityOverride = { model: row.model };
      if (row.baseUrl) override.baseUrl = row.baseUrl;
      if (row.apiKeyEncrypted) override.apiKey = this.deps.vault.decrypt(row.apiKeyEncrypted);
      return override;
    } catch (err) {
      this.deps.logger?.warn?.('workspace_media_config.resolve_failed', { workspaceId, modality, err: (err as Error).message });
      return null;
    }
  }

  #row(workspaceId: string, modality: string) {
    return this.deps.db
      .select()
      .from(schema.workspaceMediaConfig)
      .where(and(
        eq(schema.workspaceMediaConfig.workspaceId, workspaceId),
        eq(schema.workspaceMediaConfig.modality, modality),
      ))
      .get();
  }
}
