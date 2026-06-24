/**
 * AppManifest — the canonical, versioned, serializable IR for an Agentic App
 * (AGENTIC-SYSTEMS-ARCHITECTURE §2.1). The single source of truth that:
 *   - the SDK emits (code authoring),
 *   - the agent/visual builders emit,
 *   - the runtime projects to/from DB rows (toManifest/fromManifest),
 *   - `.agentisapp` serializes for distribution.
 *
 * Every facet is a field; absence = that facet is unused (a logic-only app has
 * empty `surfaces`/`collections`). No facet carries runtime data — `collections`
 * ship SCHEMA only; rows never travel except as explicit scrubbed seed.
 */

import { z } from 'zod';
import { appIdentitySchema, appPolicySchema, appSourceSchema } from './app.js';
import { upsertSurfaceSchema, surfaceActionSchema } from './view.js';
import { collectionSchemaSchema } from './datastore.js';
import { capabilityDeclSchema } from './capability.js';

/** A workflow (Logic facet) carried in the manifest. */
export const manifestWorkflowSchema = z.object({
  slug: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  graph: z.unknown(), // WorkflowGraph; kept unknown here to avoid a heavy import cycle
});
export type ManifestWorkflow = z.infer<typeof manifestWorkflowSchema>;

/** A surface (Interface facet) — reuses the AG-UI upsert shape + declared actions. */
export const manifestSurfaceSchema = upsertSurfaceSchema.extend({
  actions: z.array(surfaceActionSchema).default([]),
});
export type ManifestSurface = z.infer<typeof manifestSurfaceSchema>;

/** A collection (Data facet) — SCHEMA only; optional opt-in seed rows (§14.4). */
export const manifestCollectionSchema = z.object({
  name: z.string().min(1),
  schema: collectionSchemaSchema,
  seed: z.array(z.record(z.unknown())).default([]),
});
export type ManifestCollection = z.infer<typeof manifestCollectionSchema>;

/** An agent (Team facet) — embedded definition or a shared-component reference. */
export const manifestAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['operator', 'worker']).default('worker'),
  ref: z.object({ id: z.string(), version: z.string() }).optional(),
  adapterType: z.string().optional(),
  instructions: z.string().nullable().optional(),
  capabilityTags: z.array(z.string()).default([]),
});
export type ManifestAgent = z.infer<typeof manifestAgentSchema>;

/** An ordered, forward-only collection migration applied on upgrade (§9.2). */
export const collectionMigrationSchema = z.object({
  id: z.string().min(1),
  collection: z.string().min(1),
  op: z.enum(['add_field', 'drop_field', 'rename_field', 'retype_field', 'transform']),
  spec: z.record(z.unknown()).default({}),
});
export type CollectionMigration = z.infer<typeof collectionMigrationSchema>;

/** A reference to another shared component/app this manifest depends on. */
export const appDependencySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  kind: z.enum(['app', 'agent', 'workflow', 'knowledge', 'plugin']),
});
export type AppDependency = z.infer<typeof appDependencySchema>;

/**
 * The full portable manifest. `identity` + `policy` reuse the runtime shapes so
 * the projection (rows ↔ manifest) is a straight map.
 */
export const appManifestSchema = z.object({
  manifestVersion: z.literal(1).default(1),
  agentisVersion: z.string().min(1).default('1.0.0'),
  identity: appIdentitySchema,
  policy: appPolicySchema,
  // facets — present only when used
  workflows: z.array(manifestWorkflowSchema).default([]),
  surfaces: z.array(manifestSurfaceSchema).default([]),
  collections: z.array(manifestCollectionSchema).default([]),
  agents: z.array(manifestAgentSchema).default([]),
  memory: z.object({ brainScope: z.boolean() }).optional(),
  // contracts & lifecycle
  capabilities: z.array(capabilityDeclSchema).default([]),
  requiredPlugins: z.array(z.string()).default([]),
  dependencies: z.array(appDependencySchema).default([]),
  migrations: z.array(collectionMigrationSchema).default([]),
  source: appSourceSchema.nullable().optional(),
});
export type AppManifest = z.infer<typeof appManifestSchema>;

/** The serialized `.agentisapp` envelope: a manifest + integrity + provenance. */
export const appManifestEnvelopeSchema = z.object({
  format: z.literal('.agentisapp'),
  formatVersion: z.literal(1),
  manifest: appManifestSchema,
  checksum: z.string(), // sha256 over canonical(manifest)
  exportedAt: z.string(),
});
export type AppManifestEnvelope = z.infer<typeof appManifestEnvelopeSchema>;

/** Non-mutating install summary shown before a `.agentisapp` enters a workspace. */
export const appInstallPreviewSchema = z.object({
  format: z.literal('.agentisapp'),
  formatVersion: z.literal(1),
  checksum: z.string(),
  exportedAt: z.string(),
  identity: appIdentitySchema,
  source: appSourceSchema.nullable(),
  counts: z.object({
    workflows: z.number().int().nonnegative(),
    surfaces: z.number().int().nonnegative(),
    collections: z.number().int().nonnegative(),
    agents: z.number().int().nonnegative(),
    capabilities: z.number().int().nonnegative(),
    dependencies: z.number().int().nonnegative(),
    migrations: z.number().int().nonnegative(),
  }),
  facets: z.object({
    workflows: z.array(z.string()),
    surfaces: z.array(z.string()),
    collections: z.array(z.string()),
  }),
  requiredPlugins: z.array(z.string()),
  permissions: z.array(z.string()),
  scanWarnings: z.array(z.string()).default([]),
  warnings: z.array(z.string()),
});
export type AppInstallPreview = z.infer<typeof appInstallPreviewSchema>;

/**
 * Canonical JSON serialization (sorted keys) so `checksum` is deterministic and
 * manifest diffs (for upgrade, §9.2) are meaningful. Pure, dependency-free.
 */
export function canonicalizeManifest(manifest: AppManifest): string {
  return JSON.stringify(sortKeysDeep(manifest));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}
