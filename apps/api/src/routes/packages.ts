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

import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS } from '@agentis/core';
import type { AgentisPackageContents, AppGraph, PackageContents, PackageManifest } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { AppActivation } from '../services/appActivation.js';
import type { AppDataService } from '../services/appDataService.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { PackagerService } from '../services/packager.js';

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
  adapterType: z.enum(['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'http']),
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

const datasetSpecSchema = z.object({
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
  wedgeRole: z.enum([
    'primary_specialization',
    'performance_booster',
    'compliance_guardrail',
    'historical_context',
    'quality_calibration',
  ]).default('historical_context'),
  expectedImpact: z.object({
    affects: z.array(z.enum(['retrieval', 'routing', 'evaluation', 'output_quality', 'cost_efficiency'])).default([]),
    note: z.string().optional(),
  }).optional(),
  embeddingHint: z.string().optional(),
  freshnessExpectation: z.enum(['static', 'monthly', 'weekly', 'daily', 'live']).optional(),
  sizeWarningAboveRows: z.number().int().positive().optional(),
  example: z.object({
    sampleColumns: z.array(z.string()).optional(),
    exportInstructions: z.string().optional(),
  }).optional(),
});

const knowledgeSeedSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

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

const evaluatorRubricSchema = z.object({
  nodeKind: z.string().min(1),
  context: z.string().min(1),
  examples: z.array(evaluatorExampleSeedSchema).default([]),
});

const workflowBaselineSeedSchema = z.object({
  workflowSlug: z.string().min(1),
  p50DurationMs: z.number().optional(),
  p95DurationMs: z.number().optional(),
  expectedSuccessRate: z.number().optional(),
  costCentsPerRun: z.number().optional(),
  derivedFromRuns: z.number().int().nonnegative().optional(),
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
  datasetSpecs: z.array(datasetSpecSchema).default([]),
  knowledgeSeeds: z.array(knowledgeSeedSchema).default([]),
  memorySeeds: z.array(memorySeedSchema).default([]),
  evaluatorRubrics: z.array(evaluatorRubricSchema).default([]),
  evaluatorExampleSeeds: z.array(evaluatorExampleSeedSchema).default([]),
  workflowBaselines: z.array(workflowBaselineSeedSchema).default([]),
  runtimeEpisodeSeeds: z.array(runtimeEpisodeSeedSchema).default([]),
  memoryPolicy: memoryPolicySchema,
  retrievalPolicy: retrievalPolicySchema,
  appGraphTemplate: appGraphSchema.optional(),
}).passthrough();

const installLocalSchema = z.object({
  manifest: manifestSchema,
  permissionsAcknowledged: z.literal(true, {
    errorMap: () => ({ message: 'permissionsAcknowledged must be true' }),
  }),
});

const createPackageSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  version: z.string().min(1).default('1.0.0'),
  kind: z.enum(['workflow', 'agent', 'skill', 'app']).default('workflow'),
  description: z.string().default(''),
  workflowIds: z.array(z.string()).default([]),
  agentIds: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
});

const packMetaSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export function buildPackageRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus?: EventBus;
  activation?: AppActivation;
  appData?: AppDataService;
  logger?: Logger;
}) {
  const app = new Hono();
  const packager = new PackagerService({
    db: deps.db,
    bus: deps.bus,
    appData: deps.appData,
    logger: deps.logger,
  });
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  function scope(c: Context) {
    const ws = getWorkspace(c);
    return { workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id };
  }

  function toPackageDto(row: typeof schema.libraryPackages.$inferSelect) {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      kind: (row.kind === 'agentis' ? 'app' : row.kind) as 'app' | 'workflow' | 'agent' | 'skill' | 'integration',
      version: row.version,
      description: row.description ?? '',
      isTemplate: false,
    };
  }

  function isSupportedPackageRow(row: typeof schema.libraryPackages.$inferSelect) {
    return row.kind === 'agentis'
      || row.kind === 'workflow'
      || row.kind === 'agent'
      || row.kind === 'skill'
      || row.kind === 'integration';
  }

  // ── List ───────────────────────────────────────────────────────────────────
  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = packager.list({ workspaceId: ws.workspaceId });
    return c.json({ packages: rows.filter(isSupportedPackageRow).map(toPackageDto) });
  });

  // ── Compatibility pack shortcuts ──────────────────────────────────────────
  app.post('/pack/workflow/:workflowId', async (c) => {
    const row = packager.packFromWorkflow(
      scope(c),
      c.req.param('workflowId'),
      packMetaSchema.parse(await c.req.json().catch(() => ({}))),
    );
    return c.json({ package: { ...toPackageDto(row), checksum: row.checksum } }, 201);
  });

  app.post('/pack/agent/:agentId', async (c) => {
    const row = packager.packFromAgent(
      scope(c),
      c.req.param('agentId'),
      packMetaSchema.parse(await c.req.json().catch(() => ({}))),
    );
    return c.json({ package: { ...toPackageDto(row), checksum: row.checksum } }, 201);
  });

  app.post('/pack/skill/:skillId', async (c) => {
    const row = packager.packFromSkill(
      scope(c),
      c.req.param('skillId'),
      packMetaSchema.parse(await c.req.json().catch(() => ({}))),
    );
    return c.json({ package: { ...toPackageDto(row), checksum: row.checksum } }, 201);
  });

  app.get('/:id/export', (c) => {
    const ws = getWorkspace(c);
    const row = packager.get(c.req.param('id'), ws.workspaceId);
    if (!isSupportedPackageRow(row)) {
      throw new AgentisError('VALIDATION_FAILED', 'knowledge packages are temporarily disabled');
    }
    return c.json(packager.exportEnvelope(c.req.param('id'), ws.workspaceId));
  });

  app.post('/:id/use', (c) => {
    const ws = getWorkspace(c);
    const row = packager.get(c.req.param('id'), ws.workspaceId);
    if (!isSupportedPackageRow(row)) {
      throw new AgentisError('VALIDATION_FAILED', 'knowledge packages are temporarily disabled');
    }
    const result = packager.usePackage(scope(c), c.req.param('id'));
    return c.json(result, 201);
  });

  // ── Get one ────────────────────────────────────────────────────────────────
  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');

    const libRow = packager.get(id, ws.workspaceId);
    if (!isSupportedPackageRow(libRow)) {
      throw new AgentisError('VALIDATION_FAILED', 'knowledge packages are temporarily disabled');
    }
    const contents = libRow.contents as PackageContents;
    const manifest = packager.manifestFromRow(libRow);
    const pkgDto = toPackageDto(libRow);

    let workflows: { id: string; title: string }[] = [];
    let agents: { id: string; name: string; status: string; adapterType: string }[] = [];
    let skills: { id: string; name: string; slug: string; version: string; runtime: string }[] = [];

    if (contents.kind === 'workflow') {
      workflows = [{ id: libRow.sourceId ?? '', title: contents.workflow.title }];
    } else if (contents.kind === 'agent') {
      agents = [{ id: libRow.sourceId ?? '', name: contents.agent.name, status: 'offline', adapterType: contents.agent.adapterType }];
    } else if (contents.kind === 'skill') {
      skills = [{ id: libRow.sourceId ?? '', name: contents.skill.name, slug: contents.skill.slug, version: contents.skill.version, runtime: contents.skill.runtime }];
    } else if (contents.kind === 'agentis') {
      workflows = contents.workflows.map((w, i) => ({ id: `pkg:${i}`, title: w.title }));
      agents = contents.agents.map((a, i) => ({ id: `pkg:${i}`, name: a.name, status: 'offline', adapterType: a.adapterType }));
      skills = contents.skills.map((s, i) => ({ id: `pkg:${i}`, name: s.name, slug: s.slug, version: s.version, runtime: s.runtime }));
    }

    return c.json({ package: { ...pkgDto, installedAt: libRow.createdAt, manifest }, workflows, agents, skills });
  });

  // ── Create ─────────────────────────────────────────────────────────────────
  app.post('/', async (c) => {
    const s = scope(c);
    const ws = getWorkspace(c);
    const body = createPackageSchema.parse(await c.req.json());
    const meta = { name: body.name, slug: body.slug, version: body.version, description: body.description };

    // Single-resource shortcuts → typed packager methods
    if (body.kind === 'workflow' && body.workflowIds.length === 1 && !body.agentIds.length && !body.skillIds.length) {
      const row = packager.packFromWorkflow(s, body.workflowIds[0]!, meta);
      return c.json(toPackageDto(row), 201);
    }
    if (body.kind === 'agent' && body.agentIds.length === 1 && !body.workflowIds.length && !body.skillIds.length) {
      const row = packager.packFromAgent(s, body.agentIds[0]!, meta);
      return c.json(toPackageDto(row), 201);
    }
    if (body.kind === 'skill' && body.skillIds.length === 1 && !body.workflowIds.length && !body.agentIds.length) {
      const row = packager.packFromSkill(s, body.skillIds[0]!, meta);
      return c.json(toPackageDto(row), 201);
    }
    // App bundle / multi-resource → agentis package with snapshotted contents
    const workflows = body.workflowIds.length > 0
      ? deps.db.select().from(schema.workflows)
          .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), inArray(schema.workflows.id, body.workflowIds)))
          .all()
      : [];
    const agents = body.agentIds.length > 0
      ? deps.db.select().from(schema.agents)
          .where(and(eq(schema.agents.workspaceId, ws.workspaceId), inArray(schema.agents.id, body.agentIds)))
          .all()
      : [];
    const skills = body.skillIds.length > 0
      ? deps.db.select().from(schema.skills)
          .where(and(eq(schema.skills.workspaceId, ws.workspaceId), inArray(schema.skills.id, body.skillIds)))
          .all()
      : [];

    const contents: AgentisPackageContents = {
      kind: 'agentis',
      agents: agents.map((a) => ({
        name: a.name,
        adapterType: a.adapterType,
        capabilityTags: (a.capabilityTags as string[]) ?? [],
        config: (a.config as Record<string, unknown>) ?? {},
        instructions: a.instructions ?? null,
        avatarGlyph: a.avatarGlyph ?? null,
        runtimeModel: a.runtimeModel ?? null,
        role: a.role ?? null,
      })),
      workflows: workflows.map((w) => ({
        slug: w.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        title: w.title,
        summary: w.summary ?? null,
        graph: w.graph,
        settings: (w.settings as Record<string, unknown>) ?? {},
        maxConcurrentRuns: w.maxConcurrentRuns ?? null,
        concurrencyOverflow: (w.concurrencyOverflow as 'queue' | 'reject' | 'replace_oldest' | null | undefined),
      })),
      skills: skills.map((s) => {
        const sm = (s.manifest as Record<string, unknown>) ?? {};
        return {
          name: s.name, slug: s.slug, version: s.version,
          runtime: s.runtime as 'builtin' | 'node_worker' | 'docker_sandbox',
          manifest: {
            name: s.name, slug: s.slug, version: s.version,
            runtime: s.runtime as 'builtin' | 'node_worker' | 'docker_sandbox',
            entrypoint: (sm['entrypoint'] as string) ?? '',
            capabilityTags: (sm['capabilityTags'] as string[]) ?? [],
            inputSchema: (sm['inputSchema'] as Record<string, unknown>) ?? {},
            outputSchema: (sm['outputSchema'] as Record<string, unknown>) ?? {},
            timeoutMs: sm['timeoutMs'] as number | undefined,
          },
        };
      }),
      integrations: [], credentialSlots: [], datasetSpecs: [],
      knowledgeSeeds: [], memorySeeds: [], evaluatorRubrics: [],
      evaluatorExampleSeeds: [], runtimeEpisodeSeeds: [],
      workflowBaselines: [],
      screenshotUrls: [], crossAppDependencies: [],
    };

    const row = packager.create(s, meta, 'agentis', contents);
    return c.json(toPackageDto(row), 201);
  });

  // ── Import a PackageManifest (exported via exportEnvelope / drawerExport) ──
  app.post('/import', async (c) => {
    const s = scope(c);
    const body = (await c.req.json()) as { manifest?: PackageManifest; packageManifest?: PackageManifest } | PackageManifest;
    const manifest = 'manifest' in body && body.manifest
      ? body.manifest
      : 'packageManifest' in body && body.packageManifest
        ? body.packageManifest
        : body;
    if (!manifest || typeof manifest !== 'object' || !('contents' in manifest)) {
      throw new AgentisError('VALIDATION_FAILED', 'manifest is required');
    }
    const result = packager.importManifest(s, manifest as PackageManifest);
    const row = packager.get(result.packageId, s.workspaceId);
    return c.json({ ...toPackageDto(row), warnings: result.warnings }, 201);
  });

  // ── Duplicate a package by ID ───────────────────────────────────────────────
  app.post('/:id/duplicate', (c) => {
    const ws = getWorkspace(c);
    const s = scope(c);
    const id = c.req.param('id');
    const src = packager.get(id, ws.workspaceId);
    const contents = src.contents as PackageContents;
    const row = packager.create(
      s,
      { name: `Copy of ${src.name}`, version: src.version, description: src.description ?? undefined },
      src.kind as Parameters<typeof packager.create>[2],
      contents,
    );
    return c.json(toPackageDto(row), 201);
  });

  app.post('/install-local', async (c) => {
    const s = scope(c);
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

    const contents: AgentisPackageContents = {
      kind: 'agentis',
      agents: m.agents.map((agent) => ({
        name: agent.name,
        adapterType: agent.adapterType,
        capabilityTags: agent.capabilityTags,
        config: agent.defaultConfig,
        role: 'agent',
      })),
      skills: m.skills.map((skill) => ({
        name: skill.name,
        slug: skill.slug,
        version: skill.version,
        runtime: skill.runtime,
        manifest: {
          name: skill.name,
          slug: skill.slug,
          version: skill.version,
          runtime: skill.runtime,
          entrypoint: skill.entrypoint,
          capabilityTags: skill.capabilityTags,
          inputSchema: skill.inputSchema,
          outputSchema: skill.outputSchema,
          timeoutMs: skill.timeoutMs,
        },
      })),
      workflows: m.workflowTemplates.map((tpl) => ({
        slug: tpl.slug,
        title: tpl.name,
        summary: tpl.summary,
        graph: tpl.graph,
        settings: { variables: tpl.variables },
      })),
      integrations: [],
      credentialSlots: [],
      datasetSpecs: m.datasetSpecs,
      knowledgeSeeds: m.knowledgeSeeds,
      memorySeeds: m.memorySeeds,
      evaluatorRubrics: m.evaluatorRubrics,
      evaluatorExampleSeeds: m.evaluatorExampleSeeds,
      workflowBaselines: m.workflowBaselines,
      runtimeEpisodeSeeds: m.runtimeEpisodeSeeds,
      memoryPolicy: m.memoryPolicy,
      retrievalPolicy: m.retrievalPolicy,
      appGraphTemplate: m.appGraphTemplate as AppGraph | undefined,
      screenshotUrls: [],
      crossAppDependencies: [],
    };

    const row = packager.create(
      s,
      { name: m.name, version: m.version, description: m.summary },
      'agentis',
      contents,
    );
    const installed = packager.usePackage(s, row.id);

    return c.json(
      {
        packageId: row.id,
        appInstanceId: installed.resourceId,
        path: installed.path,
        name: m.name,
        version: m.version,
        skills: contents.skills.map((skill) => ({ slug: skill.slug })),
        agents: contents.agents.map((agent) => ({ name: agent.name })),
        workflows: contents.workflows.map((workflow) => ({ slug: workflow.slug, title: workflow.title })),
      },
      201,
    );
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    packager.deletePackage(id, ws.workspaceId);
    return c.json({ ok: true });
  });

  return app;
}
