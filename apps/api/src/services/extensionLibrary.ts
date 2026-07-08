/**
 * Workspace extension source library.
 *
 * The extension runtime has two persisted surfaces:
 * - `extensions/<slug>.md` in the workspace volume for editable source.
 * - `extensions` database rows for executable workflow bindings.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import type { ExtensionCredentialKey, ExtensionManifest, ExtensionOperation, ExtensionPermission } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkspaceVolumeService } from './workspace/workspaceVolume.js';
import { validateExtensionManifest } from './extensionRuntime.js';
import { validateExtensionSource } from '../extensions/validateSource.js';

const EXTENSIONS_DIR = 'extensions';

export interface ExtensionLibraryScope {
  workspaceId: string;
  ambientId?: string | null;
  userId: string;
}

export interface CreateNodeWorkerExtensionInput {
  extensionId?: string;
  name: string;
  slug?: string;
  version?: string;
  description?: string;
  source: string;
  operations?: ExtensionOperation[];
  permissions?: ExtensionPermission[];
  credentialKeys?: Array<string | ExtensionCredentialKey>;
  categories?: string[];
  capabilityTags?: string[];
  timeoutMs?: number;
  allowedDomains?: string[];
}

export class ExtensionLibraryService {
  constructor(
    private readonly volume: WorkspaceVolumeService,
    private readonly db?: AgentisSqliteDb,
  ) {}

  async listSourceFiles(workspaceId: string): Promise<Array<{ name: string; path: string }>> {
    const entries = await this.volume.list(workspaceId, EXTENSIONS_DIR);
    return entries
      .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.md'))
      .map((entry) => ({ name: entry.name.replace(/\.md$/, ''), path: `${EXTENSIONS_DIR}/${entry.name}` }));
  }

  async createNodeWorkerExtension(
    scope: ExtensionLibraryScope,
    input: CreateNodeWorkerExtensionInput,
  ): Promise<{ id: string; path: string; manifest: ExtensionManifest; created: boolean; matchedBy: 'id' | 'slug' | 'identity' | 'new' }> {
    if (!this.db) throw new Error('ExtensionLibraryService.createNodeWorkerExtension requires a database handle');
    const operations: ExtensionOperation[] = input.operations?.length ? input.operations : [{
      name: 'execute',
      description: input.description,
      inputSchema: {},
      outputSchema: {},
    }];
    const requestedSlug = sanitizeSlug(input.slug ?? input.name);
    const workspaceExtensions = this.db
      .select()
      .from(schema.extensions)
      .where(eq(schema.extensions.workspaceId, scope.workspaceId))
      .all();
    const resolved = resolveExistingExtension(workspaceExtensions, {
      extensionId: input.extensionId,
      slug: requestedSlug,
      name: input.name,
      requiresListenerSource: operations.some((operation) => operation.isListenerSource),
    });
    const existing = resolved.row;
    const slug = existing?.slug ?? requestedSlug;
    const listenerOperations = operations.filter((o) => o.isListenerSource).map((o) => o.name);
    const manifest: ExtensionManifest = {
      name: input.name.trim(),
      slug,
      version: input.version?.trim() || '1.0.0',
      description: input.description?.trim() || undefined,
      runtime: 'node_worker',
      entrypoint: `${slug}.js`,
      source: input.source,
      operations,
      ...(listenerOperations.length ? { listenerOperations } : {}),
      permissions: input.permissions ?? [],
      credentialKeys: input.credentialKeys,
      categories: input.categories,
      capabilityTags: input.capabilityTags ?? [],
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}),
    };
    validateExtensionManifest(manifest, { install: true });

    // Source gate — reject CommonJS/ESM module syntax, syntax errors, and a
    // missing entrypoint BEFORE persisting, so a broken extension can never
    // reach a live run (where it would crash with `require is not defined` etc.).
    const sourceCheck = validateExtensionSource(input.source, operations.map((operation) => operation.name));
    if (!sourceCheck.ok) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `${sourceCheck.issue.message} ${sourceCheck.issue.remediation}`,
        { details: { code: sourceCheck.issue.code, construct: sourceCheck.issue.construct }, remediation: sourceCheck.issue.remediation },
      );
    }

    const rel = `${EXTENSIONS_DIR}/${slug}.md`;
    await this.volume.write(scope.workspaceId, rel, serializeNodeWorkerExtension(manifest));

    const now = new Date().toISOString();
    if (existing) {
      this.db
        .update(schema.extensions)
        .set({
          name: manifest.name,
          version: manifest.version,
          runtime: manifest.runtime,
          manifest,
          updatedAt: now,
        })
        .where(eq(schema.extensions.id, existing.id))
        .run();
      return { id: existing.id, path: rel, manifest, created: false, matchedBy: resolved.matchedBy };
    }

    const id = randomUUID();
    this.db
      .insert(schema.extensions)
      .values({
        id,
        workspaceId: scope.workspaceId,
        ambientId: scope.ambientId ?? null,
        userId: scope.userId,
        packageId: null,
        name: manifest.name,
        slug: manifest.slug,
        version: manifest.version,
        runtime: manifest.runtime,
        manifest,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return { id, path: rel, manifest, created: true, matchedBy: 'new' };
  }
}

type ExtensionRow = typeof schema.extensions.$inferSelect;

function resolveExistingExtension(
  rows: ExtensionRow[],
  request: {
    extensionId?: string;
    slug: string;
    name: string;
    requiresListenerSource: boolean;
  },
): { row: ExtensionRow | undefined; matchedBy: 'id' | 'slug' | 'identity' | 'new' } {
  if (request.extensionId) {
    const byId = rows.find((row) => row.id === request.extensionId);
    if (!byId) throw new Error(`Extension ${request.extensionId} was not found in this workspace`);
    return { row: byId, matchedBy: 'id' };
  }

  const bySlug = rows.find((row) => normalizeIdentity(row.slug) === normalizeIdentity(request.slug));
  if (bySlug) return { row: bySlug, matchedBy: 'slug' };

  const identity = normalizeIdentity(request.name);
  const byIdentity = rows.filter((row) =>
    normalizeIdentity(row.name) === identity || normalizeIdentity(row.slug) === identity,
  );
  if (byIdentity.length === 0) return { row: undefined, matchedBy: 'new' };

  const ranked = [...byIdentity].sort((left, right) => {
    if (request.requiresListenerSource) {
      const listenerDelta = Number(hasListenerSource(right)) - Number(hasListenerSource(left));
      if (listenerDelta !== 0) return listenerDelta;
    }
    return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
  });
  return { row: ranked[0], matchedBy: 'identity' };
}

function hasListenerSource(row: ExtensionRow): boolean {
  const manifest = row.manifest as Partial<ExtensionManifest> | null;
  return Boolean(
    manifest?.operations?.some((operation) => operation.isListenerSource)
    || manifest?.listenerOperations?.length,
  );
}

export function normalizeExtensionIdentity(value: string): string {
  return normalizeIdentity(value);
}

function normalizeIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function serializeNodeWorkerExtension(s: ExtensionManifest): string {
  return [
    '---',
    `name: ${s.name}`,
    `slug: ${s.slug}`,
    `version: ${s.version}`,
    ...(s.description ? [`description: ${s.description}`] : []),
    `runtime: ${s.runtime}`,
    `entrypoint: ${s.entrypoint}`,
    `permissions: [${(s.permissions ?? []).join(', ')}]`,
    `credentialKeys: [${(s.credentialKeys ?? []).map((entry) => typeof entry === 'string' ? entry : entry.key).join(', ')}]`,
    `categories: [${(s.categories ?? []).join(', ')}]`,
    `capabilityTags: [${s.capabilityTags.join(', ')}]`,
    `allowedDomains: [${(s.allowedDomains ?? []).join(', ')}]`,
    ...(s.timeoutMs ? [`timeoutMs: ${s.timeoutMs}`] : []),
    `operations: ${JSON.stringify(s.operations)}`,
    '---',
    '',
    '```js',
    s.source ?? '',
    '```',
    '',
  ].join('\n');
}

function sanitizeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!slug) throw new Error('Extension slug cannot be empty');
  return slug;
}
