/**
 * /v1/packages — agent package CRUD + install-from-local-manifest.
 *
 * V1-SPEC §11. Registry-installed packages persist to
 * `installed_registry_artifacts` via /v1/skills/registry/install; this route
 * handles **local** packages (e.g. a developer authoring a package on disk
 * and installing it without going through the registry) and lists/get/delete
 * of installed packages regardless of source.
 *
 * Installing a package fans out into:
 *   - one `agent_packages` row,
 *   - one `skills` row per declared skill,
 *   - one `agents` row per declared agent (in `offline` state until the
 *     operator binds credentials),
 *   - one `workflows` row per declared template (graph copied verbatim).
 *
 * Skills declared inside a local package are forced to `node_worker` runtime
 * unless the manifest explicitly declares `builtin` (rejected for local
 * packages — only Nexseed-shipped builtins are trusted).
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const skillDefSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  version: z.string().min(1),
  runtime: z.enum(['builtin', 'node_worker', 'docker_sandbox']),
  entrypoint: z.string(),
  capabilityTags: z.array(z.string()).default([]),
  inputSchema: z.record(z.unknown()).default({}),
  outputSchema: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().positive().max(CONSTANTS.SKILL_EXECUTION_MAX_TIMEOUT_MS).optional(),
});

const agentDefSchema = z.object({
  name: z.string().min(1),
  adapterType: z.enum(['openclaw', 'claude_code', 'http']),
  capabilityTags: z.array(z.string()).default([]),
  defaultConfig: z.record(z.unknown()).default({}),
});

const templateDefSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  summary: z.string().default(''),
  graph: z.object({
    version: z.literal(1),
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
  }),
  variables: z.array(z.unknown()).default([]),
});

// ── Wedge schemas (Agentis 1.1) ────────────────────────────────────
// docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §16

const datasetSpecSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  acceptedFormats: z.array(z.string()),
  targetStore: z.enum(['knowledge', 'memory', 'evaluator_examples', 'baseline_inputs']),
  chunkingStrategy: z.enum([
    'per-row',
    'per-document',
    'per-function',
    'sliding-window',
    'semantic',
  ]),
  requiredFields: z.array(z.string()).optional(),
  optional: z.boolean().default(false),
  recommended: z.boolean().optional(),
  wedgeRole: z.enum([
    'primary_specialization',
    'performance_booster',
    'compliance_guardrail',
    'historical_context',
    'quality_calibration',
  ]),
  expectedImpact: z
    .object({
      affects: z.array(
        z.enum(['retrieval', 'routing', 'evaluation', 'output_quality', 'cost_efficiency']),
      ),
      note: z.string().optional(),
    })
    .optional(),
  embeddingHint: z.string().optional(),
  freshnessExpectation: z.enum(['static', 'monthly', 'weekly', 'daily', 'live']).optional(),
  sizeWarningAboveRows: z.number().optional(),
  example: z
    .object({
      sampleColumns: z.array(z.string()).optional(),
      exportInstructions: z.string().optional(),
    })
    .optional(),
});

const knowledgeSeedSchema = z.object({
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const memorySeedSchema = z.object({
  title: z.string(),
  content: z.string(),
  trust: z.number().optional(),
  importance: z.number().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const evaluatorExampleSeedSchema = z.object({
  evaluatorKey: z.string(),
  input: z.unknown(),
  expected: z.unknown(),
  verdict: z.enum(['pass', 'fail']),
  reason: z.string().optional(),
  score: z.number().optional(),
});

const evaluatorRubricSchema = z.object({
  nodeKind: z.string(),
  context: z.string(),
  examples: z.array(evaluatorExampleSeedSchema).default([]),
});

const workflowBaselineSeedSchema = z.object({
  workflowSlug: z.string(),
  p50DurationMs: z.number().optional(),
  p95DurationMs: z.number().optional(),
  expectedSuccessRate: z.number().optional(),
  costCentsPerRun: z.number().optional(),
  derivedFromRuns: z.number().optional(),
});

// Memory Architecture seeds (docs/memory/MEMORY-ARCHITECTURE.md §13.2).
// Distinct from `memorySeeds` (which seed the wedge `app_memory` table —
// typed knowledge: facts/preferences/rules). These seed `memory_episodes`,
// the durable execution-lesson layer.

// Memory policy config (docs/memory/MEMORY-ARCHITECTURE.md §13.2).
// Controls promotion and trust behaviour for this app.
const memoryPolicySchema = z.object({
  /** Minimum importance score (0..1) for automatic promotion. Default 0.5. */
  minImportanceForPromotion: z.number().min(0).max(1).optional(),
  /** Minimum trust score (0..1) accepted for retrieval in 'normal' mode. Default 0.4. */
  minTrustForRetrieval: z.number().min(0).max(1).optional(),
  /**
   * Whether agent-written episodes require human confirmation before being
   * promoted. Default false (agent writes go through standard trust policy).
   */
  requireHumanConfirmForAgentWrites: z.boolean().optional(),
  /** Tags that mark a memory as high-risk, triggering mandatory human review. */
  highRiskTags: z.array(z.string()).optional(),
  /** Max episodes retained per type before oldest are archived. 0 = unlimited. */
  maxEpisodesPerType: z.number().int().nonnegative().optional(),
}).optional();

