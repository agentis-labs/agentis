/**
 * GitHub KnowledgeSource — repositories, issues, and pull requests (RFC §7.6
 * "engineering" family).
 *
 * Included scopes are `owner/repo` slugs; with none, the token's accessible
 * repos sync (capped). Issues + PRs carry delivery-process and decision
 * evidence; repo metadata maps the system landscape. Cursor = newest
 * `updated_at` seen (the /issues?since= contract). Boundary:
 * private_external / internal — code-adjacent text is rarely customer-safe.
 */

import type {
  BackfillRequest,
  CanonicalSourceObject,
  DiscoveredSourceScope,
  IncrementalSyncRequest,
  InformationBoundary,
  KnowledgeSource,
  SourceCapabilities,
  SourceChangeBatch,
  SourceConnectionHealth,
  SourceSyncContext,
} from '../types.js';

const GITHUB_BOUNDARY: InformationBoundary = {
  origin: 'private_external',
  confidentiality: 'internal',
  audience: 'delegated_agents',
  customerSafe: false,
  trainingAllowed: false,
  exportAllowed: false,
  policySource: 'source_acl',
};

const PER_PAGE = 100;
const MAX_REPOS = 20;
const MAX_BODY_CHARS = 8000;

interface GithubRepo { full_name: string; description?: string | null; html_url: string; private: boolean; pushed_at?: string; updated_at?: string; language?: string | null }
interface GithubIssue { number: number; title: string; body?: string | null; html_url: string; state: string; updated_at: string; created_at: string; user?: { login?: string }; pull_request?: unknown }

export class GitHubSource implements KnowledgeSource {
  readonly sourceType = 'github';
  readonly displayName = 'GitHub';
  readonly capabilities: SourceCapabilities = {
    supportsBackfill: true,
    supportsIncrementalCursor: true,
    supportsWebhooks: false,
    supportsDeletes: false,
    supportsAclSync: false,
    supportsIdentityDirectory: false,
    supportsAttachments: false,
    supportsHistory: true,
    consistency: 'eventual',
  };

  async validateConnection(ctx: SourceSyncContext): Promise<SourceConnectionHealth> {
    if (!ctx.accessToken) return { ok: false, detail: 'GitHub token missing — connect a credential.' };
    const res = await fetch('https://api.github.com/user', { headers: this.headers(ctx), signal: ctx.signal ?? null });
    return res.ok ? { ok: true } : { ok: false, detail: `GitHub /user HTTP ${res.status}` };
  }

  async discoverScopes(ctx: SourceSyncContext): Promise<DiscoveredSourceScope[]> {
    const repos = await this.listRepos(ctx);
    return repos.map((repo) => ({
      id: repo.full_name,
      label: repo.full_name,
      kind: repo.private ? 'private_repo' : 'public_repo',
      recommended: !repo.private,
    }));
  }

  async *backfill(request: BackfillRequest): AsyncIterable<SourceChangeBatch> {
    yield* this.crawl(request, null);
  }

  async *synchronize(request: IncrementalSyncRequest): AsyncIterable<SourceChangeBatch> {
    yield* this.crawl(request, request.cursor ?? null);
  }

  private async *crawl(ctx: SourceSyncContext, since: string | null): AsyncIterable<SourceChangeBatch> {
    const repos = ctx.includedScopes.length > 0
      ? ctx.includedScopes.filter((slug) => !ctx.excludedScopes.includes(slug))
      : (await this.listRepos(ctx)).map((repo) => repo.full_name).filter((slug) => !ctx.excludedScopes.includes(slug));
    let newest = since ?? '';

    for (const slug of repos.slice(0, MAX_REPOS)) {
      if (ctx.signal?.aborted) return;
      // Repo metadata — the system landscape node.
      const repo = await this.getJson<GithubRepo>(ctx, `https://api.github.com/repos/${slug}`).catch(() => null);
      const objects: CanonicalSourceObject[] = [];
      if (repo) {
        const modified = repo.pushed_at ?? repo.updated_at;
        if (modified && modified > newest) newest = modified;
        objects.push({
          externalId: `repo:${repo.full_name}`,
          objectType: 'repository',
          title: repo.full_name,
          nativeUrl: repo.html_url,
          modifiedAt: modified,
          observedAt: new Date().toISOString(),
          content: [
            `Repository ${repo.full_name}${repo.language ? ` (${repo.language})` : ''}.`,
            repo.description ?? '',
          ].filter(Boolean).join('\n'),
          attributes: { private: repo.private, language: repo.language },
          boundary: repo.private ? GITHUB_BOUNDARY : { ...GITHUB_BOUNDARY, origin: 'public_external', confidentiality: 'public' },
          // Public repos are world-readable (exact); private repo collaborator
          // lists are not enumerated on this token scope → partial fidelity.
          acl: repo.private
            ? { mode: 'explicit', allow: [], deny: [], fidelity: 'partial', capturedAt: new Date().toISOString() }
            : { mode: 'public', allow: [], deny: [], fidelity: 'exact', capturedAt: new Date().toISOString() },
        });
      }
      // Issues + PRs since cursor.
      let page = 1;
      let pageItems: GithubIssue[];
      do {
        const url = `https://api.github.com/repos/${slug}/issues?state=all&sort=updated&direction=asc&per_page=${PER_PAGE}&page=${page}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
        pageItems = await this.getJson<GithubIssue[]>(ctx, url).catch(() => []);
        for (const issue of pageItems) {
          if (issue.updated_at > newest) newest = issue.updated_at;
          const kind = issue.pull_request ? 'pull_request' : 'issue';
          objects.push({
            externalId: `${kind}:${slug}#${issue.number}`,
            externalVersionId: issue.updated_at,
            objectType: kind,
            title: `${slug}#${issue.number}: ${issue.title}`,
            nativeUrl: issue.html_url,
            authorExternalId: issue.user?.login,
            createdAt: issue.created_at,
            modifiedAt: issue.updated_at,
            observedAt: new Date().toISOString(),
            content: [
              `${kind === 'pull_request' ? 'PR' : 'Issue'} (${issue.state}): ${issue.title}`,
              (issue.body ?? '').slice(0, MAX_BODY_CHARS),
            ].filter(Boolean).join('\n'),
            attributes: { state: issue.state, repo: slug },
            boundary: GITHUB_BOUNDARY,
          });
        }
        page += 1;
      } while (pageItems.length === PER_PAGE && page <= 10);
      if (objects.length > 0) {
        yield { objects, deletions: [], cursor: newest || since };
      }
    }
    yield { objects: [], deletions: [], cursor: newest || since, done: true };
  }

  private async listRepos(ctx: SourceSyncContext): Promise<GithubRepo[]> {
    return await this.getJson<GithubRepo[]>(ctx,
      `https://api.github.com/user/repos?sort=pushed&per_page=${MAX_REPOS}`).catch(() => []);
  }

  private headers(ctx: SourceSyncContext): Record<string, string> {
    return {
      authorization: `Bearer ${ctx.accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'agentis-workspace-brain',
    };
  }

  private async getJson<T>(ctx: SourceSyncContext, url: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers(ctx), signal: ctx.signal ?? null });
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub rate limit exhausted; sync will resume from the committed cursor.');
    }
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status} for ${url.split('?')[0]}`);
    return await res.json() as T;
  }
}
