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

/**
 * A portable Brain atom — the serializable projection of one `memory_episodes`
 * row (learned intelligence). It carries only the CONTENT of an episode, never
 * its identity (`id`), its `scope_id`/`agent_id` (implied by which bucket the
 * atom travels in — agent brain, App brain, or workspace brain — and re-assigned
 * on install), its `embedding` (recomputed on install), or its lifecycle flags
 * (`archivedAt`/`supersededBy`/`reinforcedAt`). Maps 1:1 onto
 * `CreateRuntimeEpisodeInput` on import. Fields are loose (e.g. `type`/`source`
 * as strings) so an older/newer episode taxonomy still round-trips.
 *
 * This is what makes "share intelligence" real: an agent's or App's accumulated
 * memory travels with it. It lives here (not in package.ts) so both the App
 * manifest and the workspace bundle can reference it without an import cycle.
 */
export const portableBrainAtomSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.string().nullable().optional(),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  importance: z.number().min(0).max(1).default(0.5),
  trust: z.number().min(0).max(1).default(0.5),
  tags: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  outcomeStatus: z.enum(['good', 'bad', 'mixed']).nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
  /** Provenance only — the original creation time. Never used as an id. */
  createdAt: z.string().optional(),
});
export type PortableBrainAtom = z.infer<typeof portableBrainAtomSchema>;

/** A bundle of portable Brain atoms for one intelligence scope. */
export const portableBrainSchema = z.object({
  atoms: z.array(portableBrainAtomSchema).default([]),
});
export type PortableBrain = z.infer<typeof portableBrainSchema>;

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

/**
 * An agent (Team facet) — a full, linkable, brain-carrying definition so the
 * agent travels WITH its App and can be relinked as the App's owner on install.
 * `owner` marks the App's `ownerAgentId`; `memberRole` is its seat in the App
 * cast; `brain` is the agent's private learned memory (`scope_id = agentId`),
 * carried only in a `full`-fidelity export.
 */
export const manifestAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['operator', 'worker']).default('worker'),
  ref: z.object({ id: z.string(), version: z.string() }).optional(),
  adapterType: z.string().optional(),
  instructions: z.string().nullable().optional(),
  capabilityTags: z.array(z.string()).default([]),
  /** True for the agent that owns/operates this App (App.ownerAgentId). */
  owner: z.boolean().default(false),
  /** The agent's seat in the App cast, when it is a member. */
  memberRole: z.enum(['operator', 'worker']).optional(),
  /** Adapter config (never carries secret values). */
  config: z.record(z.unknown()).default({}),
  avatarGlyph: z.string().nullable().optional(),
  runtimeModel: z.string().nullable().optional(),
  /** Agent-private Brain memory (full fidelity only). */
  brain: portableBrainSchema.optional(),
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
  /** DEPRECATED: a bare flag. Kept readable for back-compat; no longer emitted. */
  memory: z.object({ brainScope: z.boolean() }).optional(),
  /** App-scoped Brain memory (`scope_id = appId`) — carried in full fidelity only. */
  brain: portableBrainSchema.optional(),
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