// Retrieval policy config (docs/memory/MEMORY-ARCHITECTURE.md §9, §13.2).
// Sets the default retrieval parameters when this app calls buildContext().
const retrievalPolicySchema = z.object({
  /** Default injection mode. Default 'normal'. */
  defaultMode: z.enum(['strict', 'normal', 'exploratory']).optional(),
  /** Default token budget class. Default 'balanced'. */
  defaultBudgetClass: z.enum(['cheap', 'balanced', 'power']).optional(),
  /** Override caps per layer. */
  caps: z.object({
    knowledge: z.number().int().nonnegative().optional(),
    episodes: z.number().int().nonnegative().optional(),
    evaluatorExamples: z.number().int().nonnegative().optional(),
    baselineHints: z.number().int().nonnegative().optional(),
  }).optional(),
  /** Whether to include working memory summary by default. Default true. */
  includeWorkingSummary: z.boolean().optional(),
}).optional();

const runtimeEpisodeSeedSchema = z.object({
  type: z.enum([
    'decision','failure','recovery','success_pattern','approval',
    'evaluator_outcome','incident','artifact_outcome','distilled_lesson',
  ]),
  title: z.string().min(1),
  summary: z.string().min(1),
  details: z.string().optional(),
  outcomeStatus: z.enum(['good','bad','mixed']).optional(),
  importance: z.number().min(0).max(1).optional(),
  trust: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
});

// App Canvas template (docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §12.3).
// Carried with the package; copied to `appInstance.appGraph` on activation.
const appGraphNodeTypeSchema = z.enum([
  'app_core',
  'entry_workflow',
  'workflow_module',
  'agent_group',
  'knowledge_source',
  'memory_surface',
  'integration_surface',
  'approval_surface',
  'output_surface',
  'scheduler',
  'channel_surface',
  'brain_surface',
]);
const appGraphEdgeTypeSchema = z.enum([
  'activates',
  'feeds',
  'reads_from',
  'writes_to',
  'approves',
  'publishes_to',
  'observes',
  'depends_on',
]);
const appGraphSchema = z.object({
  version: z.literal(1),
  nodes: z.array(z.object({
    id: z.string().min(1),
    type: appGraphNodeTypeSchema,
    title: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }),
    config: z.record(z.unknown()).default({}),
    zone: z.enum(['inputs', 'core', 'outputs']).optional(),
  })).default([]),
  edges: z.array(z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    type: appGraphEdgeTypeSchema,
    label: z.string().optional(),
  })).default([]),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).default({ x: 0, y: 0, zoom: 1 }),
});

