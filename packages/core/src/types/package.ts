import { z } from 'zod';
import type { AppGraph } from './appGraph.js';

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

export const datasetSpecSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),
  acceptedFormats: z.array(z.string().min(1)).default([]),
  targetStore: z.enum(['knowledge', 'memory', 'evaluator_examples', 'baseline_inputs']),
  chunkingStrategy: z.enum(['per-row', 'per-document', 'per-function', 'sliding-window', 'semantic']),
  requiredFields: z.array(z.string().min(1)).optional(),
  optional: z.boolean().default(false),
  recommended: z.boolean().default(false),
  wedgeRole: z
    .enum([
      'primary_specialization',
      'performance_booster',
      'compliance_guardrail',
      'historical_context',
      'quality_calibration',
    ])
    .default('historical_context'),
  expectedImpact: z
    .object({
      affects: z
        .array(z.enum(['retrieval', 'routing', 'evaluation', 'output_quality', 'cost_efficiency']))
        .default([]),
      note: z.string().optional(),
    })
    .optional(),
  embeddingHint: z.string().optional(),
  freshnessExpectation: z.enum(['static', 'monthly', 'weekly', 'daily', 'live']).optional(),
  sizeWarningAboveRows: z.number().int().positive().optional(),
  example: z
    .object({
      sampleColumns: z.array(z.string()).optional(),
      exportInstructions: z.string().optional(),
    })
    .optional(),
});
export type DatasetSpec = z.infer<typeof datasetSpecSchema>;

const memorySeedSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  trust: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

const evaluatorExampleSeedSchema = z.object({
  evaluatorKey: z.string().min(1),
  input: z.unknown(),
  expected: z.unknown(),
  verdict: z.enum(['pass', 'fail']),
  reason: z.string().optional(),
  score: z.number().optional(),
});

const runtimeEpisodeSeedSchema = z.object({
  type: z.enum([
    'decision',
    'failure',
    'recovery',
    'success_pattern',
    'approval',
    'evaluator_outcome',
    'incident',
    'artifact_outcome',
    'distilled_lesson',
  ]),
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.string().optional(),
  outcomeStatus: z.enum(['good', 'bad', 'mixed']).optional(),
  importance: z.number().min(0).max(1).optional(),
  trust: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
});

const memoryPolicySchema = z.object({
  minImportanceForPromotion: z.number().min(0).max(1).optional(),
  minTrustForRetrieval: z.number().min(0).max(1).optional(),
  requireHumanConfirmForAgentWrites: z.boolean().optional(),
  highRiskTags: z.array(z.string()).optional(),
  maxEpisodesPerType: z.number().int().nonnegative().optional(),
}).optional();

const retrievalPolicySchema = z.object({
  defaultMode: z.enum(['strict', 'normal', 'exploratory']).optional(),
  defaultBudgetClass: z.enum(['cheap', 'balanced', 'power']).optional(),
  caps: z.object({
    knowledge: z.number().int().nonnegative().optional(),
    episodes: z.number().int().nonnegative().optional(),
    evaluatorExamples: z.number().int().nonnegative().optional(),
    baselineHints: z.number().int().nonnegative().optional(),
  }).optional(),
  includeWorkingSummary: z.boolean().optional(),
}).optional();

// ────────────────────────────────────────────────────────────
// App 5-layer model (AGENTIS-PLATFORM-10X)
// ────────────────────────────────────────────────────────────

/** A single field in an app Data table schema. */
export const appDataFieldSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'date', 'json', 'text']),
  required: z.boolean().optional(),
  description: z.string().optional(),
});
export type AppDataField = z.infer<typeof appDataFieldSchema>;

/** Per-app structured Data table declaration (§Layer 3). */
export const appDataTableSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().optional(),
  schema: z.record(appDataFieldSchema),
  indexes: z
    .array(z.object({ field: z.string().min(1), type: z.enum(['index', 'unique']) }))
    .optional(),
  retention: z
    .object({
      maxRows: z.number().int().positive().optional(),
      ttlDays: z.number().int().positive().optional(),
    })
    .optional(),
});
export type AppDataTable = z.infer<typeof appDataTableSchema>;

/** A REST route exposed by the app's API surface (§Layer 1). */
export const appApiRouteSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  path: z.string().min(1),
  handler: z.enum(['query_data', 'trigger_workflow', 'custom_skill']),
  workflowSlug: z.string().optional(),
  dataTable: z.string().optional(),
  skillSlug: z.string().optional(),
  auth: z.enum(['public', 'api_key', 'bearer', 'none']).default('api_key'),
});
export type AppApiRoute = z.infer<typeof appApiRouteSchema>;

/** App surface declaration (§Layer 1). */
export const appSurfaceSchema = z.object({
  type: z.enum([
    'thread',
    'dashboard',
    'api',
    'webhook_receiver',
    'stream',
    'embed',
    'artifact',
    'page',
  ]),
  label: z.string().optional(),
  description: z.string().optional(),
});
export type AppSurface = z.infer<typeof appSurfaceSchema>;

