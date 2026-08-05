import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, type ComponentManifestV2, type ExtensionManifest, type ExtensionPermission } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  installComponentBundle,
  installPortableComponentBundle,
  type PortableComponentBundleFile,
} from '../extensions/componentBundle.js';
import { normalizeExtensionManifest, validateExtensionManifest } from './extensionRuntime.js';

const componentPermissionSchema = z.enum([
  'network', 'network.unrestricted', 'credentials', 'workspace.read',
  'workspace.write', 'filesystem', 'spawn', 'listener', 'listener.emit',
  'listener.cursor', 'kv.read', 'kv.write',
]);

const componentOperationSchema = z.object({
  name: z.string().min(1),
  description: z.string().max(2_000).optional(),
  inputSchema: z.record(z.unknown()).default({}),
  outputSchema: z.record(z.unknown()).default({}),
  isListenerSource: z.boolean().optional(),
  listenerConfig: z.object({
    emitsEvents: z.boolean().optional(),
    cursorSupported: z.boolean().optional(),
    description: z.string().max(2_000).optional(),
  }).optional(),
});

export const componentInstallPayloadSchema = z.object({
  extensionId: z.string().min(1).optional(),
  bundleDir: z.string().min(1).optional(),
  bundleFiles: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dataBase64: z.string(),
  })).min(1).max(5_000).optional(),
  manifest: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    version: z.string().min(1),
    description: z.string().max(2_000).optional(),
    runtime: z.literal('component_oci'),
    permissions: z.array(componentPermissionSchema).default([]),
    allowedDomains: z.array(z.string()).default([]),
    capabilityTags: z.array(z.string()).default([]),
    component: z.object({
      manifestVersion: z.literal(2),
      id: z.string().min(1),
      version: z.string().min(1),
      runtime: z.object({ language: z.enum(['python', 'node']), version: z.string().min(1) }),
      entrypoint: z.string().min(1),
      operations: z.array(componentOperationSchema).min(1),
      dependencyLock: z.string().min(1),
      bundleHash: z.string().default(''),
      permissions: z.array(componentPermissionSchema).default([]),
      allowedDomains: z.array(z.string()).default([]),
      resources: z.object({
        cpu: z.number().positive().max(8),
        memoryMb: z.number().int().min(32).max(8192),
        timeoutSec: z.number().int().min(1).max(3600),
        tmpMb: z.number().int().positive().max(4096).optional(),
      }),
      healthcheck: z.string().optional(),
      sbom: z.record(z.unknown()).optional(),
    }),
  }),
  permissionsAcknowledged: z.array(componentPermissionSchema).default([]),
}).refine((value) => Boolean(value.bundleDir) !== Boolean(value.bundleFiles?.length), {
  message: 'Provide exactly one of bundleDir or bundleFiles',
});

export interface ComponentExtensionManifestInput {
  name: string;
  slug: string;
  version: string;
  description?: string;
  permissions: ExtensionPermission[];
  allowedDomains?: string[];
  capabilityTags?: string[];
  component: ComponentManifestV2;
}

export interface InstallComponentExtensionInput {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  extensionId?: string | null;
  manifest: ComponentExtensionManifestInput;
  permissionsAcknowledged: ExtensionPermission[];
  bundleDir?: string;
  bundleFiles?: PortableComponentBundleFile[];
}

/** One persistence path shared by HTTP and agent tools. Upgrades preserve extension IDs. */
export function installComponentExtension(db: AgentisSqliteDb, input: InstallComponentExtensionInput) {
  assertPermissionsAcknowledged(input.manifest.permissions, input.permissionsAcknowledged);
  if (!sameStrings(input.manifest.permissions, input.manifest.component.permissions)) {
    throw new AgentisError('EXTENSION_MANIFEST_INVALID', 'component permissions must match the enclosing extension permissions');
  }
  const hasDir = Boolean(input.bundleDir?.trim());
  const hasFiles = Boolean(input.bundleFiles?.length);
  if (hasDir === hasFiles) {
    throw new AgentisError('VALIDATION_FAILED', 'Provide exactly one of bundleDir or bundleFiles');
  }
  const installed = hasDir
    ? installComponentBundle(input.bundleDir!, input.manifest.component)
    : installPortableComponentBundle(input.bundleFiles!, input.manifest.component);
  const manifest = normalizeExtensionManifest({
    ...input.manifest,
    allowedDomains: input.manifest.allowedDomains ?? [],
    capabilityTags: input.manifest.capabilityTags ?? [],
    runtime: 'component_oci',
    entrypoint: input.manifest.component.entrypoint,
    operations: input.manifest.component.operations,
    bundleDir: installed.bundleDir,
    component: { ...input.manifest.component, bundleHash: installed.bundleHash },
    timeoutMs: input.manifest.component.resources.timeoutSec * 1000,
  } satisfies ExtensionManifest);
  validateExtensionManifest(manifest, { install: true });

  const requested = input.extensionId
    ? db.select().from(schema.extensions).where(and(
        eq(schema.extensions.id, input.extensionId),
        eq(schema.extensions.workspaceId, input.workspaceId),
      )).get()
    : undefined;
  if (input.extensionId && !requested) throw new AgentisError('EXTENSION_NOT_FOUND', 'extension to upgrade was not found');
  const bySlug = db.select().from(schema.extensions).where(and(
    eq(schema.extensions.workspaceId, input.workspaceId),
    eq(schema.extensions.slug, manifest.slug),
  )).get();
  if (requested && bySlug && requested.id !== bySlug.id) {
    throw new AgentisError('RESOURCE_CONFLICT', `component slug ${manifest.slug} belongs to another extension`);
  }
  const existing = requested ?? bySlug;
  const id = existing?.id ?? randomUUID();
  const now = new Date().toISOString();
  if (existing) {
    db.update(schema.extensions).set({
      name: manifest.name,
      slug: manifest.slug,
      version: manifest.version,
      runtime: 'component_oci',
      manifest,
      updatedAt: now,
    }).where(and(eq(schema.extensions.id, id), eq(schema.extensions.workspaceId, input.workspaceId))).run();
  } else {
    db.insert(schema.extensions).values({
      id,
      workspaceId: input.workspaceId,
      ambientId: input.ambientId,
      userId: input.userId,
      name: manifest.name,
      slug: manifest.slug,
      version: manifest.version,
      runtime: 'component_oci',
      manifest,
      createdAt: now,
      updatedAt: now,
    }).run();
  }
  return {
    id,
    created: !existing,
    upgraded: Boolean(existing && (existing.runtime !== 'component_oci' || existing.version !== manifest.version)),
    previousRuntime: existing?.runtime ?? null,
    manifest,
    bundle: installed,
  };
}

function assertPermissionsAcknowledged(permissions: ExtensionPermission[], acknowledged: ExtensionPermission[]) {
  if (!sameStrings(permissions, acknowledged)) {
    throw new AgentisError(
      'EXTENSION_PERMISSIONS_NOT_ACKNOWLEDGED',
      'Extension permissions must be acknowledged before install',
      { details: { expected: uniqueSorted(permissions), actual: uniqueSorted(acknowledged) } },
    );
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