const manifestSchema = z.object({
  manifestVersion: z.literal(1),
  name: z.string().min(1),
  version: z.string().min(1),
  summary: z.string().default(''),
  agents: z.array(agentDefSchema).default([]),
  skills: z.array(skillDefSchema).default([]),
  workflowTemplates: z.array(templateDefSchema).default([]),
  credentials: z.array(z.unknown()).default([]),
  // Wedge fields (all optional; absent = empty arrays)
  datasetSpecs: z.array(datasetSpecSchema).default([]),
  knowledgeSeeds: z.array(knowledgeSeedSchema).default([]),
  memorySeeds: z.array(memorySeedSchema).default([]),
  evaluatorRubrics: z.array(evaluatorRubricSchema).default([]),
  evaluatorExampleSeeds: z.array(evaluatorExampleSeedSchema).default([]),
  workflowBaselines: z.array(workflowBaselineSeedSchema).default([]),
  // Memory Architecture fields (Memory OS §13.2)
  runtimeEpisodeSeeds: z.array(runtimeEpisodeSeedSchema).default([]),
  // Memory and retrieval policy configuration (Memory OS §13.2).
  // Both are optional — absent means "use platform defaults".
  memoryPolicy: memoryPolicySchema,
  retrievalPolicy: retrievalPolicySchema,
  // App Canvas template (App Canvas §12.3).
  // Optional — when present, copied to `agent_packages.app_graph` on install.
  appGraphTemplate: appGraphSchema.optional(),
});

const installLocalSchema = z.object({
  manifest: manifestSchema,
  permissionsAcknowledged: z.literal(true, {
    errorMap: () => ({ message: 'permissionsAcknowledged must be true' }),
  }),
});

export interface PackageRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  /** Optional — when present, package install seeds the wedge stores. */
  activation?: import('../services/appActivation.js').AppActivation;
}

