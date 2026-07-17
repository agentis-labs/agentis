import { z } from 'zod';
import { appIdentitySchema } from './app.js';
import { appManifestSchema, portableBrainSchema } from './manifest.js';
import { upsertSurfaceSchema } from './view.js';
import { collectionSchemaSchema } from './datastore.js';

export const packageKindSchema = z.enum(['agent', 'workflow', 'extension', 'agentis', 'integration', 'skill']);
export type PackageKind = z.infer<typeof packageKindSchema>;

/**
 * A portable Skill (a standard `SKILL.md`): frontmatter name/description + a
 * markdown body (the procedure). Installing it materializes the SKILL.md to disk
 * and creates a Brain `skill` atom at the chosen scope. See Living Skills.
 */
export const skillContentsSchema = z.object({
  name: z.string().min(1).max(160),
  slug: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  /** The SKILL.md body (markdown procedure). */
  body: z.string().default(''),
});
export type SkillContents = z.infer<typeof skillContentsSchema>;

export const agentContentsSchema = z.object({
  name: z.string().min(1),
  adapterType: z.string().min(1),
  capabilityTags: z.array(z.string()).default([]),
  config: z.record(z.unknown()).default({}),
  instructions: z.string().nullable().optional(),
  avatarGlyph: z.string().nullable().optional(),
  runtimeModel: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  monthlyBudgetCents: z.number().int().nonnegative().nullable().optional(),
  /** Agent-private Brain memory (`scope_id = agentId`) — full fidelity only. */
  brain: portableBrainSchema.optional(),
});
export type AgentContents = z.infer<typeof agentContentsSchema>;

export const workflowContentsSchema = z.object({
  slug: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().max(8000).nullable().optional(),
  graph: z.unknown(),
  settings: z.record(z.unknown()).default({}),
  maxConcurrentRuns: z.number().int().positive().nullable().optional(),
  concurrencyOverflow: z.enum(['queue', 'reject', 'replace_oldest']).nullable().optional(),
});
export type WorkflowContents = z.infer<typeof workflowContentsSchema>;

export const extensionContentsSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  version: z.string().min(1),
  runtime: z.enum(['builtin', 'node_worker', 'docker_sandbox']),
  manifest: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    version: z.string().min(1),
    runtime: z.enum(['builtin', 'node_worker', 'docker_sandbox']),
    entrypoint: z.string().min(1).optional(),
    operations: z.array(z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      inputSchema: z.record(z.unknown()).default({}),
      outputSchema: z.record(z.unknown()).default({}),
    })).min(1),
    capabilityTags: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().optional(),
    allowedDomains: z.array(z.string()).optional(),
    source: z.string().optional(),
    bundleDir: z.string().optional(),
  }),
});
export type ExtensionContents = z.infer<typeof extensionContentsSchema>;

export const integrationContentsSchema = z.object({
  service: z.string().min(1),
  name: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  category: z.string().min(1),
  description: z.string().optional(),
  operations: z.array(z.string().min(1)).default([]),
  operationSpecs: z
    .array(
      z.object({
        name: z.string().min(1),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        urlTemplate: z.string().min(1),
        headers: z.record(z.string()).optional(),
        query: z.record(z.string()).optional(),
        bodyTemplate: z.unknown().optional(),
        paramSchema: z.record(z.unknown()).optional(),
        responseMode: z.enum(['auto', 'json', 'text']).optional(),
      }),
    )
    .optional(),
  auth: z
    .object({
      type: z.enum(['none', 'api_key', 'bearer', 'basic', 'oauth2']),
      headerName: z.string().optional(),
      queryParamName: z.string().optional(),
    })
    .optional(),
  credentialSchema: z.record(z.unknown()).default({}),
  nodeConfig: z.object({
    kind: z.literal('integration'),
    service: z.string().min(1),
    operation: z.string().min(1).optional(),
  }),
  icon: z.string().optional(),
  docsUrl: z.string().url().optional(),
  builtin: z.boolean().optional(),
  runtime: z.enum(['implemented', 'manifest_only']).optional(),
});
export type IntegrationContents = z.infer<typeof integrationContentsSchema>;

