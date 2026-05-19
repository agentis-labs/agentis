import { z } from 'zod';

export const packageKindSchema = z.enum(['agent', 'workflow', 'skill', 'agentis', 'integration']);
export type PackageKind = z.infer<typeof packageKindSchema>;

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
});
export type AgentContents = z.infer<typeof agentContentsSchema>;

export const workflowContentsSchema = z.object({
  slug: z.string().min(1).optional(),
  title: z.string().min(1),
  summary: z.string().nullable().optional(),
  intendedBehavior: z.string().max(8000).nullable().optional(),
  graph: z.unknown(),
  settings: z.record(z.unknown()).default({}),
  maxConcurrentRuns: z.number().int().positive().nullable().optional(),
  concurrencyOverflow: z.enum(['queue', 'reject', 'replace_oldest']).nullable().optional(),
});
export type WorkflowContents = z.infer<typeof workflowContentsSchema>;

export const skillContentsSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  version: z.string().min(1),
  runtime: z.enum(['builtin', 'node_worker', 'docker_sandbox']),
  manifest: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    version: z.string().min(1),
    runtime: z.enum(['builtin', 'node_worker', 'docker_sandbox']),
    entrypoint: z.string().min(1),
    capabilityTags: z.array(z.string()).default([]),
    inputSchema: z.record(z.unknown()).default({}),
    outputSchema: z.record(z.unknown()).default({}),
    timeoutMs: z.number().int().positive().optional(),
    allowedDomains: z.array(z.string()).optional(),
    source: z.string().optional(),
    bundleDir: z.string().optional(),
  }),
});
export type SkillContents = z.infer<typeof skillContentsSchema>;

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
  skills: z.array(skillContentsSchema).default([]),
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
  category: z.string().optional(),
  intendedBehavior: z.string().max(8000).nullable().optional(),
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

const skillPackageContentsSchema = z.object({
  kind: z.literal('skill'),
  skill: skillContentsSchema,
});

const integrationPackageContentsSchema = z.object({
  kind: z.literal('integration'),
  integration: integrationContentsSchema,
});

export const packageContentsSchema = z.discriminatedUnion('kind', [
  agentPackageContentsSchema,
  workflowPackageContentsSchema,
  skillPackageContentsSchema,
  agentisPackageContentsSchema,
  integrationPackageContentsSchema,
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
