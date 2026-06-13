/**
 * Google Drive KnowledgeSource — file metadata + Google Docs text (RFC §7.6).
 *
 * Distinct from the Drive workflow operations: this is continuous sync.
 * Cursor = newest modifiedTime seen (RFC §7.5 — source timestamps, not
 * ingestion order). Trashed files emit tombstones (supportsDeletes). Native
 * Google Docs export plain text (size-capped); other files sync as metadata
 * so the map and claims still see the system landscape without bulk binary
 * ingestion. Boundary: private_external / confidential by default; the
 * owner's learning brief and rules widen exposure, never the sync.
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
  SourcePrincipalInput,
  SourceSyncContext,
} from '../types.js';

const DRIVE_BOUNDARY: InformationBoundary = {
  origin: 'private_external',
  confidentiality: 'confidential',
  audience: 'delegated_agents',
  customerSafe: false,
  trainingAllowed: false,
  exportAllowed: false,
  policySource: 'source_acl',
};

const PAGE_SIZE = 100;
const MAX_DOC_CHARS = 20_000;
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,createdTime,webViewLink,trashed,shared,owners(emailAddress,displayName),parents';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  createdTime?: string;
  webViewLink?: string;
  trashed?: boolean;
  shared?: boolean;
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
  parents?: string[];
}

export class GoogleDriveSource implements KnowledgeSource {
  readonly sourceType = 'google_drive';
  readonly displayName = 'Google Drive';
  readonly capabilities: SourceCapabilities = {
    supportsBackfill: true,
    supportsIncrementalCursor: true,
    supportsWebhooks: false,
    supportsDeletes: true,
    supportsAclSync: false,
    supportsIdentityDirectory: true,
    supportsAttachments: false,
    supportsHistory: false,
    consistency: 'eventual',
  };

  async validateConnection(ctx: SourceSyncContext): Promise<SourceConnectionHealth> {
    if (!ctx.accessToken) return { ok: false, detail: 'Google token missing — connect a credential.' };
    const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      signal: ctx.signal ?? null,
    });
    return res.ok ? { ok: true } : { ok: false, detail: `Drive about: HTTP ${res.status}` };
  }

  async discoverScopes(ctx: SourceSyncContext): Promise<DiscoveredSourceScope[]> {
    // Top-level folders are the natural inclusion scopes.
    const data = await this.getJson<{ files?: DriveFile[] }>(ctx,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent("mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false")}&pageSize=${PAGE_SIZE}&fields=files(id,name)`);
    return (data.files ?? []).map((folder) => ({
      id: folder.id,
      label: folder.name,
      kind: 'folder',
      recommended: false, // explicit owner selection — connecting Drive ≠ indexing everything (RFC §7.2)
    }));
  }

  async *backfill(request: BackfillRequest): AsyncIterable<SourceChangeBatch> {
    yield* this.crawl(request, request.since ?? null);
  }

  async *synchronize(request: IncrementalSyncRequest): AsyncIterable<SourceChangeBatch> {
    yield* this.crawl(request, request.cursor ?? null);
  }

  async *resolvePrincipals(ctx: SourceSyncContext): AsyncIterable<SourcePrincipalInput> {
    // Drive has no directory API on these scopes; owners discovered during
    // crawl are emitted via evidence. The about endpoint at least yields self.
    const data = await this.getJson<{ user?: { emailAddress?: string; displayName?: string; permissionId?: string } }>(
      ctx, 'https://www.googleapis.com/drive/v3/about?fields=user');
    if (data.user?.permissionId) {
      yield {
        externalPrincipalId: data.user.permissionId,
        kind: 'person',
        displayName: data.user.displayName,
        email: data.user.emailAddress,
      };
    }
  }

  private async *crawl(ctx: SourceSyncContext, since: string | null): AsyncIterable<SourceChangeBatch> {
    let newest = since ?? '';
    let pageToken: string | undefined;
    const scopeFilter = ctx.includedScopes.length > 0
      ? ` and (${ctx.includedScopes.map((id) => `'${id.replace(/'/g, '')}' in parents`).join(' or ')})`
      : '';
    do {
      if (ctx.signal?.aborted) return;
      const q = `${since ? `modifiedTime > '${since}'` : 'trashed=false or trashed=true'}${scopeFilter}`;
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=modifiedTime&pageSize=${PAGE_SIZE}&fields=nextPageToken,files(${encodeURIComponent(FILE_FIELDS)})${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const data = await this.getJson<{ files?: DriveFile[]; nextPageToken?: string }>(ctx, url);
      const objects: CanonicalSourceObject[] = [];
      const deletions: SourceChangeBatch['deletions'] = [];
      for (const file of data.files ?? []) {
        if (ctx.excludedScopes.some((scope) => file.parents?.includes(scope))) continue;
        if (file.modifiedTime > newest) newest = file.modifiedTime;
        if (file.trashed) {
          deletions.push({ externalId: file.id, state: 'deleted', at: file.modifiedTime });
          continue;
        }
        const isGoogleDoc = file.mimeType === 'application/vnd.google-apps.document';
        let content = `${file.name} (${file.mimeType})`;
        if (isGoogleDoc) {
          content = await this.exportDocText(ctx, file.id).catch(() => content);
        }
        objects.push({
          externalId: file.id,
          externalVersionId: file.modifiedTime,
          objectType: isGoogleDoc ? 'document' : 'file',
          title: file.name,
          nativeUrl: file.webViewLink,
          authorExternalId: file.owners?.[0]?.emailAddress,
          createdAt: file.createdTime,
          modifiedAt: file.modifiedTime,
          observedAt: new Date().toISOString(),
          content,
          attributes: { mimeType: file.mimeType, owners: file.owners?.map((o) => o.emailAddress).filter(Boolean) },
          boundary: DRIVE_BOUNDARY,
          // Exact-capture ACL (§9.1): owners are the allow list; `shared`
          // means more principals exist than we enumerated → partial fidelity.
          acl: {
            mode: 'explicit',
            allow: (file.owners ?? []).map((o) => o.emailAddress).filter((e): e is string => Boolean(e)),
            deny: [],
            fidelity: file.shared ? 'partial' : 'exact',
            capturedAt: new Date().toISOString(),
          },
        });
      }
      if (objects.length > 0 || deletions.length > 0) {
        yield { objects, deletions, cursor: newest || since };
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    yield { objects: [], deletions: [], cursor: newest || since, done: true };
  }

  private async exportDocText(ctx: SourceSyncContext, fileId: string): Promise<string> {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      signal: ctx.signal ?? null,
    });
    if (!res.ok) throw new Error(`Drive export HTTP ${res.status}`);
    const text = await res.text();
    return text.slice(0, MAX_DOC_CHARS);
  }

  private async getJson<T>(ctx: SourceSyncContext, url: string): Promise<T> {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      signal: ctx.signal ?? null,
    });
    if (res.status === 429) throw new Error('Google Drive rate limit; retry later.');
    if (!res.ok) throw new Error(`Google Drive HTTP ${res.status}`);
    return await res.json() as T;
  }
}
