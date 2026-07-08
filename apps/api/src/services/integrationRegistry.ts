import { randomUUID, createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  builtinIntegrationManifests,
  defaultConnectorRegistry,
  manifestHttpConnector,
  type IntegrationManifest,
} from '@agentis/integrations';

const serviceSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/u, 'Use lowercase letters, numbers, underscores, and dashes.');

export const integrationOperationSpecSchema = z.object({
  name: serviceSlugSchema,
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  urlTemplate: z.string().trim().min(1).max(2000),
  headers: z.record(z.string()).default({}),
  query: z.record(z.string()).default({}),
  bodyTemplate: z.unknown().optional(),
  paramSchema: z.record(z.unknown()).default({}),
  responseMode: z.enum(['auto', 'json', 'text']).optional().default('auto'),
});

export const integrationManifestInputSchema = z.object({
  service: serviceSlugSchema,
  name: z.string().trim().min(1).max(160),
  version: z.string().trim().min(1).max(64).default('1.0.0'),
  category: z.string().trim().min(1).max(80).default('Custom'),
  description: z.string().trim().max(2000).default('Custom HTTP integration.'),
  auth: z
    .object({
      type: z.enum(['none', 'api_key', 'bearer', 'basic', 'oauth2']).default('none'),
      headerName: z.string().trim().max(120).optional(),
      queryParamName: z.string().trim().max(120).optional(),
    })
    .default({ type: 'none' }),
  operations: z.array(serviceSlugSchema).optional(),
  operationSpecs: z.array(integrationOperationSpecSchema).min(1),
  credentialSchema: z.record(z.unknown()).optional(),
  icon: z.string().trim().max(120).optional(),
  docsUrl: z.string().url().optional(),
});

export type IntegrationManifestInput = z.infer<typeof integrationManifestInputSchema>;

export interface StoredIntegrationManifest extends IntegrationManifest {
  id?: string;
  packageId?: string;
  source: 'builtin' | 'custom';
  updatedAt?: string;
}

export function normalizeIntegrationManifest(input: IntegrationManifestInput): IntegrationManifest {
  const operations = input.operations?.length
    ? input.operations
    : input.operationSpecs.map((operation) => operation.name);
  const firstOperation = operations[0] ?? input.operationSpecs[0]?.name ?? 'request';
  return {
    service: input.service,
    name: input.name,
    version: input.version,
    category: input.category,
    description: input.description,
    auth: input.auth,
    operations,
    operationSpecs: input.operationSpecs,
    credentialSchema: input.credentialSchema ?? credentialSchemaForAuth(input.auth),
    nodeConfig: { kind: 'integration', service: input.service, operation: firstOperation },
    icon: input.icon ?? input.service,
    docsUrl: input.docsUrl,
    builtin: false,
    runtime: 'manifest_only',
  };
}

export function listIntegrationManifests(
  db: AgentisSqliteDb,
  workspaceId: string,
): StoredIntegrationManifest[] {
  return [
    ...builtinIntegrationManifests.map((manifest) => ({
      ...withOperationContracts(manifest),
      id: manifest.service,
      source: 'builtin' as const,
    })),
    ...listCustomIntegrationManifests(db, workspaceId).map(withOperationContracts),
  ].sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name));
}

function withOperationContracts<T extends IntegrationManifest>(manifest: T): T {
  const connector = defaultConnectorRegistry.has(manifest.service)
    ? defaultConnectorRegistry.get(manifest.service)
    : manifestHttpConnector(manifest);
  return {
    ...manifest,
    ...(connector.operationContracts ? { operationContracts: connector.operationContracts } : {}),
  };
}

export function listCustomIntegrationManifests(
  db: AgentisSqliteDb,
  workspaceId: string,
): StoredIntegrationManifest[] {
  return db
    .select()
    .from(schema.libraryPackages)
    .where(and(eq(schema.libraryPackages.workspaceId, workspaceId), eq(schema.libraryPackages.kind, 'integration')))
    .all()
    .map(integrationFromPackageRow)
    .filter((manifest): manifest is StoredIntegrationManifest => Boolean(manifest));
}

export function getCustomIntegrationManifest(
  db: AgentisSqliteDb,
  workspaceId: string,
  idOrService: string,
): StoredIntegrationManifest {
  const manifest = listCustomIntegrationManifests(db, workspaceId).find(
    (candidate) => candidate.packageId === idOrService || candidate.id === idOrService || candidate.service === idOrService,
  );
  if (!manifest) throw new AgentisError('RESOURCE_NOT_FOUND', 'Integration not found');
  return manifest;
}

