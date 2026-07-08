/**
 * WorkspaceModelConfigService — per-workspace orchestrator model-role overrides
 * (OMNICHANNEL-ORCHESTRATOR-10X §4.4).
 *
 * The OrchestratorModelRouter resolves a model per cognition role from the
 * environment. This service lets an operator override any role *per workspace*
 * from the UI — e.g. "use claude-opus-4-8 for conversation in this workspace" —
 * without redeploying. A row stores `{ baseUrl?, model, apiKey? }`; missing
 * baseUrl/apiKey inherit the env default for that role (merge happens in the
 * router). API keys are vault-encrypted at rest and never returned.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CredentialVault } from '../credentialVault.js';
import type { Logger } from '../../logger.js';
import {
  ORCHESTRATOR_MODEL_ROLES,
  type OrchestratorModelRole,
  type ModelProfile,
} from '../orchestrator/orchestratorModelRouter.js';

/** Public projection — never exposes the API key, only whether one is set. */
export interface PublicModelRoleConfig {
  role: OrchestratorModelRole;
  baseUrl: string | null;
  model: string;
  hasApiKey: boolean;
  updatedAt: string;
}

/** A per-workspace override as the router consumes it (baseUrl/apiKey optional). */
export interface ModelRoleOverride {
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

function isRole(value: string): value is OrchestratorModelRole {
  return (ORCHESTRATOR_MODEL_ROLES as readonly string[]).includes(value);
}

export class WorkspaceModelConfigService {
  constructor(private readonly deps: { db: AgentisSqliteDb; vault: CredentialVault; logger?: Logger }) {}

  /** All role overrides for a workspace, key-redacted for API responses. */
  list(workspaceId: string): PublicModelRoleConfig[] {
    return this.deps.db
      .select()
      .from(schema.workspaceModelConfig)
      .where(eq(schema.workspaceModelConfig.workspaceId, workspaceId))
      .all()
      .filter((r) => isRole(r.role))
      .map((r) => ({
        role: r.role as OrchestratorModelRole,
        baseUrl: r.baseUrl ?? null,
        model: r.model,
        hasApiKey: Boolean(r.apiKeyEncrypted),
        updatedAt: r.updatedAt,
      }));
  }

  /** Upsert a role override. Omitting apiKey keeps the existing one. */
  set(args: {
    workspaceId: string;
    role: OrchestratorModelRole;
    model: string;
    baseUrl?: string | null;
    apiKey?: string | null;
  }): PublicModelRoleConfig {
    const existing = this.#row(args.workspaceId, args.role);
    // apiKey: undefined → keep, null/'' → clear, string → set (encrypted).
    let apiKeyEncrypted: string | null | undefined;
    if (args.apiKey === undefined) apiKeyEncrypted = existing?.apiKeyEncrypted ?? null;
    else if (args.apiKey) apiKeyEncrypted = this.deps.vault.encrypt(args.apiKey);
    else apiKeyEncrypted = null;

    const now = new Date().toISOString();
    if (existing) {
      this.deps.db
        .update(schema.workspaceModelConfig)
        .set({ model: args.model, baseUrl: args.baseUrl ?? null, apiKeyEncrypted, updatedAt: now })
        .where(eq(schema.workspaceModelConfig.id, existing.id))
        .run();
    } else {
      this.deps.db
        .insert(schema.workspaceModelConfig)
        .values({
          id: randomUUID(),
          workspaceId: args.workspaceId,
          role: args.role,
          model: args.model,
          baseUrl: args.baseUrl ?? null,
          apiKeyEncrypted: apiKeyEncrypted ?? null,
          updatedAt: now,
        })
        .run();
    }
    return {
      role: args.role,
      baseUrl: args.baseUrl ?? null,
      model: args.model,
      hasApiKey: Boolean(apiKeyEncrypted),
      updatedAt: now,
    };
  }

  /** Remove a role override (revert to the env default). */
  clear(workspaceId: string, role: OrchestratorModelRole): void {
    this.deps.db
      .delete(schema.workspaceModelConfig)
      .where(and(
        eq(schema.workspaceModelConfig.workspaceId, workspaceId),
        eq(schema.workspaceModelConfig.role, role),
      ))
      .run();
  }

  /**
   * Resolve a workspace override for the router. Returns the stored model plus
   * any baseUrl/apiKey (decrypted); the router merges missing fields from the
   * env default. Returns null when no override exists. Never throws.
   */
  resolveOverride(workspaceId: string, role: OrchestratorModelRole): ModelRoleOverride | null {
    try {
      const row = this.#row(workspaceId, role);
      if (!row?.model) return null;
      const override: ModelRoleOverride = { model: row.model };
      if (row.baseUrl) override.baseUrl = row.baseUrl;
      if (row.apiKeyEncrypted) override.apiKey = this.deps.vault.decrypt(row.apiKeyEncrypted);
      return override;
    } catch (err) {
      this.deps.logger?.warn?.('workspace_model_config.resolve_failed', { workspaceId, role, err: (err as Error).message });
      return null;
    }
  }

  /** Bind to the router's configProvider shape (returns a full-ish ModelProfile). */
  asConfigProvider(): (workspaceId: string, role: OrchestratorModelRole) => Partial<ModelProfile> | null {
    return (workspaceId, role) => {
      const override = this.resolveOverride(workspaceId, role);
      if (!override) return null;
      const profile: Partial<ModelProfile> = { model: override.model };
      if (override.baseUrl) profile.baseUrl = override.baseUrl;
      if (override.apiKey) profile.apiKey = override.apiKey;
      return profile;
    };
  }

  #row(workspaceId: string, role: string) {
    return this.deps.db
      .select()
      .from(schema.workspaceModelConfig)
      .where(and(
        eq(schema.workspaceModelConfig.workspaceId, workspaceId),
        eq(schema.workspaceModelConfig.role, role),
      ))
      .get();
  }
}