/** Auto-generated dashboard surface declaration (§Layer 1). */
export const appDashboardSchema = z.object({
  metrics: z
    .array(
      z.object({
        label: z.string().min(1),
        table: z.string().min(1),
        field: z.string().min(1),
        aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max']),
        filter: z.string().optional(),
        timeBucket: z.enum(['today', '7d', '30d', 'all']).optional(),
      }),
    )
    .optional(),
  charts: z
    .array(
      z.object({
        type: z.enum(['line', 'bar', 'pie', 'area']),
        label: z.string().min(1),
        table: z.string().min(1),
        timeField: z.string().optional(),
        valueField: z.string().min(1),
        groupBy: z.string().optional(),
        aggregation: z.enum(['count', 'sum', 'avg']).optional(),
        refreshIntervalSeconds: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  pinnedTables: z.array(z.string()).optional(),
  defaultRefreshIntervalSeconds: z.number().int().positive().optional(),
});
export type AppDashboard = z.infer<typeof appDashboardSchema>;

/**
 * App Brain config — the app's built-in internal agent (§Layer 4).
 * Provisioned automatically on install; invisible in the workspace agent list.
 */
export const appBrainConfigSchema = z.object({
  /** Adapter used to power the Brain agent. */
  adapter: z.string().min(1),
  /** System prompt — the app's goals, rules, and decision logic. */
  systemPrompt: z.string().min(1),
  /** Entry workflows the Brain can invoke by slug. */
  entryWorkflows: z.array(z.string().min(1)).default([]),
  /** Max concurrent domain workflows the Brain can orchestrate. */
  maxConcurrentDomains: z.number().int().positive().optional(),
});
export type AppBrainConfig = z.infer<typeof appBrainConfigSchema>;

/** Deploy layer config (§Layer 5). */
export const appDeployConfigSchema = z.object({
  target: z.enum(['local', 'always_on', 'scheduled', 'api_server']).default('local'),
  apiServer: z
    .object({
      auth: z.enum(['api_key', 'jwt', 'public']).default('api_key'),
      cors: z.boolean().optional(),
      rateLimit: z.object({ requestsPerMinute: z.number().int().positive() }).optional(),
    })
    .optional(),
  restartPolicy: z.enum(['always', 'on_failure', 'never']).optional(),
  resources: z
    .object({
      maxConcurrentRuns: z.number().int().positive().optional(),
      priorityClass: z.enum(['low', 'normal', 'high']).optional(),
    })
    .optional(),
});
export type AppDeployConfig = z.infer<typeof appDeployConfigSchema>;

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
  datasetSpecs: z.array(datasetSpecSchema).default([]),
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
  memorySeeds: z.array(memorySeedSchema).default([]),
  evaluatorRubrics: z
    .array(
      z.object({
        nodeKind: z.string().min(1),
        context: z.string().min(1),
        examples: z.array(evaluatorExampleSeedSchema).default([]),
      }),
    )
    .default([]),
  evaluatorExampleSeeds: z.array(evaluatorExampleSeedSchema).default([]),
  workflowBaselines: z
    .array(
      z.object({
        workflowSlug: z.string().min(1),
        p50DurationMs: z.number().nonnegative().optional(),
        p95DurationMs: z.number().nonnegative().optional(),
        expectedSuccessRate: z.number().min(0).max(1).optional(),
        costCentsPerRun: z.number().nonnegative().optional(),
        derivedFromRuns: z.number().int().nonnegative().optional(),
      }),
    )
    .default([]),
  runtimeEpisodeSeeds: z.array(runtimeEpisodeSeedSchema).default([]),
  memoryPolicy: memoryPolicySchema,
  retrievalPolicy: retrievalPolicySchema,
  appGraphTemplate: z.custom<AppGraph>().optional(),
  entryWorkflowSlug: z.string().optional(),
  category: z.string().optional(),
  intendedBehavior: z.string().max(8000).nullable().optional(),
  replaces: z.string().optional(),
  costSavedPerMonth: z.string().optional(),
  readme: z.string().optional(),
  screenshotUrls: z.array(z.string().url()).default([]),
  crossAppDependencies: z.array(z.string()).default([]),
  // ── 5-layer app model (AGENTIS-PLATFORM-10X) ──────────────────────────
  // Optional so existing package literals stay valid; consumers default to [].
  /** The app's operational Data layer schema (§Layer 3 / §A6). */
  dataTables: z.array(appDataTableSchema).optional(),
  /** Surfaces the app exposes to the world (§Layer 1 / §A6). */
  surfaces: z.array(appSurfaceSchema).optional(),
  /** REST routes for `api` surfaces (§A6). */
  apiRoutes: z.array(appApiRouteSchema).optional(),
  /** Default deploy target for the app (§Layer 5 / §A6). */
  deployConfig: appDeployConfigSchema.optional(),
  /** Auto-generated dashboard declaration (§Layer 1). */
  dashboard: appDashboardSchema.optional(),
  /** Composed sub-app slugs installed as dependencies (§A10). */
  subApps: z.array(z.string()).optional(),
  /** Number of new Data records before the Brain absorbs patterns (§Layer 4). */
  brainAbsorptionThreshold: z.number().int().positive().optional(),
  /** App Brain configuration — the built-in internal agent (§Layer 4). */
  appBrain: appBrainConfigSchema.optional(),
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
