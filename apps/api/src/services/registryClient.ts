/**
 * RegistryClient — anonymous read-only client for a third-party
 * extension registry (V1-SPEC §8).
 *
 * The client speaks a minimal HTTP contract that any registry provider can
 * implement:
 *
 *   - `GET {base}/search?q=...`
 *       → `{ results: Array<{ slug, name, description, author, version, hash }> }`
 *
 *   - `GET {base}/extensions/{slug}/content`
 *       → `{ content: string, hash?: string, sha256?: string }`
 *         (also accepted: raw text body when `content-type` is not JSON)
 *
 * Responses are translated into the `RegistryEntry` shape so the rest of the
 * application stays registry-source-agnostic.
 *
 * When `registryUrl` is unset or upstream is unreachable, every method
 * throws `EXTENSION_REGISTRY_UNAVAILABLE` so the dashboard can render an
 * "offline" state without surprising the operator. A `CircuitBreaker`
 * short-circuits repeated failures.
 */

import { AgentisError, type RegistryEntry } from '@agentis/core';
import type { Logger } from '../logger.js';
import { CircuitBreaker } from '../adapters/CircuitBreaker.js';

export interface RegistryClientOptions {
  /** Base URL of the upstream registry API (e.g. `https://example.com/api`). */
  registryUrl?: string;
  timeoutMs: number;
  logger: Logger;
}

export interface RegistryPage {
  entries: RegistryEntry[];
  cursor?: string;
}

interface RawSearchHit {
  slug: string;
  name?: string;
  title?: string;
  description?: string;
  summary?: string;
  author?: string | { username?: string; displayName?: string };
  version?: string;
  hash?: string;
  sha256?: string;
  type?: string;
}

interface RawContentResponse {
  content: string;
  hash?: string;
  sha256?: string;
}

export class RegistryClient {
  readonly #breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });

  constructor(private readonly opts: RegistryClientOptions) {}

  isConfigured(): boolean {
    return !!this.opts.registryUrl;
  }

  breakerState() {
    return this.#breaker.state();
  }

  /**
   * Search the upstream registry. Empty `q` returns the upstream's default
   * (typically the most recent or featured entries).
   */
  async search(args: { q?: string; cursor?: string; pageSize?: number }): Promise<RegistryPage> {
    const params = new URLSearchParams();
    if (args.q) params.set('q', args.q);
    if (args.cursor) params.set('cursor', args.cursor);
    if (args.pageSize) params.set('pageSize', String(args.pageSize));
    const qs = params.toString();
    const data = await this.#request<{
      results?: RawSearchHit[];
      extensions?: RawSearchHit[];
      cursor?: string;
    }>('GET', `/search${qs ? `?${qs}` : ''}`);
    const rows = data.results ?? data.extensions ?? [];
    const entries = rows.map((r) => this.#translateEntry(r));
    return { entries, ...(data.cursor ? { cursor: data.cursor } : {}) };
  }

  /**
   * Fetch a single entry by slug. Re-uses the search endpoint with an
   * exact-match query because the anonymous registry contract does not
   * expose a dedicated entry endpoint.
   */
  async getEntry(args: { slug: string }): Promise<RegistryEntry> {
    const page = await this.search({ q: args.slug });
    const hit = page.entries.find((e) => e.slug === args.slug) ?? page.entries[0];
    if (!hit) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `registry entry ${args.slug} not found`);
    }
    return hit;
  }

  /**
   * Fetch artifact bytes for a given slug. Returns the raw buffer so the
   * install route can hash + scan it before persisting any local state.
   */
  async fetchArtifactBytes(args: { slug: string }): Promise<{ bytes: Buffer; declaredSha256?: string }> {
    const path = `/extensions/${encodeURIComponent(args.slug)}/content`;
    const url = this.#absoluteUrl(path);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.timeoutMs).unref?.();
    try {
      return await this.#breaker.exec(async () => {
        const res = await fetch(url, {
          method: 'GET',
          headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' },
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 404) {
            throw new AgentisError('RESOURCE_NOT_FOUND', `registry content ${args.slug} not found`);
          }
          throw new AgentisError(
            'EXTENSION_REGISTRY_UNAVAILABLE',
            `registry returned ${res.status} for ${path}`,
          );
        }
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) {
          const body = (await res.json()) as RawContentResponse;
          const bytes = Buffer.from(body.content ?? '', 'utf8');
          const declared = body.sha256 ?? body.hash;
          return declared ? { bytes, declaredSha256: declared } : { bytes };
        }
        const text = await res.text();
        return { bytes: Buffer.from(text, 'utf8') };
      });
    } catch (err) {
      if (err instanceof AgentisError) throw err;
      throw new AgentisError(
        'EXTENSION_REGISTRY_UNAVAILABLE',
        `registry request failed: ${(err as Error).message}`,
      );
    } finally {
      if (t) clearTimeout(t);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  #absoluteUrl(path: string): string {
    if (!this.opts.registryUrl) {
      throw new AgentisError(
        'EXTENSION_REGISTRY_UNAVAILABLE',
        'Registry URL not configured (set AGENTIS_EXTENSION_REGISTRY_URL).',
      );
    }
    return `${this.opts.registryUrl.replace(/\/$/, '')}${path}`;
  }

  #translateEntry(raw: RawSearchHit): RegistryEntry {
    const author =
      typeof raw.author === 'string'
        ? { username: raw.author, displayName: raw.author }
        : {
            username: raw.author?.username ?? 'unknown',
            displayName: raw.author?.displayName ?? raw.author?.username ?? 'unknown',
          };
    const sha256 = raw.sha256 ?? raw.hash ?? '';
    const slug = raw.slug;
    return {
      entryId: slug,
      entryType: this.#mapEntryType(raw.type),
      slug,
      title: raw.title ?? raw.name ?? slug,
      summary: raw.summary ?? raw.description ?? '',
      version: raw.version ?? '0.0.0',
      author,
      artifacts: [
        {
          artifactType: 'extension_bundle',
          sha256,
          downloadUrl: this.#absoluteUrl(`/extensions/${encodeURIComponent(slug)}/content`),
        },
      ],
    };
  }

  #mapEntryType(raw: string | undefined): RegistryEntry['entryType'] {
    switch (raw) {
      case 'workflow':
      case 'workflow_template':
      case 'agent_package':
      case 'extension':
        return raw;
      default:
        return 'extension';
    }
  }

  async #request<T>(method: 'GET', path: string): Promise<T> {
    const url = this.#absoluteUrl(path);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.timeoutMs).unref?.();
    try {
      return await this.#breaker.exec(async () => {
        const res = await fetch(url, {
          method,
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 404) {
            throw new AgentisError('RESOURCE_NOT_FOUND', `registry: ${path}`);
          }
          throw new AgentisError(
            'EXTENSION_REGISTRY_UNAVAILABLE',
            `registry returned ${res.status} for ${path}`,
          );
        }
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      });
    } catch (err) {
      if (err instanceof AgentisError) throw err;
      throw new AgentisError(
        'EXTENSION_REGISTRY_UNAVAILABLE',
        `registry request failed: ${(err as Error).message}`,
      );
    } finally {
      if (t) clearTimeout(t);
    }
  }
}