export function buildPackageRoutes(deps: PackageRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.agentPackages)
      .where(eq(schema.agentPackages.workspaceId, ws.workspaceId))
      .all();
    return c.json({ packages: rows });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const pkg = deps.db
      .select()
      .from(schema.agentPackages)
      .where(and(eq(schema.agentPackages.id, id), eq(schema.agentPackages.workspaceId, ws.workspaceId)))
      .get();
    if (!pkg) throw new AgentisError('RESOURCE_NOT_FOUND', 'package not found');
    const skills = deps.db.select().from(schema.skills).where(eq(schema.skills.packageId, id)).all();
    const agents = deps.db.select().from(schema.agents).where(eq(schema.agents.packageId, id)).all();
    return c.json({ package: pkg, skills, agents });
  });

  app.post('/install-local', async (c) => {
    const ws = getWorkspace(c);
    const body = installLocalSchema.parse(await c.req.json());
    const m = body.manifest;

    // V1 trust rule (§9.2): local install cannot ship `builtin`.
    for (const s of m.skills) {
      if (s.runtime === 'builtin') {
        throw new AgentisError(
          'VALIDATION_FAILED',
          `skill ${s.slug}: builtin runtime is reserved for Nexseed-shipped skills`,
        );
      }
    }

    const packageId = randomUUID();
    // App Canvas: when the manifest ships an appGraphTemplate, copy it into
    // the instance `app_graph` column on activation (§7.1, §12.4). The
    // instance copy is mutable; the template stays read-only inside the
    // manifest for export/import coherence.
    const appGraphInstance = m.appGraphTemplate
      ? structuredClone(m.appGraphTemplate)
      : null;
    deps.db
      .insert(schema.agentPackages)
      .values({
        id: packageId,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: ws.user.id,
        registryEntryId: null,
        name: m.name,
        version: m.version,
        manifest: m,
        appGraph: appGraphInstance as unknown as object | null,
      })
      .run();

    const createdSkills: { id: string; slug: string }[] = [];
    for (const s of m.skills) {
      const id = randomUUID();
      deps.db
        .insert(schema.skills)
        .values({
          id,
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          packageId,
          name: s.name,
          slug: s.slug,
          version: s.version,
          runtime: s.runtime,
          manifest: s,
        })
        .run();
      createdSkills.push({ id, slug: s.slug });
    }

    const createdAgents: { id: string; name: string }[] = [];
    for (const a of m.agents) {
      const id = randomUUID();
      const colorHex = CONSTANTS.AGENT_COLOR_PALETTE[Math.floor(Math.random() * CONSTANTS.AGENT_COLOR_PALETTE.length)];
      deps.db
        .insert(schema.agents)
        .values({
          id,
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          gatewayId: null,
          packageId,
          name: a.name,
          adapterType: a.adapterType,
          capabilityTags: a.capabilityTags,
          config: a.defaultConfig,
          status: 'offline',
          colorHex,
        })
        .run();
      createdAgents.push({ id, name: a.name });
    }

    const createdWorkflows: { id: string; title: string }[] = [];
    for (const tpl of m.workflowTemplates) {
      const id = randomUUID();
      deps.db
        .insert(schema.workflows)
        .values({
          id,
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          registryEntryId: null,
          registryVersion: null,
          title: tpl.name,
          summary: tpl.summary,
          graph: tpl.graph,
          settings: {},
          isFromRegistry: false,
        })
        .run();
      createdWorkflows.push({ id, title: tpl.name });
    }

    // ── App Knowledge Wedge activation (Agentis 1.1) ──────────────
    // Seeds knowledge, memory, evaluator examples, and baselines into the
    // runtime stores. Idempotent — re-installing the same package replaces
    // seeded intelligence but preserves operator/promotion data.
    let activation: {
      knowledgeChunksCreated: number;
      memoryEpisodesCreated: number;
      evaluatorExamplesCreated: number;
      workflowBaselinesCreated: number;
      runtimeEpisodesCreated?: number;
    } | null = null;
    if (deps.activation) {
      const slugToId: Record<string, string> = {};
      for (let i = 0; i < m.workflowTemplates.length; i++) {
        const tpl = m.workflowTemplates[i]!;
        const created = createdWorkflows[i];
        if (created) slugToId[tpl.slug] = created.id;
      }
      // Zod's `z.unknown()` infers as optional even when the validator
      // accepts any value at runtime. The wedge types declare these fields
      // as required `unknown` — cast through `unknown` to bridge the
      // inference gap. The schema has already validated the runtime shape.
      const result = deps.activation.activate({
        workspaceId: ws.workspaceId,
        appId: packageId,
        packageVersion: m.version,
        contents: {
          datasetSpecs: m.datasetSpecs as Parameters<typeof deps.activation.activate>[0]['contents']['datasetSpecs'],
          knowledgeSeeds: m.knowledgeSeeds,
          memorySeeds: m.memorySeeds,
          evaluatorRubrics: m.evaluatorRubrics as unknown as Parameters<typeof deps.activation.activate>[0]['contents']['evaluatorRubrics'],
          evaluatorExampleSeeds: m.evaluatorExampleSeeds as unknown as Parameters<typeof deps.activation.activate>[0]['contents']['evaluatorExampleSeeds'],
          workflowBaselines: m.workflowBaselines,
          // Memory OS — runtime episode seeds (§13.2).
          runtimeEpisodeSeeds: m.runtimeEpisodeSeeds,
        },
        workflowSlugToId: slugToId,
      });
      activation = {
        knowledgeChunksCreated: result.knowledgeChunksCreated,
        memoryEpisodesCreated: result.memoryEpisodesCreated,
        evaluatorExamplesCreated: result.evaluatorExamplesCreated,
        workflowBaselinesCreated: result.workflowBaselinesCreated,
        runtimeEpisodesCreated: result.runtimeEpisodesCreated,
      };
    }

    return c.json(
      {
        packageId,
        name: m.name,
        version: m.version,
        skills: createdSkills,
        agents: createdAgents,
        workflows: createdWorkflows,
        activation,
      },
      201,
    );
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    // Cascade: NULL out skills.packageId and agents.packageId — keep them so
    // the operator can decide what to do with their bound credentials.
    const result = deps.db
      .delete(schema.agentPackages)
      .where(and(eq(schema.agentPackages.id, id), eq(schema.agentPackages.workspaceId, ws.workspaceId)))
      .run();
    if (result.changes === 0) throw new AgentisError('RESOURCE_NOT_FOUND', 'package not found');
    // Detach seeded wedge intelligence. Operator + promoted patterns survive
    // until the operator deletes them explicitly through /v1/apps.
    if (deps.activation) {
      deps.activation.detachSeeds(ws.workspaceId, id);
    }
    return c.json({ ok: true });
  });

  return app;
}
