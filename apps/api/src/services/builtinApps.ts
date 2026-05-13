import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { agentisPackageContentsSchema, type AgentisPackageContents } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

const builtinAppManifestSchema = z.object({
  slug: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  version: z.string().min(1).max(64).default('1.0.0'),
  description: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().min(1).max(64)).default([]),
  contents: agentisPackageContentsSchema,
});

type BuiltinAppManifest = z.infer<typeof builtinAppManifestSchema>;

export interface BuiltinAppSeedScope {
  workspaceId: string;
  ambientId?: string | null;
  userId: string;
}

let cachedManifests: BuiltinAppManifest[] | null = null;

export function seedBuiltinAppsForWorkspace(db: AgentisSqliteDb, scope: BuiltinAppSeedScope): number {
  const manifests = loadBuiltinAppManifests();
  let created = 0;
  for (const manifest of manifests) {
    const existing = db
      .select({ id: schema.libraryPackages.id })
      .from(schema.libraryPackages)
      .where(and(eq(schema.libraryPackages.workspaceId, scope.workspaceId), eq(schema.libraryPackages.slug, manifest.slug)))
      .get();
    if (existing) continue;

    const now = new Date().toISOString();
    const contents: AgentisPackageContents = manifest.contents;
    db.insert(schema.libraryPackages)
      .values({
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        ambientId: scope.ambientId ?? null,
        userId: scope.userId,
        slug: manifest.slug,
        name: manifest.name,
        version: manifest.version,
        kind: 'agentis',
        description: manifest.description ?? null,
        tags: manifest.tags,
        contents,
        sourceId: null,
        sourceKind: null,
        checksum: checksum(contents),
        remoteId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    created += 1;
  }
  return created;
}

function loadBuiltinAppManifests(): BuiltinAppManifest[] {
  if (cachedManifests) return cachedManifests;
  const dir = builtinAppsDir();
  if (!existsSync(dir)) {
    cachedManifests = [];
    return cachedManifests;
  }
  cachedManifests = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as unknown;
      return builtinAppManifestSchema.parse(raw);
    });
  return cachedManifests;
}

function builtinAppsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../packages/core/src/data/builtin-apps');
}

function checksum(contents: AgentisPackageContents): string {
  return createHash('sha256').update(stableJson(contents)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
