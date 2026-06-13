/**
 * PlatformModelService — zero-config model derivation.
 *
 * The autonomy runtime (agent sessions, the evaluation/judge runtime, the
 * bounded tool loop) needs an OpenAI-compatible chat model. Historically that
 * required `AGENTIS_EVALUATOR_*` in `.env`, and without it every `agent_task`
 * silently degraded to a single-shot completion.
 *
 * We never want to ask an operator to hand-edit `.env`. The model can come from,
 * in precedence order (resolved by {@link OrchestratorModelRouter}):
 *   1. the per-workspace model-config page (WorkspaceModelConfigService)
 *   2. environment variables (legacy deployments)
 *   3. **the first agent runtime the operator connected** — derived here.
 *
 * This service implements (3): it scans the workspace's `http` agents (the only
 * adapter type that exposes a reusable OpenAI-compatible endpoint) and returns
 * the first one's `{ baseUrl, model, apiKey }` as a platform default. So a user
 * who connects one HTTP/LLM agent gets a working autonomy brain for free, no
 * env, no extra setup. CLI harness agents (Codex/Claude Code) are skipped — their
 * "model" is a CLI name, not an endpoint Agentis can call directly.
 *
 * Results are cached briefly per workspace so the hot dispatch path never pays a
 * DB read per step; the cache self-expires so connecting an agent takes effect
 * within seconds without a restart.
 */

import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CredentialVault } from './credentialVault.js';
import type { Logger } from './../logger.js';
import type { ModelProfile } from './orchestratorModelRouter.js';

const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  profile: ModelProfile | null;
  expiresAt: number;
}

export class PlatformModelService {
  readonly #cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: { db: AgentisSqliteDb; vault: CredentialVault; logger?: Logger }) {}

  /**
   * Derive a platform model profile from the first usable agent runtime in the
   * workspace (or, when no workspace is given, anywhere). Returns null when no
   * agent exposes a reusable model endpoint. Cached for a few seconds.
   */
  deriveProfile(workspaceId?: string): ModelProfile | null {
    const key = workspaceId ?? '*';
    const cached = this.#cache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.profile;
    let profile: ModelProfile | null = null;
    try {
      profile = this.#derive(workspaceId);
    } catch (err) {
      this.deps.logger?.warn?.('platform_model.derive_failed', { workspaceId, err: (err as Error).message });
      profile = null;
    }
    this.#cache.set(key, { profile, expiresAt: now + CACHE_TTL_MS });
    return profile;
  }

  /** Drop cached derivations (call after an agent is created/edited/removed). */
  invalidate(workspaceId?: string): void {
    if (workspaceId) {
      this.#cache.delete(workspaceId);
      this.#cache.delete('*');
    } else {
      this.#cache.clear();
    }
  }

  #derive(workspaceId?: string): ModelProfile | null {
    const rows = (workspaceId
      ? this.deps.db.select().from(schema.agents).where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.adapterType, 'http'))).all()
      : this.deps.db.select().from(schema.agents).where(eq(schema.agents.adapterType, 'http')).all());
    // Prefer an online agent, but accept any reachable config.
    const ordered = [...rows].sort((a, b) => Number(b.status === 'online') - Number(a.status === 'online'));
    for (const agent of ordered) {
      const config = this.#parseConfig(agent.config);
      if (!config) continue;
      const baseUrl = stringField(config.baseUrl);
      const model = stringField(config.model) ?? stringField(agent.runtimeModel);
      if (!baseUrl || !model) continue;
      const apiKey = this.#resolveApiKey(workspaceId ?? agent.workspaceId, config);
      this.deps.logger?.info?.('platform_model.derived_from_agent', { agentId: agent.id, model });
      return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
    }
    return null;
  }

  #resolveApiKey(workspaceId: string, config: Record<string, unknown>): string | undefined {
    const credentialId = stringField(config.authCredentialId) ?? stringField(config.sharedSecretCredentialId);
    if (credentialId) {
      try {
        const cred = this.deps.db
          .select()
          .from(schema.credentials)
          .where(and(eq(schema.credentials.id, credentialId), eq(schema.credentials.workspaceId, workspaceId)))
          .get();
        if (cred?.encryptedValue) return this.deps.vault.decrypt(cred.encryptedValue);
      } catch (err) {
        this.deps.logger?.warn?.('platform_model.credential_decrypt_failed', { workspaceId, err: (err as Error).message });
      }
    }
    return stringField(config.authToken) ?? undefined;
  }

  #parseConfig(raw: unknown): Record<string, unknown> | null {
    try {
      if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
      if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
    return null;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