export const credentialSlotSchema = z.object({
  key: z.string().min(1),
  service: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().default(true),
  oauthFlow: z.boolean().default(false),
  profile: z.string().optional(),
});
export type CredentialSlot = z.infer<typeof credentialSlotSchema>;

export const agentisPackageContentsSchema = z.object({
  kind: z.literal('agentis'),
  agents: z.array(agentContentsSchema).default([]),
  extensions: z.array(extensionContentsSchema).default([]),
  workflows: z.array(workflowContentsSchema).default([]),
  integrations: z.array(integrationContentsSchema).default([]),
  credentialSlots: z.array(credentialSlotSchema).default([]),
  knowledgeSeeds: z
    .array(
      z.object({
        title: z.string().min(1),
        content: z.string().min(1),
        tags: z.array(z.string()).default([]),
        metadata: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
  entryWorkflowSlug: z.string().optional(),
  // ── Agentic App facets (AGENTIC-APPS-10X §7.2) — the `.agentisapp` payload. ──
  // An `agentis` bundle becomes an App package by carrying its identity, surfaces,
  // and datastore SCHEMAS. Collections ship structure always; `seed` rows are
  // optional and NOT auto-applied on install (empty-with-schema default, §7.2).
  appManifest: appIdentitySchema.partial().optional(),
  surfaces: z.array(upsertSurfaceSchema).default([]),
  collections: z
    .array(
      z.object({
        name: z.string().min(1),
        schema: collectionSchemaSchema,
        seed: z.array(z.record(z.unknown())).default([]),
      }),
    )
    .default([]),
  category: z.string().optional(),
  replaces: z.string().optional(),
  costSavedPerMonth: z.string().optional(),
  readme: z.string().optional(),
  screenshotUrls: z.array(z.string().url()).default([]),
});
export type AgentisPackageContents = z.infer<typeof agentisPackageContentsSchema>;

const agentPackageContentsSchema = z.object({
  kind: z.literal('agent'),
  agent: agentContentsSchema,
});

const workflowPackageContentsSchema = z.object({
  kind: z.literal('workflow'),
  workflow: workflowContentsSchema,
});

const extensionPackageContentsSchema = z.object({
  kind: z.literal('extension'),
  extension: extensionContentsSchema,
});

const integrationPackageContentsSchema = z.object({
  kind: z.literal('integration'),
  integration: integrationContentsSchema,
});

const skillPackageContentsSchema = z.object({
  kind: z.literal('skill'),
  skill: skillContentsSchema,
});

export const packageContentsSchema = z.discriminatedUnion('kind', [
  agentPackageContentsSchema,
  workflowPackageContentsSchema,
  extensionPackageContentsSchema,
  agentisPackageContentsSchema,
  integrationPackageContentsSchema,
  skillPackageContentsSchema,
]);
export type PackageContents = z.infer<typeof packageContentsSchema>;

export const packageManifestSchema = z.object({
  manifestVersion: z.literal(1).default(1),
  agentisVersion: z.string().min(1).default('1.0.0'),
  slug: z.string().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/),
  name: z.string().min(1).max(160),
  version: z.string().min(1).max(64),
  kind: packageKindSchema,
  description: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().min(1).max(64)).default([]),
  contents: packageContentsSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/i),
  source: z.object({ kind: packageKindSchema, id: z.string().min(1) }).nullable().optional(),
  remoteId: z.string().nullable().optional(),
  author: z.object({ id: z.string().optional(), displayName: z.string().optional() }).nullable().optional(),
});
export type PackageManifest = z.infer<typeof packageManifestSchema>;

export const packageExportEnvelopeSchema = z.object({
  packageManifest: packageManifestSchema,
  agentisVersion: z.string().min(1),
  exportedAt: z.string().datetime(),
});
export type PackageExportEnvelope = z.infer<typeof packageExportEnvelopeSchema>;