export function createCustomIntegrationManifest(
  db: AgentisSqliteDb,
  scope: { workspaceId: string; ambientId: string | null; userId: string },
  manifest: IntegrationManifest,
): StoredIntegrationManifest {
  assertServiceAvailable(db, scope.workspaceId, manifest.service);
  const packageId = randomUUID();
  const now = new Date().toISOString();
  const contents = packageContentsFor(manifest);
  db.insert(schema.libraryPackages)
    .values({
      id: packageId,
      workspaceId: scope.workspaceId,
      ambientId: scope.ambientId,
      userId: scope.userId,
      slug: `integration-${manifest.service}`,
      name: manifest.name,
      version: manifest.version,
      kind: 'integration',
      description: manifest.description,
      tags: [manifest.category, 'custom-integration'],
      contents,
      sourceId: packageId,
      sourceKind: 'integration',
      checksum: checksum(contents),
      remoteId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { ...manifest, id: packageId, packageId, source: 'custom', updatedAt: now };
}

export function updateCustomIntegrationManifest(
  db: AgentisSqliteDb,
  workspaceId: string,
  id: string,
  manifest: IntegrationManifest,
): StoredIntegrationManifest {
  const existing = getCustomIntegrationManifest(db, workspaceId, id);
  if (existing.service !== manifest.service) {
    assertServiceAvailable(db, workspaceId, manifest.service);
  }
  const packageId = existing.packageId ?? existing.id ?? id;
  const now = new Date().toISOString();
  const contents = packageContentsFor(manifest);
  db.update(schema.libraryPackages)
    .set({
      slug: `integration-${manifest.service}`,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      tags: [manifest.category, 'custom-integration'],
      contents,
      checksum: checksum(contents),
      updatedAt: now,
    })
    .where(and(eq(schema.libraryPackages.id, packageId), eq(schema.libraryPackages.workspaceId, workspaceId)))
    .run();
  return { ...manifest, id: packageId, packageId, source: 'custom', updatedAt: now };
}

export function deleteCustomIntegrationManifest(
  db: AgentisSqliteDb,
  workspaceId: string,
  id: string,
): void {
  const existing = getCustomIntegrationManifest(db, workspaceId, id);
  const packageId = existing.packageId ?? existing.id ?? id;
  const result = db
    .delete(schema.libraryPackages)
    .where(and(eq(schema.libraryPackages.id, packageId), eq(schema.libraryPackages.workspaceId, workspaceId)))
    .run();
  if (result.changes === 0) throw new AgentisError('RESOURCE_NOT_FOUND', 'Integration not found');
}

export async function testIntegrationManifest(args: {
  manifest: IntegrationManifest;
  operation: string;
  params: Record<string, unknown>;
  credential?: Record<string, unknown> | null;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const connector = manifestHttpConnector(args.manifest);
  return connector.execute({
    operation: args.operation,
    params: args.params,
    credential: args.credential ?? null,
    timeoutMs: args.timeoutMs,
  });
}

function assertServiceAvailable(db: AgentisSqliteDb, workspaceId: string, service: string): void {
  if (builtinIntegrationManifests.some((manifest) => manifest.service === service)) {
    throw new AgentisError('VALIDATION_FAILED', `Integration service '${service}' is reserved by a built-in connector`);
  }
  if (listCustomIntegrationManifests(db, workspaceId).some((manifest) => manifest.service === service)) {
    throw new AgentisError('VALIDATION_FAILED', `Integration service '${service}' already exists`);
  }
}

function integrationFromPackageRow(
  row: typeof schema.libraryPackages.$inferSelect,
): StoredIntegrationManifest | null {
  const contents = objectRecord(row.contents);
  const integration = objectRecord(contents.integration);
  if (!integration.service) return null;
  const operationSpecs = Array.isArray(integration.operationSpecs)
    ? integration.operationSpecs
    : [];
  const operations = stringArray(integration.operations);
  return {
    service: String(integration.service),
    name: typeof integration.name === 'string' ? integration.name : row.name,
    version: typeof integration.version === 'string' ? integration.version : row.version,
    category: typeof integration.category === 'string' ? integration.category : 'Custom',
    description: typeof integration.description === 'string' ? integration.description : row.description ?? '',
    auth: objectRecord(integration.auth) as unknown as IntegrationManifest['auth'],
    operations: operations.length > 0
      ? operations
      : operationSpecs.map((spec) => objectRecord(spec).name).filter((name): name is string => typeof name === 'string'),
    operationSpecs: operationSpecs as IntegrationManifest['operationSpecs'],
    credentialSchema: objectRecord(integration.credentialSchema),
    nodeConfig: {
      kind: 'integration',
      service: String(integration.service),
      operation:
        typeof objectRecord(integration.nodeConfig).operation === 'string'
          ? String(objectRecord(integration.nodeConfig).operation)
          : operations[0],
    },
    icon: typeof integration.icon === 'string' ? integration.icon : String(integration.service),
    docsUrl: typeof integration.docsUrl === 'string' ? integration.docsUrl : undefined,
    builtin: false,
    runtime: 'manifest_only',
    id: row.id,
    packageId: row.id,
    source: 'custom',
    updatedAt: row.updatedAt,
  };
}

function packageContentsFor(manifest: IntegrationManifest) {
  return {
    kind: 'integration' as const,
    integration: manifest,
  };
}

function credentialSchemaForAuth(auth: IntegrationManifestInput['auth']): Record<string, unknown> {
  if (auth.type === 'none') return { type: 'none', fields: [] };
  if (auth.type === 'bearer' || auth.type === 'oauth2') return { type: auth.type, fields: ['token'] };
  if (auth.type === 'basic') return { type: 'basic', fields: ['username', 'password'] };
  return {
    type: 'api_key',
    fields: auth.headerName ? ['apiKey'] : ['apiKey', 'headerName'],
    ...(auth.headerName ? { headerName: auth.headerName } : {}),
    ...(auth.queryParamName ? { queryParamName: auth.queryParamName } : {}),
  };
}

function checksum(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
