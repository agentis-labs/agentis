/**
 * EmbeddingProviderRegistry — Brain 10x §B1.1.
 *
 * ONE owner of "which embedding provider does this workspace use." Before this,
 * the same DB-backed resolution (read `embedding_provider_type` / `_config`,
 * `selectEmbeddingProvider`, cache, invalidate) was copy-pasted into
 * SharedIntelligence, ReflectionService, PeerProfileService, KnowledgeBase, and
 * the abilities path — and, fatally, the episodic/personal/session/agent memory
 * stores skipped it entirely and hard-wired `new HashingEmbeddingProvider()`.
 * That is the root cause of "semantic recall is lexical in every config":
 * writes embedded with hashing could never match a semantic query vector.
 *
 * The registry is constructed ONCE, early in bootstrap (before any store), and
 * every store + service resolves through it. A store embeds writes with the same
 * provider the query path uses — so vectors are comparable by construction.
 *
 * It is intentionally tiny and dependency-light (db + logger): no model calls,
 * no graph, no formation. Just provider identity resolution + cache.
 */

import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import { selectEmbeddingProvider, type EmbeddingProvider } from './embeddingProvider.js';

/** A resolver closure — what stores accept so they never own provider logic. */
export type EmbeddingProviderResolver = (workspaceId: string) => EmbeddingProvider;

export class EmbeddingProviderRegistry {
  readonly #cache = new Map<string, EmbeddingProvider>();

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  /** Resolve (and cache) the provider for a workspace from its config columns. */
  resolve(workspaceId: string): EmbeddingProvider {
    const cached = this.#cache.get(workspaceId);
    if (cached) return cached;

    let type = 'local';
    let config: Record<string, unknown> = {};
    try {
      const row = this.db
        .select({
          type: schema.workspaces.embeddingProviderType,
          config: schema.workspaces.embeddingProviderConfig,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .get();
      if (row?.type) type = row.type;
      config = parseRecord(row?.config);
    } catch (err) {
      // Column may not exist on very old DBs — fall back to the default provider, never throw.
      this.logger.warn('embedding_registry.resolve_failed', {
        workspaceId,
        message: (err as Error).message,
      });
    }

    const provider = selectEmbeddingProvider(type, config);
    this.#cache.set(workspaceId, provider);
    return provider;
  }

  /** Drop a cached provider after the operator changes workspace config. */
  invalidate(workspaceId: string): void {
    this.#cache.delete(workspaceId);
  }

  /** A bound resolver closure — pass this to stores so they never read config. */
  resolver(): EmbeddingProviderResolver {
    return (workspaceId: string) => this.resolve(workspaceId);
  }
}

function parseRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