// ── Workspace bundle (`.agentis`) ───────────────────────────────────────────
//
// A whole-workspace portable bundle: every agent, app, workflow, extension,
// up, share, or sell. It is the workspace-scope superset of the single-app
// `.agentisapp` package — composed from the SAME per-entity schemas, plus an
//
// The **profile** is the safety dimension that distinguishes the three uses, and
// it is STRUCTURAL — what travels is decided here, never by a UI checkbox:
//   - `backup`  → full fidelity (the manifest path is NOT used; see backup.ts).
//   - `share`   → structure + optional sample rows; NEVER secret values; embeddings dropped.
//   - `sell`    → like share + PII/secret scrub gate + signature/licence; NEVER secrets.
export const exportProfileSchema = z.enum(['backup', 'share', 'sell']);
export type ExportProfile = z.infer<typeof exportProfileSchema>;

/**
 * The STRUCTURAL fidelity of a bundle — orthogonal to `profile` (which is the
 * trust/secrets dimension). This decides how much *learned intelligence* travels:
 *   - `shareable` → definitions + structure only (no Brain atoms, no collection
 *                   rows). The legacy behaviour, and the safe default.
 *   - `full`      → ALSO carries Brain atoms (agent + App + workspace), knowledge,
 *                   and collection rows. Embeddings are still recomputed on install
 *                   and secret VALUES still never travel — "full" means full learned
 *                   intelligence, not full secrets (those are `backup`-only).
 * Enforcement is structural (decided in the packager), never a UI checkbox.
 */
export const bundleFidelitySchema = z.enum(['shareable', 'full']);
export type BundleFidelity = z.infer<typeof bundleFidelitySchema>;

/**
 * Granular pick of what to export or import. The SAME shape drives both
 * directions: on export it decides what gets serialized; on import it decides
 * which of the already-serialized items actually get written. A selection can
 * only NARROW within what `fidelity` + `profile` permit (a `shareable` bundle
 * carries no brains even if `includeAgentBrains` is true). `null` id lists mean
 * "all".
 */
export const bundleSelectionSchema = z.object({
  agentIds: z.array(z.string()).nullable().default(null),
  appIds: z.array(z.string()).nullable().default(null),
  includeAgentBrains: z.boolean().default(true),
  includeAppBrains: z.boolean().default(true),
  includeWorkspaceBrain: z.boolean().default(true),
  includeKnowledge: z.boolean().default(true),
  includeCollectionData: z.boolean().default(true),
});
export type BundleSelection = z.infer<typeof bundleSelectionSchema>;

export const bundleAuthorSchema = z.object({
  id: z.string().optional(),
  displayName: z.string().optional(),
});
export type BundleAuthor = z.infer<typeof bundleAuthorSchema>;

/** The portable contents of a whole workspace. Composes the per-entity schemas. */
export const workspaceBundleManifestSchema = z.object({
  /** Workspace-shared specialists/agents. */
  agents: z.array(agentContentsSchema).default([]),
  /** Workspace extensions (never `builtin` — those are host-shipped). */
  extensions: z.array(extensionContentsSchema).default([]),
  /** Bare workflows (no owning App). App workflows live inside `apps[].workflows`. */
  workflows: z.array(workflowContentsSchema).default([]),
  /** Connector/integration definitions (no credential values). */
  integrations: z.array(integrationContentsSchema).default([]),
  /** Self-contained Agentic Apps (identity + policy + surfaces + collections + their workflows). */
  apps: z.array(appManifestSchema).default([]),
  /** Knowledge documents that travel as seeds (embeddings dropped for share/sell). */
  knowledgeSeeds: z
    .array(
      z.object({
        title: z.string().min(1),
        content: z.string().min(1),
        tags: z.array(z.string()).default([]),
        metadata: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
  /** Credential REQUIREMENTS the installer must fill in — never the secret values. */
  credentialSlots: z.array(credentialSlotSchema).default([]),
  /** Workspace-global Brain memory (`scope_id = null`) — carried in full fidelity only. */
  workspaceBrain: portableBrainSchema.optional(),
  /** Self-describing structural fidelity of this bundle. Absent ⇒ legacy `shareable`. */
  fidelity: bundleFidelitySchema.default('shareable'),
  /**
   * Content-shape marker. `2` = may carry learned intelligence (brains/rows).
   * Preview/install branch on FIELD PRESENCE, not this number, so v1 bundles
   * (no marker) install unchanged.
   */
  bundleContentVersion: z.number().int().optional(),
});
export type WorkspaceBundleManifest = z.infer<typeof workspaceBundleManifestSchema>;

/** The serialized `.agentis` envelope: manifest + profile + integrity + provenance. */
export const workspaceBundleEnvelopeSchema = z.object({
  format: z.literal('.agentis'),
  formatVersion: z.literal(1).default(1),
  agentisVersion: z.string().min(1).default('1.0.0'),
  profile: exportProfileSchema,
  /** Structural fidelity (mirrors manifest.fidelity). Absent ⇒ legacy `shareable`. */
  fidelity: bundleFidelitySchema.default('shareable'),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).nullable().optional(),
  manifest: workspaceBundleManifestSchema,
  /** sha256 over the canonical manifest — deserialize rejects on mismatch. */
  checksum: z.string().regex(/^[a-f0-9]{64}$/i),
  exportedAt: z.string().datetime(),
  // Provenance / trust — populated for `sell`.
  author: bundleAuthorSchema.nullable().optional(),
  license: z.string().max(8000).nullable().optional(),
  /** Base64 RSA-SHA256 signature over the canonical manifest (sell only; verified on import). */
  signature: z.string().nullable().optional(),
  /** SPKI PEM public key the signature verifies against — travels with the bundle (self-certifying). */
  signerPublicKeyPem: z.string().nullable().optional(),
});
export type WorkspaceBundleEnvelope = z.infer<typeof workspaceBundleEnvelopeSchema>;

/** Non-mutating install summary shown before a `.agentis` bundle enters a workspace. */
export const workspaceBundlePreviewSchema = z.object({
  format: z.literal('.agentis'),
  formatVersion: z.literal(1),
  profile: exportProfileSchema,
  /** Structural fidelity of the incoming bundle. Absent bundles read as `shareable`. */
  fidelity: bundleFidelitySchema.default('shareable'),
  name: z.string(),
  checksum: z.string(),
  exportedAt: z.string(),
  author: bundleAuthorSchema.nullable(),
  license: z.string().nullable(),
  counts: z.object({
    agents: z.number().int().nonnegative(),
    apps: z.number().int().nonnegative(),
    workflows: z.number().int().nonnegative(),
    extensions: z.number().int().nonnegative(),
    integrations: z.number().int().nonnegative(),
    knowledgeSeeds: z.number().int().nonnegative(),
    credentialSlots: z.number().int().nonnegative(),
    /** Learned intelligence carried (full fidelity only). */
    brainAtoms: z.number().int().nonnegative().default(0),
    collectionRows: z.number().int().nonnegative().default(0),
  }),
  requiredCredentials: z.array(z.object({ key: z.string(), service: z.string(), label: z.string() })).default([]),
  /**
   * First-class "nodes needing setup" — everything the operator must configure
   * before the imported work can run. Surfaced prominently on the import screen.
   */
  setup: z
    .object({
      credentials: z.array(z.object({ key: z.string(), service: z.string(), label: z.string() })).default([]),
      plugins: z.array(z.string()).default([]),
      connections: z.array(z.object({ service: z.string(), reason: z.string() })).default([]),
    })
    .default({ credentials: [], plugins: [], connections: [] }),
  permissions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});
export type WorkspaceBundlePreview = z.infer<typeof workspaceBundlePreviewSchema>;



