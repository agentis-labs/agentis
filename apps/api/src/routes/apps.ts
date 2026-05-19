/**
 * /v1/apps — App Knowledge Wedge HTTP surface.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §15.
 *
 * Routes:
 *   GET    /v1/apps                                       → list installed apps
 *   GET    /v1/apps/:appId                                → app summary + dataset specs
 *   PATCH  /v1/apps/:appId                                → update app identity + config
 *   POST   /v1/apps/:appId/reset-brain                    → clear app-scoped knowledge + memory
 *   DELETE /v1/apps/:appId                                → delete app runtime resources
 *   GET    /v1/apps/:appId/intelligence                   → composed AppIntelligenceResponse
 *   GET    /v1/apps/:appId/intelligence/compose           → live AppIntelligenceContext for query
 *   GET    /v1/apps/:appId/datasets                       → list dataset specs + import status
 *   GET    /v1/apps/:appId/datasets/:key/jobs             → list ingestion jobs for one spec
 *   POST   /v1/apps/:appId/datasets/:key/ingest           → start a new ingestion job
 *     Accepts:
 *       - application/json          { payload: string, fileName?, encoding?: 'base64'|'utf8' }
 *       - multipart/form-data       file field (binary), optional fileName field
 *       - application/octet-stream  raw binary; ?fileName= or X-File-Name header
 *   GET    /v1/apps/:appId/ingestion-jobs/:jobId          → inspect a single job
 *   POST   /v1/apps/:appId/ingestion-jobs/:jobId/cancel   → cancel an in-flight job
 *   POST   /v1/apps/:appId/ingestion-jobs/:jobId/resume   → resume a failed/cancelled job
 *   GET    /v1/apps/:appId/knowledge-bases                → list app-scoped knowledge bases
 *   POST   /v1/apps/:appId/knowledge-bases                → create an app-scoped knowledge base
 *   DELETE /v1/apps/:appId/knowledge-bases/:knowledgeBaseId → delete an app-scoped knowledge base
 *   GET    /v1/apps/:appId/knowledge                      → list knowledge chunks (UI)
 *   GET    /v1/apps/:appId/memory                         → list memory episodes (UI)
 *   POST   /v1/apps/:appId/memory                         → create a memory episode
 *   PATCH  /v1/apps/:appId/memory/:id                     → edit a memory episode
 *   DELETE /v1/apps/:appId/memory/:id                     → delete a memory episode
 *   GET    /v1/apps/:appId/evaluator-examples             → list evaluator examples
 *   GET    /v1/apps/:appId/baselines                      → list workflow baselines
 *   GET    /v1/apps/:appId/promoted-patterns              → list promoted patterns
 *   DELETE /v1/apps/:appId/promoted-patterns/:id          → delete a promoted pattern
 *   POST   /v1/apps/:appId/promoted-patterns/:id/demote   → demote a promoted pattern
 *
 *   App Canvas (docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §14):
 *   GET    /v1/apps/:appId/canvas                         → graph + references + validation
 *   PATCH  /v1/apps/:appId/canvas                         → save a new graph
 *   POST   /v1/apps/:appId/canvas/validate                → dry-run validation
 *   POST   /v1/apps/:appId/canvas/from-package            → reset to manifest template
 *
 *   The Brain (docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §16):
 *   GET    /v1/apps/:appId/brain                          → composed BrainResponse
 *
 * `:appId` resolves to an installed `app_instances` id or slug. V1 no longer
 * fabricates stub apps for arbitrary ids; callers must install/activate a
 * package before using app-scoped wedge surfaces.
 */

import { Hono, type Context } from 'hono';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { streamSSE } from 'hono/streaming';
import {
  AgentisError,
  type AgentisPackageContents,
  type AppGraph,
  type DatasetSpec,
  type DatasetIngestionJob,
  type MemoryEpisode,
  type ChatMessage,
  type ChatTurnContext,
  type ToolDefinition,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { KnowledgeBaseService } from '../services/knowledgeBase.js';
import type { KnowledgeStore } from '../services/knowledgeStore.js';
import type { AppMemoryStore } from '../services/appMemoryStore.js';
import type { EvaluatorExampleStore } from '../services/evaluatorExampleStore.js';
import type { WorkflowBaselineStore } from '../services/workflowBaselineStore.js';
import type { AppIntelligenceRuntime } from '../services/appIntelligenceRuntime.js';
import type { IntelligencePromotion } from '../services/intelligencePromotion.js';
import type { DatasetIngestion } from '../services/datasetIngestion.js';
import type { AppCanvasService } from '../services/appCanvasService.js';
import type { BrainComposer } from '../services/brainComposer.js';
import type { CollectiveBrainService } from '../services/collectiveBrain.js';
import type { BrainHealthService } from '../services/brainHealthService.js';
import type { BrainDialecticService } from '../services/brainDialecticService.js';
import type { SessionAtomService } from '../services/sessionAtomService.js';
import type { PeerRepresentationService } from '../services/peerRepresentationService.js';
import type { BrainPromotionQueueWorker } from '../services/brainPromotionQueueWorker.js';
import type { DreamingService } from '../services/dreamingService.js';
import type { IssueService } from '../services/issues.js';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import type { AppResultsService } from '../services/appResultsService.js';
import type { AppThreadService } from '../services/appThreadService.js';
import { synthesizeAppIntentHealth } from '../services/appIntentHealth.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import { ChatSessionExecutor } from '../services/chatSessionExecutor.js';
import { CHAT_TOOL_CATALOG } from '../services/chatToolCatalog.js';
import { APP_THREAD_TOOL_IDS } from '../services/agentisToolHandlers/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { PackagerService } from '../services/packager.js';

const createAppSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(220).optional().default(''),
  goal: z.string().min(1).max(1200),
  intendedBehavior: z.string().max(8000).optional().nullable(),
  appKind: z.enum(['automation', 'assistant', 'research', 'support', 'sales', 'operations', 'custom']).default('automation'),
  category: z.string().max(80).optional(),
  coverImage: z.string().max(2000).optional().nullable(),
  iconGlyph: z.string().max(8).optional(),
  iconColor: z.string().max(32).optional(),
  iconUrl: z.string().max(2_000_000).optional().nullable(),
  creationMode: z.enum(['guided', 'orchestrated_draft']).optional().default('guided'),
  surfaces: z
    .array(
      z.object({
        type: z.enum(['thread', 'dashboard', 'api', 'webhook_receiver', 'stream', 'embed', 'artifact', 'page']),
        label: z.string().max(120).optional(),
        description: z.string().max(500).optional(),
      }),
    )
    .optional()
    .default([{ type: 'thread' }]),
});

const outputLabelSchema = z.object({
  label: z.string().min(1).max(120),
  path: z.string().min(1).max(160),
  format: z.enum(['number', 'currency', 'percent', 'text']).optional().nullable(),
  artifactType: z.enum(['document', 'metric', 'chart', 'list', 'table', 'link', 'file', 'decision', 'custom']).optional().nullable(),
});

const appIssueSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(8000).optional().nullable(),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
});

const updateAppSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(220).optional(),
  intendedBehavior: z.string().max(8000).optional().nullable(),
  category: z.string().max(80).optional().nullable(),
  iconGlyph: z.string().max(8).optional().nullable(),
  iconColor: z.string().max(32).optional().nullable(),
  iconUrl: z.string().max(2_000_000).optional().nullable(),
  coverImage: z.string().max(2_000_000).optional().nullable(),
  outputLabels: z.array(outputLabelSchema).optional(),
  monthlyBudgetCents: z.number().int().nonnegative().optional().nullable(),
  status: z.enum(['setup', 'active', 'paused', 'error']).optional(),
  spaceId: z.string().min(1).optional().nullable(),
});

const appKnowledgeBaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
});

const appThreadConfirmSchema = z.object({
  turnId: z.string().uuid(),
  confirmed: z.boolean(),
});

const knowledgeAtomKindSchema = z.enum(['kb_chunk', 'knowledge_chunk', 'episode', 'memory', 'pattern']);
const brainLinkRelationSchema = z.enum(['supports', 'contradicts', 'refines', 'derived_from', 'co_observed']);
const createBrainLinkSchema = z.object({
  sourceId: z.string().min(1),
  sourceKind: knowledgeAtomKindSchema,
  targetId: z.string().min(1),
  targetKind: knowledgeAtomKindSchema,
  relation: brainLinkRelationSchema.default('supports'),
  confidence: z.number().min(0).max(1).optional(),
});
const resolveBrainDisputeSchema = z.object({
  action: z.enum(['keep_a', 'keep_b', 'merge', 'context_split', 'snooze']),
  contextA: z.string().max(500).optional(),
  contextB: z.string().max(500).optional(),
  snoozeDays: z.number().int().min(1).max(365).optional(),
});
const appBrainDreamPassSchema = z.object({
  peerId: z.string().min(1).optional(),
  peerType: z.enum(['user', 'agent']).optional(),
  phase: z.enum(['deduction', 'induction', 'both']).optional(),
  force: z.boolean().optional(),
});

const APP_RESULT_WINDOWS = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
} as const;

type AppResultWindow = keyof typeof APP_RESULT_WINDOWS;

export interface AppsRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  issues: IssueService;
  knowledge: KnowledgeStore;
  knowledgeBases: KnowledgeBaseService;
  appMemory: AppMemoryStore;
  evaluators: EvaluatorExampleStore;
  baselines: WorkflowBaselineStore;
  intelligence: AppIntelligenceRuntime;
  promotion: IntelligencePromotion;
  ingestion: DatasetIngestion;
  canvas: AppCanvasService;
  brain: BrainComposer;
  collectiveBrain: CollectiveBrainService;
  brainHealth?: BrainHealthService;
  brainDialectic?: BrainDialecticService;
  sessionAtoms?: SessionAtomService;
  peerRepresentations?: PeerRepresentationService;
  brainQueue?: BrainPromotionQueueWorker;
  dreaming?: DreamingService;
  triggerRuntime?: Pick<TriggerRuntime, 'deactivate'>;
  /** Output surface (APP-OUTPUT-REPLAN.md). Optional during incremental rollout. */
  appResults?: AppResultsService;
  appThread?: AppThreadService;
  /** Required for App Thread send route — adapter resolution. */
  adapters?: AdapterManager;
}

export function buildAppRoutes(deps: AppsRoutesDeps) {
  const app = new Hono();
  const packager = new PackagerService({ db: deps.db });
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  function scope(c: Context) {
    const ws = getWorkspace(c);
    return { workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id };
  }

  function appRouteId(c: Context): string {
    const appId = c.req.param('appId');
    if (!appId) throw new AgentisError('VALIDATION_FAILED', 'appId route parameter is required');
    return appId;
  }

  function loadDataset(c: Context, key: string) {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, appRouteId(c));
    const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
    const datasetSpecs = (manifest.datasetSpecs as DatasetSpec[]) ?? [];
    const spec = datasetSpecs.find((s) => s.key === key);
    if (!spec) throw new AgentisError('RESOURCE_NOT_FOUND', `dataset spec '${key}' not found in app manifest`);
    return { ws, pkg, appId: pkg.id, spec };
  }

  async function readDatasetUpload(c: Context): Promise<{ payload: string | Buffer; fileName?: string }> {
    const ct = c.req.header('content-type') ?? '';
    if (ct.startsWith('multipart/form-data')) {
      const form = await c.req.formData();
      const fileField = form.get('file');
      const fileName = (form.get('fileName') as string | null) ?? undefined;
      if (!fileField) throw new AgentisError('VALIDATION_FAILED', 'multipart/form-data must include a `file` field');
      if (fileField instanceof File) {
        return { payload: Buffer.from(await fileField.arrayBuffer()), fileName: fileName ?? fileField.name ?? undefined };
      }
      return { payload: String(fileField), fileName };
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      payload?: string;
      content?: string;
      fileName?: string;
      name?: string;
      encoding?: 'base64' | 'utf8';
    };
    const raw = body.payload ?? body.content;
    if (!raw || typeof raw !== 'string') {
      throw new AgentisError('VALIDATION_FAILED', 'payload or content is required');
    }
    return {
      payload: body.encoding === 'base64' ? Buffer.from(raw, 'base64') : raw,
      fileName: body.fileName ?? body.name,
    };
  }

  function panelJob(job: DatasetIngestionJob) {
    return {
      ...job,
      chunkCount: job.impact?.newKnowledgeClusters ?? job.storedItems,
      embeddingCount: job.storedItems,
      errorItems: job.errors.length,
      currentPhase: job.status,
      progressMessage: job.status === 'completed'
        ? `Stored ${job.storedItems} item${job.storedItems === 1 ? '' : 's'}`
        : job.status,
      errorMessage: job.errors[0]?.message ?? null,
    };
  }

  function progressSnapshot(job: DatasetIngestionJob | null) {
    if (!job) {
      return {
        jobId: null,
        status: 'not_started',
        processedItems: 0,
        totalItems: 0,
        currentPhase: 'not_started',
        percentComplete: 0,
        errorCount: 0,
        chunkCount: 0,
        embeddingCount: 0,
      };
    }
    const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
    const percentComplete = job.totalItems > 0
      ? Math.round((job.processedItems / job.totalItems) * 100)
      : terminal ? 100 : 0;
    return {
      jobId: job.id,
      status: job.status,
      processedItems: job.processedItems,
      totalItems: job.totalItems,
      currentPhase: job.status,
      progressMessage: job.status === 'completed' ? `Stored ${job.storedItems} items` : job.errors[0]?.message ?? job.status,
      percentComplete: Math.min(100, Math.max(0, percentComplete)),
      errorCount: job.errors.length,
      chunkCount: job.impact?.newKnowledgeClusters ?? job.storedItems,
      embeddingCount: job.storedItems,
    };
  }

  function detailPayload(workspaceId: string, pkg: ReturnType<typeof loadAppPackage>) {
    // Prefer the live canvas graph's domains; fall back to the manifest template.
    let domains: Array<{ id: string; name: string; description?: string; workflowIds: string[] }> | undefined;
    try {
      const record = deps.canvas.load(workspaceId, pkg.id);
      const graphDomains = (record.graph as AppGraph | undefined)?.domains;
      if (graphDomains && graphDomains.length > 0) {
        domains = graphDomains.map((domain) => ({
          id: domain.id,
          name: domain.name,
          description: domain.description,
          workflowIds: Array.isArray(domain.workflowIds) ? domain.workflowIds : [],
        }));
      }
    } catch {
      domains = undefined;
    }
    return appDetailFromPackage(deps.db, workspaceId, pkg, {
      knowledgeCount: deps.knowledge.countByApp(workspaceId, pkg.id).total,
      memoryCount: deps.appMemory.countByApp(workspaceId, pkg.id).total,
      spendSummary: buildAppResultsSnapshot(deps.db, workspaceId, pkg, '30d'),
      domains,
      intentHealth: appIntentHealth(deps.db, workspaceId, pkg),
    });
  }

  async function deactivateTriggers(triggerIds: string[]) {
    if (!deps.triggerRuntime || triggerIds.length === 0) return;
    for (const triggerId of triggerIds) {
      await deps.triggerRuntime.deactivate(triggerId).catch(() => {});
    }
  }

  async function pauseTriggersForApp(workspaceId: string, pkg: ReturnType<typeof loadAppPackage>) {
    const workflowIds = workflowIdsForApp(deps.db, workspaceId, pkg);
    if (workflowIds.length === 0) return;
    const triggerRows = deps.db
      .select({ id: schema.triggers.id })
      .from(schema.triggers)
      .where(and(eq(schema.triggers.workspaceId, workspaceId), inArray(schema.triggers.workflowId, workflowIds)))
      .all();
    if (triggerRows.length === 0) return;
    await deactivateTriggers(triggerRows.map((row) => row.id));
    deps.db
      .update(schema.triggers)
      .set({ status: 'paused', updatedAt: new Date().toISOString() })
      .where(and(eq(schema.triggers.workspaceId, workspaceId), inArray(schema.triggers.workflowId, workflowIds)))
      .run();
  }

  function clearAppScopedKnowledge(workspaceId: string, pkg: ReturnType<typeof loadAppPackage>) {
    const knowledgeBaseIds = stringValues(pkg.knowledgeBaseIds);
    if (knowledgeBaseIds.length > 0) {
      deps.db
        .delete(schema.knowledgeBases)
        .where(and(eq(schema.knowledgeBases.workspaceId, workspaceId), inArray(schema.knowledgeBases.id, knowledgeBaseIds)))
        .run();
    }
    deps.db
      .delete(schema.knowledgeBases)
      .where(and(eq(schema.knowledgeBases.workspaceId, workspaceId), eq(schema.knowledgeBases.appId, pkg.id)))
      .run();
    deps.db.delete(schema.knowledgeChunks)
      .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.appId, pkg.id)))
      .run();
    deps.db.delete(schema.appMemory)
      .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.appId, pkg.id)))
      .run();
    deps.db.delete(schema.appEvaluatorExamples)
      .where(and(eq(schema.appEvaluatorExamples.workspaceId, workspaceId), eq(schema.appEvaluatorExamples.appId, pkg.id)))
      .run();
    deps.db.delete(schema.appPromotedPatterns)
      .where(and(eq(schema.appPromotedPatterns.workspaceId, workspaceId), eq(schema.appPromotedPatterns.appId, pkg.id)))
      .run();
    deps.db.delete(schema.workflowBaselines)
      .where(and(eq(schema.workflowBaselines.workspaceId, workspaceId), eq(schema.workflowBaselines.appId, pkg.id)))
      .run();
    deps.db.delete(schema.datasetImports)
      .where(and(eq(schema.datasetImports.workspaceId, workspaceId), eq(schema.datasetImports.appId, pkg.id)))
      .run();
  }

  function resetBrainForApp(workspaceId: string, pkg: ReturnType<typeof loadAppPackage>) {
    clearAppScopedKnowledge(workspaceId, pkg);
    const now = new Date().toISOString();
    const datasetStatuses = pkg.datasetStatuses.map((status) => ({
      ...status,
      status: 'not_imported',
      currentJobId: null,
      lastJobId: null,
      error: null,
      importedAt: null,
      updatedAt: now,
    }));
    deps.db
      .update(schema.appInstances)
      .set({
        datasetStatuses,
        knowledgeBaseIds: {},
        updatedAt: now,
      })
      .where(and(eq(schema.appInstances.id, pkg.id), eq(schema.appInstances.workspaceId, workspaceId)))
      .run();
  }

  async function deleteAppResources(workspaceId: string, pkg: ReturnType<typeof loadAppPackage>) {
    const workflowIds = workflowIdsForApp(deps.db, workspaceId, pkg);
    const workflowRows = workflowIds.length > 0
      ? deps.db.select().from(schema.workflows)
          .where(and(eq(schema.workflows.workspaceId, workspaceId), inArray(schema.workflows.id, workflowIds)))
          .all()
      : [];
    const triggerIds = workflowIds.length > 0
      ? deps.db.select({ id: schema.triggers.id }).from(schema.triggers)
          .where(and(eq(schema.triggers.workspaceId, workspaceId), inArray(schema.triggers.workflowId, workflowIds)))
          .all()
          .map((row) => row.id)
      : [];
    await deactivateTriggers(triggerIds);

    clearAppScopedKnowledge(workspaceId, pkg);

    if (workflowIds.length > 0) {
      const runIds = deps.db.select({ id: schema.workflowRuns.id }).from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), inArray(schema.workflowRuns.workflowId, workflowIds)))
        .all()
        .map((row) => row.id);
      deps.db.delete(schema.artifacts)
        .where(and(eq(schema.artifacts.workspaceId, workspaceId), inArray(schema.artifacts.workflowId, workflowIds)))
        .run();
      if (runIds.length > 0) {
        deps.db.delete(schema.artifacts)
          .where(and(eq(schema.artifacts.workspaceId, workspaceId), inArray(schema.artifacts.runId, runIds)))
          .run();
      }
      deps.db.delete(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), inArray(schema.workflows.id, workflowIds)))
        .run();
    }

    deps.db.delete(schema.appInstances)
      .where(and(eq(schema.appInstances.id, pkg.id), eq(schema.appInstances.workspaceId, workspaceId)))
      .run();

    const candidateAgentIds = [...extractAgentIdsFromWorkflowRows(workflowRows)];
    if (candidateAgentIds.length > 0) {
      const remainingWorkflows = deps.db.select({ graph: schema.workflows.graph }).from(schema.workflows)
        .where(eq(schema.workflows.workspaceId, workspaceId))
        .all();
      const remainingAgentIds = extractAgentIdsFromWorkflowRows(remainingWorkflows);
      const orphanIds = candidateAgentIds.filter((agentId) => !remainingAgentIds.has(agentId));
      if (orphanIds.length > 0) {
        deps.db.delete(schema.agents)
          .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, orphanIds)))
          .run();
      }
    }
  }

  // ── Top-level app listing ─────────────────────────────────
  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.appInstances)
      .where(eq(schema.appInstances.workspaceId, ws.workspaceId))
      .all();
    const apps = rows.map((row) => {
      const contents = (row.packageContents ?? {}) as AgentisPackageContents & Record<string, unknown>;
      const status = row.status === 'setup' ? 'setup_needed' : row.status;
      const deployStatus = normalizedDeployStatus(deps.db, ws.workspaceId, row.entryWorkflowId, row.deployStatus ?? 'stopped');
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        slug: row.slug,
        status,
        deployStatus,
        spaceId: row.spaceId,
        description: (contents.description as string | undefined) ?? (contents.summary as string | undefined) ?? '',
        category: (contents.category as string | undefined) ?? null,
        iconGlyph: (contents.iconGlyph as string | undefined) ?? 'A',
        iconColor: (contents.iconColor as string | undefined) ?? '#15171c',
        iconUrl: stringField(contents, ['iconUrl']) ?? null,
        coverImage: stringField(contents, ['coverImage']) ?? null,
        primaryMetric: null,
        installedAt: row.activatedAt,
      };
    });
    return c.json({ count: apps.length, apps });
  });

  // ── Guided app creation (10.7) ───────────────────────────
  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createAppSchema.parse(await c.req.json().catch(() => ({})));
    const category = body.category?.trim() || appKindLabel(body.appKind);
    const contents = {
      kind: 'agentis',
      agents: [],
      skills: [],
      workflows: [],
      integrations: [],
      credentialSlots: [],
      datasetSpecs: [],
      knowledgeSeeds: [],
      memorySeeds: [],
      evaluatorRubrics: [],
      evaluatorExampleSeeds: [],
      workflowBaselines: [],
      runtimeEpisodeSeeds: [],
      screenshotUrls: [],
      crossAppDependencies: [],
      category,
      description: body.description,
      summary: body.goal,
      intendedBehavior: body.intendedBehavior?.trim() || body.goal,
      coverImage: body.coverImage ?? null,
      iconGlyph: body.iconGlyph ?? appKindGlyph(body.appKind),
      iconColor: body.iconColor ?? appKindColor(body.appKind),
      iconUrl: body.iconUrl ?? null,
      creationMode: body.creationMode,
      surfaces: body.surfaces,
      appGraphTemplate: {
        version: 1,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    } as AgentisPackageContents & Record<string, unknown>;

    const row = packager.create(
      scope(c),
      {
        name: body.name,
        version: '1.0.0',
        description: body.description || body.goal,
        tags: [body.creationMode === 'orchestrated_draft' ? 'orchestrated-draft' : 'guided-app', body.appKind, category],
      },
      'agentis',
      contents,
    );
    const used = packager.usePackage(scope(c), row.id);
    const appRow = deps.db
      .select()
      .from(schema.appInstances)
      .where(and(eq(schema.appInstances.workspaceId, ws.workspaceId), eq(schema.appInstances.id, used.resourceId)))
      .get();
    if (!appRow) throw new AgentisError('RESOURCE_NOT_FOUND', 'created app could not be loaded');
    return c.json({
      app: {
        id: appRow.id,
        slug: appRow.slug,
        name: appRow.name,
        status: appRow.status === 'setup' ? 'setup_needed' : appRow.status,
        description: body.description,
        intendedBehavior: appRow.intendedBehavior ?? contents.intendedBehavior,
        category,
        iconGlyph: contents.iconGlyph,
        iconColor: contents.iconColor,
        iconUrl: contents.iconUrl,
        creationMode: contents.creationMode,
        surfaces: contents.surfaces,
        path: `${used.path}?layer=canvas&build=1`,
      },
      appId: appRow.id,
      appSlug: appRow.slug,
    }, 201);
  });

  // ── App summary + manifest ────────────────────────────────
  app.get('/:appId', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('appId');
    const pkg = loadAppPackage(deps.db, ws.workspaceId, appId);
    return c.json({ app: detailPayload(ws.workspaceId, pkg) });
  });

  app.get('/:appId/health-summary', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    return c.json({ health: appIntentHealth(deps.db, ws.workspaceId, pkg) });
  });

  app.patch('/:appId', async (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const body = updateAppSchema.parse(await c.req.json().catch(() => ({})));
    const manifest = { ...(pkg.manifest ?? {}) } as Record<string, unknown>;
    const now = new Date().toISOString();

    if (body.description !== undefined) manifest.description = body.description.trim();
    if (body.intendedBehavior !== undefined) {
      const intendedBehavior = body.intendedBehavior?.trim() ?? '';
      if (intendedBehavior) manifest.intendedBehavior = intendedBehavior;
      else delete manifest.intendedBehavior;
    }
    setManifestOptional(manifest, 'category', body.category);
    setManifestOptional(manifest, 'iconGlyph', body.iconGlyph);
    setManifestOptional(manifest, 'iconColor', body.iconColor);
    setManifestOptional(manifest, 'iconUrl', body.iconUrl);
    setManifestOptional(manifest, 'coverImage', body.coverImage);
    if (body.outputLabels !== undefined) manifest.outputLabels = sanitizeOutputLabels(body.outputLabels);
    if (body.monthlyBudgetCents !== undefined) {
      if (body.monthlyBudgetCents === null) delete manifest.monthlyBudgetCents;
      else manifest.monthlyBudgetCents = body.monthlyBudgetCents;
    }

    const nextStatus = body.status ?? pkg.status;
    deps.db
      .update(schema.appInstances)
      .set({
        name: body.name?.trim() ?? pkg.name,
        status: nextStatus,
        intendedBehavior: body.intendedBehavior === undefined ? pkg.intendedBehavior : (body.intendedBehavior?.trim() || null),
        spaceId: body.spaceId === undefined ? pkg.spaceId : body.spaceId,
        pausedAt: nextStatus === 'paused' ? (pkg.pausedAt ?? now) : null,
        packageContents: manifest,
        updatedAt: now,
      })
      .where(and(eq(schema.appInstances.id, pkg.id), eq(schema.appInstances.workspaceId, ws.workspaceId)))
      .run();

    if (body.status === 'paused') {
      await pauseTriggersForApp(ws.workspaceId, pkg);
    }

    const fresh = loadAppPackage(deps.db, ws.workspaceId, pkg.id);
    return c.json({ app: detailPayload(ws.workspaceId, fresh) });
  });

  app.post('/:appId/reset-brain', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    resetBrainForApp(ws.workspaceId, pkg);
    const fresh = loadAppPackage(deps.db, ws.workspaceId, pkg.id);
    return c.json({ app: detailPayload(ws.workspaceId, fresh) });
  });

  app.delete('/:appId', async (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    await deleteAppResources(ws.workspaceId, pkg);
    return c.json({ ok: true });
  });

  app.get('/:appId/knowledge-bases', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    return c.json({ knowledgeBases: deps.knowledgeBases.listKnowledgeBases(ws.workspaceId, { appId: pkg.id }) });
  });

  app.post('/:appId/knowledge-bases', async (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const body = appKnowledgeBaseSchema.parse(await c.req.json());
    const knowledgeBase = deps.knowledgeBases.createKnowledgeBase({
      workspaceId: ws.workspaceId,
      appId: pkg.id,
      name: body.name,
      description: body.description,
    });
    return c.json({ knowledgeBase }, 201);
  });

  app.delete('/:appId/knowledge-bases/:knowledgeBaseId', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const knowledgeBase = deps.knowledgeBases.getKnowledgeBase(ws.workspaceId, c.req.param('knowledgeBaseId'), { appId: pkg.id });
    return c.json(deps.knowledgeBases.deleteKnowledgeBase(ws.workspaceId, knowledgeBase.id));
  });

  // ── Intelligence response ─────────────────────────────────
  app.get('/:appId/intelligence', (c) => {
    const ws = getWorkspace(c);
    const requestedAppId = c.req.param('appId');
    const pkg = loadAppPackage(deps.db, ws.workspaceId, requestedAppId);
    const appId = pkg.id;

    const knowledgeCount = deps.knowledge.countByApp(ws.workspaceId, appId);
    const memoryCount = deps.appMemory.countByApp(ws.workspaceId, appId);
    const evaluatorConfidences = deps.evaluators.confidenceForApp(ws.workspaceId, appId);
    const evaluatorTotal = evaluatorConfidences.reduce((s, e) => s + e.exampleCount, 0);
    const promotedCount = deps.promotion.countByApp(ws.workspaceId, appId);
    const baselines = deps.baselines.latestForApp(ws.workspaceId, appId);

    // Seeds: small previews from the manifest (works even if stores were re-seeded).
    const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
    const knowledgeSeeds = (manifest.knowledgeSeeds as Array<{ title: string; metadata?: { source?: string } }>) ?? [];
    const memorySeeds = (manifest.memorySeeds as Array<{ title: string; trust?: number }>) ?? [];
    const datasetSpecs = (manifest.datasetSpecs as DatasetSpec[]) ?? [];

    // Imports — one row per dataset spec, with the latest job stitched in.
    const imports = datasetSpecs.map((spec) => {
      const jobs = deps.ingestion.list({
        workspaceId: ws.workspaceId,
        appId,
        datasetKey: spec.key,
        limit: 1,
      });
      const latest = jobs[0];
      return {
        datasetKey: spec.key,
        key: spec.key,
        label: spec.label,
        description: spec.description,
        acceptedFormats: spec.acceptedFormats,
        requiredFields: spec.requiredFields ?? [],
        wedgeRole: spec.wedgeRole,
        status: latest?.status ?? 'pending',
        freshness: spec.freshnessExpectation ?? null,
        targetStore: spec.targetStore,
        latestJob: latest ? panelJob(latest) : null,
        counts: {
          sourceItems: latest?.totalItems ?? 0,
          storedItems: latest?.storedItems ?? 0,
          promotedItems: 0,
        },
      };
    });

    // Memory patterns — latest 8.
    const memoryPatterns = deps.appMemory.list({
      workspaceId: ws.workspaceId,
      appId,
      source: 'promotion',
      limit: 8,
    });

    // Gaps: dataset specs that are recommended but have NO completed job.
    const gaps = datasetSpecs
      .filter((s) => s.recommended && imports.find((i) => i.datasetKey === s.key)?.status !== 'completed')
      .map((s) => ({
        key: s.key,
        label: s.label,
        reason: `Recommended dataset (${s.wedgeRole}) — not yet imported.`,
      }));

    const baselineConfidence = computeBaselineConfidence(baselines);

    const response = {
      app: {
        id: pkg.id,
        slug: pkg.slug,
        name: pkg.name,
        status: 'active',
      },
      summary: {
        seedCount: knowledgeSeeds.length + memorySeeds.length,
        importedDatasetCount: imports.filter((i) => i.status === 'completed').length,
        knowledgeClusterCount: knowledgeCount.bySource['import'] ?? 0,
        promotedMemoryCount: promotedCount,
        evaluatorExampleCount: evaluatorTotal,
        baselineConfidence,
      },
      seeds: {
        knowledge: knowledgeSeeds.map((k) => ({
          title: k.title,
          source: (k.metadata?.source as string) ?? 'package',
        })),
        memory: memorySeeds.map((m) => ({ title: m.title, trust: m.trust ?? 0.9 })),
        evaluatorExamples: evaluatorConfidences.map((e) => ({
          evaluatorKey: e.evaluatorKey,
          count: e.exampleCount,
        })),
      },
      imports,
      memory: {
        patterns: memoryPatterns.map((m) => ({
          id: m.id,
          title: m.title,
          trust: m.trust,
          confidence: m.importance, // best proxy in V1 — the real metric is on the pattern row
        })),
        gaps,
      },
      evaluators: evaluatorConfidences.map((e) => ({
        key: e.evaluatorKey,
        confidence: e.confidence,
        exampleCount: e.exampleCount,
      })),
      baselines: baselines.map((b) => ({
        workflowId: b.workflowId,
        successRate: b.successRate ?? 0,
        avgCostMicros: (b.costCentsPerRun ?? 0) * 10000,
        sampleSize: b.sampleSize,
      })),
    };

    return c.json(response);
  });

  // ── Live composition (passes a query through AppIntelligenceRuntime) ──
  app.get('/:appId/intelligence/compose', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const appId = pkg.id;
    const query = c.req.query('q') ?? '';
    if (!query) {
      throw new AgentisError('VALIDATION_FAILED', 'query parameter `q` is required');
    }
    const tokenBudget = parseIntOrUndefined(c.req.query('tokenBudget'));
    const composed = deps.intelligence.compose({
      workspaceId: ws.workspaceId,
      appId,
      query,
      tokenBudget,
    });
    return c.json(composed);
  });

  // ── Dataset specs + import status ─────────────────────────
  app.get('/:appId/datasets', (c) => {
    const ws = getWorkspace(c);
    const requestedAppId = c.req.param('appId');
    const pkg = loadAppPackage(deps.db, ws.workspaceId, requestedAppId);
    const appId = pkg.id;
    const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
    const datasetSpecs = (manifest.datasetSpecs as DatasetSpec[]) ?? [];
    const datasets = datasetSpecs.map((spec) => {
      const jobs = deps.ingestion.list({
        workspaceId: ws.workspaceId,
        appId,
        datasetKey: spec.key,
        limit: 5,
      });
      return { spec, recentJobs: jobs };
    });
    return c.json({ count: datasets.length, datasets });
  });

  app.get('/:appId/datasets/:key/jobs', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const appId = pkg.id;
    const key = c.req.param('key');
    const limit = parseIntOrUndefined(c.req.query('limit'));
    const jobs = deps.ingestion.list({
      workspaceId: ws.workspaceId,
      appId,
      datasetKey: key,
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json({ count: jobs.length, jobs });
  });

  app.post('/:appId/data/:key/preview', async (c) => {
    const key = c.req.param('key');
    const { ws, appId, spec } = loadDataset(c, key);
    const upload = await readDatasetUpload(c);
    const preview = deps.ingestion.preview({
      workspaceId: ws.workspaceId,
      appId,
      spec,
      payload: upload.payload,
      fileName: upload.fileName,
    });
    return c.json({ preview });
  });

  app.post('/:appId/data/:key/ingest', async (c) => {
    const key = c.req.param('key');
    const { ws, appId, spec } = loadDataset(c, key);
    const upload = await readDatasetUpload(c);
    const job = await deps.ingestion.start({
      workspaceId: ws.workspaceId,
      appId,
      spec,
      payload: upload.payload,
      fileName: upload.fileName,
    });
    return c.json({ job: panelJob(job) }, 202);
  });

  app.get('/:appId/data/:key/progress', (c) => {
    const key = c.req.param('key');
    const { ws, appId } = loadDataset(c, key);
    const latest = deps.ingestion.list({ workspaceId: ws.workspaceId, appId, datasetKey: key, limit: 1 })[0] ?? null;
    return new Response(`data: ${JSON.stringify(progressSnapshot(latest))}\n\n`, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  });

  app.delete('/:appId/data/:key', (c) => {
    const key = c.req.param('key');
    const { ws, appId } = loadDataset(c, key);
    const provenancePattern = `%"datasetKey":"${key}"%`;
    const jobs = deps.ingestion.list({ workspaceId: ws.workspaceId, appId, datasetKey: key, limit: 100 });
    let importItems = 0;
    if (jobs.length > 0) {
      importItems = deps.db.delete(schema.datasetImportItems)
        .where(inArray(schema.datasetImportItems.importJobId, jobs.map((job) => job.id)))
        .run().changes;
    }
    const imports = deps.db.delete(schema.datasetImports)
      .where(and(
        eq(schema.datasetImports.workspaceId, ws.workspaceId),
        eq(schema.datasetImports.appId, appId),
        eq(schema.datasetImports.datasetKey, key),
      ))
      .run().changes;
    const knowledge = deps.db.delete(schema.knowledgeChunks)
      .where(and(
        eq(schema.knowledgeChunks.workspaceId, ws.workspaceId),
        eq(schema.knowledgeChunks.appId, appId),
        eq(schema.knowledgeChunks.source, 'import'),
        sql`${schema.knowledgeChunks.provenance} LIKE ${provenancePattern}`,
      ))
      .run().changes;
    const memory = deps.db.delete(schema.appMemory)
      .where(and(
        eq(schema.appMemory.workspaceId, ws.workspaceId),
        eq(schema.appMemory.appId, appId),
        eq(schema.appMemory.source, 'operator'),
        sql`${schema.appMemory.provenance} LIKE ${provenancePattern}`,
      ))
      .run().changes;
    const evaluatorExamples = deps.db.delete(schema.appEvaluatorExamples)
      .where(and(
        eq(schema.appEvaluatorExamples.workspaceId, ws.workspaceId),
        eq(schema.appEvaluatorExamples.appId, appId),
        eq(schema.appEvaluatorExamples.source, 'import'),
        eq(schema.appEvaluatorExamples.evaluatorKey, key),
      ))
      .run().changes;
    return c.json({ deleted: { imports, importItems, knowledge, memory, evaluatorExamples } });
  });

  // ── Start an ingestion job ────────────────────────────────
  // Accepts three content types:
  //   1. application/json: { payload: string, fileName?, encoding?: 'base64'|'utf8' }
  //   2. multipart/form-data: file field (binary), optional fileName field
  //   3. application/octet-stream: raw bytes; fileName from ?fileName= or X-File-Name
  app.post('/:appId/datasets/:key/ingest', async (c) => {
    const ws = getWorkspace(c);
    const requestedAppId = c.req.param('appId');
    const key = c.req.param('key');
    const pkg = loadAppPackage(deps.db, ws.workspaceId, requestedAppId);
    const appId = pkg.id;
    const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
    const datasetSpecs = (manifest.datasetSpecs as DatasetSpec[]) ?? [];
    const spec = datasetSpecs.find((s) => s.key === key);
    if (!spec) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `dataset spec '${key}' not found in app manifest`);
    }

    const ct = c.req.header('content-type') ?? '';
    let payload: string | Buffer;
    let fileName: string | undefined;

    if (ct.startsWith('multipart/form-data')) {
      // ── Multipart upload ─────────────────────────────────
      const form = await c.req.formData();
      const fileField = form.get('file');
      fileName = (form.get('fileName') as string | null) ?? undefined;
      if (!fileField) {
        throw new AgentisError('VALIDATION_FAILED', 'multipart/form-data must include a `file` field');
      }
      if (fileField instanceof File) {
        if (!fileName) fileName = fileField.name || undefined;
        payload = Buffer.from(await fileField.arrayBuffer());
      } else if (typeof fileField === 'string') {
        payload = fileField;
      } else {
        throw new AgentisError('VALIDATION_FAILED', 'unexpected file field type in multipart upload');
      }
    } else if (ct.startsWith('application/octet-stream')) {
      // ── Raw binary upload ────────────────────────────────
      fileName = c.req.query('fileName') ?? c.req.header('x-file-name') ?? undefined;
      payload = Buffer.from(await c.req.arrayBuffer());
    } else {
      // ── JSON upload (default) ────────────────────────────
      const body = (await c.req.json().catch(() => ({}))) as {
        payload?: string;
        fileName?: string;
        encoding?: 'base64' | 'utf8';
      };
      if (!body.payload || typeof body.payload !== 'string') {
        throw new AgentisError(
          'VALIDATION_FAILED',
          'body.payload (string) is required. For binary files use multipart/form-data or application/octet-stream.',
        );
      }
      fileName = body.fileName;
      if (body.encoding === 'base64') {
        payload = Buffer.from(body.payload, 'base64');
      } else {
        payload = body.payload;
      }
    }

    const job = await deps.ingestion.start({
      workspaceId: ws.workspaceId,
      appId,
      spec,
      payload,
      fileName,
    });
    return c.json({ job }, 202);
  });

  // ── Job inspection / cancel ───────────────────────────────
  app.get('/:appId/ingestion-jobs/:jobId', (c) => {
    const ws = getWorkspace(c);
    const jobId = c.req.param('jobId');
    const job = deps.ingestion.byId(ws.workspaceId, jobId);
    if (!job) throw new AgentisError('RESOURCE_NOT_FOUND', `ingestion job '${jobId}' not found`);
    return c.json({ job });
  });

  app.post('/:appId/ingestion-jobs/:jobId/cancel', (c) => {
    const ws = getWorkspace(c);
    const jobId = c.req.param('jobId');
    const cancelled = deps.ingestion.cancel(ws.workspaceId, jobId);
    if (!cancelled) {
      throw new AgentisError(
        'RESOURCE_CONFLICT',
        `job '${jobId}' could not be cancelled (already terminal or unknown)`,
      );
    }
    return c.json({ jobId, cancelled: true });
  });

  // ── Resume a failed / cancelled job ──────────────────────
  // Requires re-uploading the same (or corrected) file. Items whose content
  // hash matches an already-completed item row are skipped automatically.
  app.post('/:appId/ingestion-jobs/:jobId/resume', async (c) => {
    const ws = getWorkspace(c);
    const requestedAppId = c.req.param('appId');
    const jobId = c.req.param('jobId');

    // Load the job first to get datasetKey for spec lookup.
    const job = deps.ingestion.byId(ws.workspaceId, jobId);
    if (!job) throw new AgentisError('RESOURCE_NOT_FOUND', `ingestion job '${jobId}' not found`);

    // Resolve DatasetSpec from the app manifest.
    const pkg = loadAppPackage(deps.db, ws.workspaceId, requestedAppId);
    const appId = pkg.id;
    const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
    const datasetSpecs = (manifest.datasetSpecs as DatasetSpec[]) ?? [];
    const spec = datasetSpecs.find((s) => s.key === job.datasetKey);
    if (!spec) {
      throw new AgentisError(
        'RESOURCE_NOT_FOUND',
        `dataset spec '${job.datasetKey}' not found in app manifest — cannot resume`,
      );
    }

    const ct = c.req.header('content-type') ?? '';
    let payload: string | Buffer;
    let fileName: string | undefined;

    if (ct.startsWith('multipart/form-data')) {
      const form = await c.req.formData();
      const fileField = form.get('file');
      fileName = (form.get('fileName') as string | null) ?? undefined;
      if (!fileField) throw new AgentisError('VALIDATION_FAILED', 'multipart/form-data must include a `file` field');
      if (fileField instanceof File) {
        if (!fileName) fileName = fileField.name || undefined;
        payload = Buffer.from(await fileField.arrayBuffer());
      } else {
        payload = fileField as string;
      }
    } else if (ct.startsWith('application/octet-stream')) {
      fileName = c.req.query('fileName') ?? c.req.header('x-file-name') ?? undefined;
      payload = Buffer.from(await c.req.arrayBuffer());
    } else {
      const body = (await c.req.json().catch(() => ({}))) as {
        payload?: string;
        fileName?: string;
        encoding?: 'base64' | 'utf8';
      };
      if (!body.payload || typeof body.payload !== 'string') {
        throw new AgentisError('VALIDATION_FAILED', 'body.payload (string) is required');
      }
      fileName = body.fileName;
      payload = body.encoding === 'base64' ? Buffer.from(body.payload, 'base64') : body.payload;
    }

    const resumed = await deps.ingestion.resume({
      workspaceId: ws.workspaceId,
      appId,
      jobId,
      spec,
      payload,
      fileName,
    });
    return c.json({ job: resumed }, 202);
  });

  // ── Knowledge chunks (read-only listing) ──────────────────
  app.get('/:appId/knowledge', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const sourceParam = c.req.query('source');
    const knowledgeSource = (
      sourceParam && ['seed', 'import', 'promotion'].includes(sourceParam)
        ? sourceParam
        : undefined
    ) as 'seed' | 'import' | 'promotion' | undefined;
    const limit = parseIntOrUndefined(c.req.query('limit'));
    const chunks = deps.knowledge.list({
      workspaceId: ws.workspaceId,
      appId,
      ...(knowledgeSource ? { source: knowledgeSource } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json({ count: chunks.length, chunks });
  });

  // ── App memory ────────────────────────────────────────────
  app.get('/:appId/memory', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const kindParam = c.req.query('kind');
    const sourceParam = c.req.query('source');
    const limit = parseIntOrUndefined(c.req.query('limit'));
    const memoryKind = (
      kindParam && ['fact', 'preference', 'pattern', 'rule', 'lesson'].includes(kindParam)
        ? kindParam
        : undefined
    ) as MemoryEpisode['kind'] | undefined;
    const memorySource = (
      sourceParam && ['seed', 'promotion', 'operator'].includes(sourceParam)
        ? sourceParam
        : undefined
    ) as MemoryEpisode['source'] | undefined;
    const episodes = deps.appMemory.list({
      workspaceId: ws.workspaceId,
      appId,
      ...(memoryKind ? { kind: memoryKind } : {}),
      ...(memorySource ? { source: memorySource } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json({ count: episodes.length, episodes });
  });

  app.post('/:appId/memory', async (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const body = (await c.req.json()) as Partial<{
      kind: MemoryEpisode['kind'];
      title: string;
      content: string;
      trust: number;
      importance: number;
      tags: string[];
    }>;
    if (!body.kind || !body.title || !body.content) {
      throw new AgentisError('VALIDATION_FAILED', 'kind, title, and content are required');
    }
    if (!['fact', 'preference', 'pattern', 'rule', 'lesson'].includes(body.kind)) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        `kind must be one of fact|preference|pattern|rule|lesson`,
      );
    }
    const id = deps.appMemory.write({
      workspaceId: ws.workspaceId,
      appId,
      kind: body.kind,
      source: 'operator',
      title: body.title,
      content: body.content,
      trust: body.trust,
      importance: body.importance,
      tags: body.tags,
    });
    return c.json({ id, written: true }, 201);
  });

  app.patch('/:appId/memory/:id', async (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const id = c.req.param('id');
    const body = (await c.req.json()) as Partial<
      Pick<MemoryEpisode, 'title' | 'content' | 'trust' | 'importance' | 'tags'>
    >;
    const updated = deps.appMemory.update(ws.workspaceId, appId, id, body);
    if (!updated) throw new AgentisError('RESOURCE_NOT_FOUND', `memory '${id}' not found`);
    return c.json({ episode: updated });
  });

  app.delete('/:appId/memory/:id', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const id = c.req.param('id');
    const deleted = deps.appMemory.delete(ws.workspaceId, appId, id);
    if (!deleted) throw new AgentisError('RESOURCE_NOT_FOUND', `memory '${id}' not found`);
    return c.json({ id, deleted: true });
  });

  // ── Evaluator examples (Class 3) ──────────────────────────
  function listEvaluatorExamples(c: Context) {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, appRouteId(c)).id;
    const evaluatorKey = c.req.query('evaluatorKey');
    const limit = parseIntOrUndefined(c.req.query('limit'));
    const examples = deps.evaluators.list({
      workspaceId: ws.workspaceId,
      appId,
      ...(evaluatorKey ? { evaluatorKey } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const confidence = deps.evaluators.confidenceForApp(ws.workspaceId, appId);
    return c.json({ count: examples.length, examples, confidence });
  }

  async function createEvaluatorExample(c: Context) {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, appRouteId(c)).id;
    const body = (await c.req.json()) as Partial<{
      evaluatorKey: string;
      input: unknown;
      expected: unknown;
      verdict: 'pass' | 'fail';
      score: number;
      reason: string;
    }>;
    if (!body.evaluatorKey || body.input === undefined || body.expected === undefined || !body.verdict) {
      throw new AgentisError('VALIDATION_FAILED', 'evaluatorKey, input, expected, and verdict are required');
    }
    if (!['pass', 'fail'].includes(body.verdict)) {
      throw new AgentisError('VALIDATION_FAILED', 'verdict must be pass or fail');
    }
    const id = deps.evaluators.write({
      workspaceId: ws.workspaceId,
      appId,
      evaluatorKey: body.evaluatorKey,
      source: 'operator',
      input: body.input,
      expected: body.expected,
      verdict: body.verdict,
      score: body.score,
      reason: body.reason,
    });
    return c.json({ id, written: true }, 201);
  }

  async function updateEvaluatorExample(c: Context) {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, appRouteId(c)).id;
    const id = c.req.param('id');
    if (!id) throw new AgentisError('VALIDATION_FAILED', 'evaluator example id is required');
    const body = (await c.req.json()) as Partial<{
      evaluatorKey: string;
      input: unknown;
      expected: unknown;
      verdict: 'pass' | 'fail';
      score: number | null;
      reason: string | null;
    }>;
    if (body.evaluatorKey !== undefined && !body.evaluatorKey.trim()) {
      throw new AgentisError('VALIDATION_FAILED', 'evaluatorKey cannot be empty');
    }
    if (body.verdict !== undefined && !['pass', 'fail'].includes(body.verdict)) {
      throw new AgentisError('VALIDATION_FAILED', 'verdict must be pass or fail');
    }
    if (body.score !== undefined && body.score !== null && (!Number.isFinite(body.score) || body.score < 0 || body.score > 1)) {
      throw new AgentisError('VALIDATION_FAILED', 'score must be between 0 and 1');
    }
    const example = deps.evaluators.update(ws.workspaceId, appId, id, {
      ...(body.evaluatorKey !== undefined ? { evaluatorKey: body.evaluatorKey.trim() } : {}),
      ...(body.input !== undefined ? { input: body.input } : {}),
      ...(body.expected !== undefined ? { expected: body.expected } : {}),
      ...(body.verdict !== undefined ? { verdict: body.verdict } : {}),
      ...(body.score !== undefined ? { score: body.score } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
    if (!example) throw new AgentisError('RESOURCE_NOT_FOUND', `evaluator example '${id}' not found`);
    return c.json({ example });
  }

  function deleteEvaluatorExample(c: Context) {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, appRouteId(c)).id;
    const id = c.req.param('id');
    if (!id) throw new AgentisError('VALIDATION_FAILED', 'evaluator example id is required');
    const deleted = deps.evaluators.deleteForAppExample(ws.workspaceId, appId, id);
    if (!deleted) throw new AgentisError('RESOURCE_NOT_FOUND', `evaluator example '${id}' not found`);
    return c.json({ id, deleted: true });
  }

  app.get('/:appId/evaluator-examples', listEvaluatorExamples);
  app.post('/:appId/evaluator-examples', createEvaluatorExample);
  app.patch('/:appId/evaluator-examples/:id', updateEvaluatorExample);
  app.delete('/:appId/evaluator-examples/:id', deleteEvaluatorExample);
  app.get('/:appId/evaluators/examples', listEvaluatorExamples);
  app.post('/:appId/evaluators/examples', createEvaluatorExample);
  app.patch('/:appId/evaluators/examples/:id', updateEvaluatorExample);
  app.delete('/:appId/evaluators/examples/:id', deleteEvaluatorExample);

  // ── Baselines ─────────────────────────────────────────────
  app.get('/:appId/baselines', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const baselines = deps.baselines.latestForApp(ws.workspaceId, appId);
    return c.json({ count: baselines.length, baselines });
  });

  // ── Promoted patterns (Class 4) ───────────────────────────
  app.get('/:appId/promoted-patterns', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const kindParam = c.req.query('kind');
    const limit = parseIntOrUndefined(c.req.query('limit'));
    const promotedKind = (
      kindParam &&
      [
        'successful_playbook',
        'failure_with_fix',
        'approved_output_pattern',
        'business_rule',
        'recurring_exception',
      ].includes(kindParam)
        ? kindParam
        : undefined
    ) as
      | 'successful_playbook'
      | 'failure_with_fix'
      | 'approved_output_pattern'
      | 'business_rule'
      | 'recurring_exception'
      | undefined;
    const patterns = deps.promotion.list({
      workspaceId: ws.workspaceId,
      appId,
      ...(promotedKind ? { kind: promotedKind } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return c.json({ count: patterns.length, patterns });
  });

  app.delete('/:appId/promoted-patterns/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const deleted = deps.promotion.delete(ws.workspaceId, id);
    if (!deleted) throw new AgentisError('RESOURCE_NOT_FOUND', `pattern '${id}' not found`);
    return c.json({ id, deleted: true });
  });

  app.post('/:appId/promoted-patterns/:id/demote', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { delta?: number };
    const result = deps.promotion.demote(ws.workspaceId, id, body.delta);
    return c.json({ pattern: result, dropped: result === null });
  });

  // ── App Canvas (docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §14) ───────
  app.get('/:appId/canvas', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const record = deps.canvas.load(ws.workspaceId, appId);
    return c.json({
      app: { id: record.id, slug: record.slug, name: record.name, status: record.status, description: record.description },
      graph: record.graph,
      references: record.references,
      validation: {
        errors: record.validation.errors.map(({ severity: _s, ...rest }) => rest),
        warnings: record.validation.warnings.map(({ severity: _s, ...rest }) => rest),
      },
    });
  });

  /** Live per-workflow run status — drives the canvas node status overlays. */
  app.get('/:appId/canvas/status', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const workflowIds = workflowIdsForApp(deps.db, ws.workspaceId, pkg);
    const workflowStatus: Record<string, { status: string; lastRunAt: string | null }> = {};
    if (workflowIds.length > 0) {
      const runs = deps.db
        .select({
          workflowId: schema.workflowRuns.workflowId,
          status: schema.workflowRuns.status,
          completedAt: schema.workflowRuns.completedAt,
          createdAt: schema.workflowRuns.createdAt,
        })
        .from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, ws.workspaceId), inArray(schema.workflowRuns.workflowId, workflowIds)))
        .orderBy(desc(schema.workflowRuns.createdAt))
        .all();
      for (const run of runs) {
        if (!run.workflowId || workflowStatus[run.workflowId]) continue;
        workflowStatus[run.workflowId] = {
          status: run.status,
          lastRunAt: run.completedAt ?? run.createdAt,
        };
      }
    }
    return c.json({ workflowStatus });
  });

  app.patch('/:appId/canvas', async (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const body = (await c.req.json().catch(() => null)) as { graph?: AppGraph } | null;
    if (!body || !body.graph || typeof body.graph !== 'object') {
      throw new AgentisError(
        'VALIDATION_FAILED',
        'PATCH body must include a `graph` field with an AppGraph object',
      );
    }
    const record = deps.canvas.save(ws.workspaceId, appId, body.graph);
    return c.json({
      app: { id: record.id, slug: record.slug, name: record.name, status: record.status, description: record.description },
      graph: record.graph,
      references: record.references,
      validation: {
        errors: record.validation.errors.map(({ severity: _s, ...rest }) => rest),
        warnings: record.validation.warnings.map(({ severity: _s, ...rest }) => rest),
      },
    });
  });

  app.post('/:appId/canvas/validate', async (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const body = (await c.req.json().catch(() => null)) as { graph?: AppGraph } | null;
    if (!body || !body.graph) {
      throw new AgentisError('VALIDATION_FAILED', 'body.graph is required');
    }
    const result = deps.canvas.validateCandidate(ws.workspaceId, appId, body.graph);
    return c.json({
      references: result.references,
      validation: {
        errors: result.validation.errors.map(({ severity: _s, ...rest }) => rest),
        warnings: result.validation.warnings.map(({ severity: _s, ...rest }) => rest),
      },
    });
  });

  // ── The Brain (docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §16) ───────
  app.get('/:appId/brain', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const response = deps.brain.composeForApp(ws.workspaceId, appId);
    return c.json(response);
  });

  app.get('/:appId/brain/health', (c) => {
    if (!deps.brainHealth) throw new AgentisError('RESOURCE_NOT_FOUND', 'Brain health service not available');
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    return c.json(deps.brainHealth.snapshot(ws.workspaceId, appId));
  });

  app.get('/:appId/brain/activity', (c) => {
    if (!deps.brainHealth) throw new AgentisError('RESOURCE_NOT_FOUND', 'Brain health service not available');
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    return c.json({ activity: deps.brainHealth.snapshot(ws.workspaceId, appId).recentActivity });
  });

  app.post('/:appId/brain/dream-pass', async (c) => {
    if (!deps.dreaming) throw new AgentisError('RESOURCE_NOT_FOUND', 'Dreaming service not available');
    const ws = getWorkspace(c);
    loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const body = appBrainDreamPassSchema.parse(await c.req.json().catch(() => ({})));
    const result = body.peerId
      ? await deps.dreaming.run({
          workspaceId: ws.workspaceId,
          peerId: body.peerId,
          peerType: body.peerType ?? 'user',
          phase: body.phase ?? 'both',
        })
      : await deps.dreaming.runDue(ws.workspaceId, { force: body.force ?? true, phase: body.phase ?? 'both' });
    return c.json(result);
  });

  app.get('/:appId/brain/disputes', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    return c.json({ disputes: deps.collectiveBrain.listDisputes(ws.workspaceId, { appId }) });
  });

  app.post('/:appId/brain/disputes/:id/resolve', async (c) => {
    const ws = getWorkspace(c);
    loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const body = resolveBrainDisputeSchema.parse(await c.req.json().catch(() => ({})));
    const result = await deps.collectiveBrain.resolveDispute({
      workspaceId: ws.workspaceId,
      disputeId: c.req.param('id'),
      action: body.action,
      contextA: body.contextA ?? null,
      contextB: body.contextB ?? null,
      snoozeDays: body.snoozeDays,
    });
    if (!result.resolved) throw new AgentisError('RESOURCE_NOT_FOUND', 'Dispute not found');
    return c.json(result);
  });

  app.get('/:appId/brain/graph', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const graph = deps.collectiveBrain.getGraph(ws.workspaceId, {
      scope: 'app',
      appId,
      includeWorkspace: c.req.query('includeWorkspace') === 'true',
      minConfidence: numberQuery(c.req.query('minConfidence')) ?? undefined,
      limit: numberQuery(c.req.query('limit')) ?? undefined,
    });
    return c.json({ graph });
  });

  app.get('/:appId/brain/graph/node/:id', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const detail = deps.collectiveBrain.getNode(ws.workspaceId, c.req.param('id'), {
      scope: 'app',
      appId,
      includeWorkspace: c.req.query('includeWorkspace') === 'true',
    });
    if (!detail) throw new AgentisError('RESOURCE_NOT_FOUND', 'Node not found');
    return c.json(detail);
  });

  app.post('/:appId/brain/links', async (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const body = createBrainLinkSchema.parse(await c.req.json().catch(() => ({})));
    const link = deps.collectiveBrain.createLink({
      workspaceId: ws.workspaceId,
      appId,
      sourceId: body.sourceId,
      sourceKind: body.sourceKind,
      targetId: body.targetId,
      targetKind: body.targetKind,
      relation: body.relation,
      confidence: body.confidence ?? 0.72,
    });
    if (!link) throw new AgentisError('VALIDATION_FAILED', 'Could not create link between those atoms');
    return c.json({ link }, 201);
  });

  app.delete('/:appId/brain/atoms/:kind/:id', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const kind = knowledgeAtomKindSchema.parse(c.req.param('kind'));
    const ok = deps.collectiveBrain.archiveAtom(ws.workspaceId, kind, c.req.param('id'), { appId });
    if (!ok) throw new AgentisError('RESOURCE_NOT_FOUND', 'Atom not found');
    return c.json({ archived: true });
  });

  app.post('/:appId/canvas/from-package', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const record = deps.canvas.resetFromPackage(ws.workspaceId, appId);
    return c.json({
      app: { id: record.id, slug: record.slug, name: record.name, status: record.status, description: record.description },
      graph: record.graph,
      references: record.references,
      validation: {
        errors: record.validation.errors.map(({ severity: _s, ...rest }) => rest),
        warnings: record.validation.warnings.map(({ severity: _s, ...rest }) => rest),
      },
    });
  });

  app.get('/:appId/results', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    return c.json(buildAppResultsSnapshot(deps.db, ws.workspaceId, pkg, c.req.query('window')));
  });

  app.get('/:appId/output-results', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const workflowIds = workflowIdsForApp(deps.db, ws.workspaceId, pkg);
    const results = workflowIds.length > 0
      ? deps.db.select().from(schema.artifacts)
          .where(and(eq(schema.artifacts.workspaceId, ws.workspaceId), inArray(schema.artifacts.workflowId, workflowIds)))
          .orderBy(desc(schema.artifacts.createdAt))
          .limit(Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500))
          .all()
      : [];
    return c.json({ results });
  });

  app.get('/:appId/issues', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const workflowIds = new Set(workflowIdsForApp(deps.db, ws.workspaceId, pkg));
    const label = appIssueLabel(pkg.slug);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 60), 1), 200);
    const issues = deps.issues.list(ws.workspaceId)
      .filter((issue) => {
        const labels = Array.isArray(issue.labels) ? issue.labels.map(String) : [];
        return labels.includes(label) || (issue.linkedWorkflowId ? workflowIds.has(issue.linkedWorkflowId) : false);
      })
      .slice(0, limit);
    return c.json({ issues });
  });

  app.post('/:appId/issues', async (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const body = appIssueSchema.parse(await c.req.json());
    const workflowId = pkg.entryWorkflowId ?? workflowIdsForApp(deps.db, ws.workspaceId, pkg)[0] ?? null;
    const issue = deps.issues.create({
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      linkedWorkflowId: workflowId,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? 'medium',
      labels: [appIssueLabel(pkg.slug)],
    });
    if (!workflowId) return c.json({ issue, runId: null }, 201);
    const accepted = await deps.issues.accept({
      workspaceId: ws.workspaceId,
      userId: ws.user.id,
      issueId: issue.id,
    });
    return c.json({ issue: accepted?.issue ?? issue, runId: accepted?.runId ?? null }, 201);
  });

  app.get('/:appId/activity', (c) => {
    const ws = getWorkspace(c);
    const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
    const workflowIds = new Set(workflowIdsForApp(deps.db, ws.workspaceId, pkg));
    const scanLimit = Math.min(Math.max(Number(c.req.query('scanLimit') ?? 250), 1), 1000);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
    const rows = deps.db.select().from(schema.activityEvents)
      .where(eq(schema.activityEvents.workspaceId, ws.workspaceId))
      .orderBy(desc(schema.activityEvents.createdAt))
      .limit(scanLimit)
      .all()
      .filter((event) => {
        if (event.entityType === 'app' && event.entityId === pkg.id) return true;
        const metadata = event.metadata as Record<string, unknown>;
        const workflowId = typeof metadata.workflowId === 'string' ? metadata.workflowId : null;
        return workflowId ? workflowIds.has(workflowId) : false;
      })
      .slice(0, limit);
    return c.json({ events: rows });
  });

  // ────────────────────────────────────────────────────────────────────────
  // App Output surface — APP-OUTPUT-REPLAN.md §5.3 + §5.6
  //
  //   GET    /:appId/thread                    → message history
  //   POST   /:appId/thread/send               → operator turn (SSE) + persist
  //   GET    /:appId/output                    → result feed (paginated)
  //   GET    /:appId/output/latest             → hero
  //   GET    /:appId/output/search?q=          → FTS5 search
  //   GET    /:appId/output/:resultId          → result detail
  //   GET    /:appId/output/:resultId/neighbours → prev/next
  // ────────────────────────────────────────────────────────────────────────

  if (deps.appThread) {
    app.get('/:appId/thread', (c) => {
      const ws = getWorkspace(c);
      const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
      const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500);
      const before = c.req.query('before') ?? undefined;
      const messages = deps.appThread!.list({
        workspaceId: ws.workspaceId,
        appId: pkg.id,
        limit,
        before,
      });
      return c.json({ appId: pkg.id, messages });
    });

    app.post('/:appId/thread/send', async (c) => {
      const ws = getWorkspace(c);
      const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
      const body = (await c.req.json().catch(() => ({}))) as { body?: string; useViewportContext?: boolean };
      const message = (body.body ?? '').trim();
      if (!message) throw new AgentisError('VALIDATION_FAILED', 'message body is required');

      const operatorMessage = deps.appThread!.append({
        appId: pkg.id,
        workspaceId: ws.workspaceId,
        entryWorkflowId: pkg.entryWorkflowId,
        role: 'operator',
        kind: 'message',
        content: { text: message },
        operatorId: ws.user.id,
      });
      const sessionId = `app:${pkg.id}`;
      try {
        if (deps.sessionAtoms && message.length >= 20) {
          deps.sessionAtoms.add({
            workspaceId: ws.workspaceId,
            appId: pkg.id,
            sessionId,
            content: `Operator turn: ${message}`,
            confidence: sessionAtomConfidence(message),
          });
        }
      } catch (err) {
        // Session atoms are opportunistic short-term context; chat should not fail if
        // a duplicate migration or local DB edge-case rejects the insert.
        console.warn('session_atom.capture_failed', err);
      }

      // Resolve an adapter to drive the App Thread orchestrator. Falls back to
      // the workspace orchestrator agent (same pattern used by
      // OrchestratorEventBridge). The orchestrator speaks "as the app" — see
      // APP-OUTPUT-REPLAN.md §5.5 (flat fallback when an explicit orchestrator
      // agent is not yet attached to the app).
      const orchestratorAgent = findOrchestratorAgentForWorkspace(deps.db, ws.workspaceId);
      const adapterReg = orchestratorAgent && deps.adapters ? deps.adapters.get(orchestratorAgent.id) : null;

      const acceptsSSE = c.req.header('accept')?.includes('text/event-stream');
      if (!orchestratorAgent || !adapterReg?.adapter?.chat || !acceptsSSE) {
        // No connected chat orchestrator — persist a system fallback so the
        // operator sees their message did not vanish.
        const fallback = deps.appThread!.append({
          appId: pkg.id,
          workspaceId: ws.workspaceId,
          entryWorkflowId: pkg.entryWorkflowId,
          role: 'system',
          kind: 'error',
          content: {
            text: 'No chat orchestrator is connected for this workspace yet. Configure an orchestrator agent and try again.',
          },
        });
        return c.json({ operatorMessage, reply: fallback }, 202);
      }

      // App-scoped tool subset — see agentisToolHandlers/app.ts APP_THREAD_TOOL_IDS.
      const appTools: ToolDefinition[] = CHAT_TOOL_CATALOG.filter((t) => APP_THREAD_TOOL_IDS.has(t.name));

      return streamSSE(c, async (stream) => {
        const recent = deps.appThread!.recent(ws.workspaceId, pkg.id, 20);
        const history: ChatMessage[] = recent
          .filter((m) => m.kind === 'message')
          .filter((m) => m.id !== operatorMessage.id)
          .map((m) => ({
            role: m.role === 'operator' ? ('user' as const) : ('assistant' as const),
            content: typeof (m.content as Record<string, unknown>)?.text === 'string'
              ? String((m.content as Record<string, unknown>).text)
              : JSON.stringify(m.content),
          }));

        const turnContext: ChatTurnContext = {
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          agentId: orchestratorAgent.id,
          userId: ws.user.id,
          conversationId: sessionId,
          maxTurns: 6,
          // Carry app context to the orchestrator via the viewport channel —
          // the orchestrator prompt already understands resourceKind='app'.
          viewport: {
            surface: 'app_detail',
            workspaceId: ws.workspaceId,
            ambientId: ws.ambientId,
            resourceId: pkg.id,
            resourceKind: 'app',
            title: pkg.name,
          },
        };

        const recentText = recent
          .filter((m) => m.kind === 'message')
          .filter((m) => m.id !== operatorMessage.id)
          .map((m) => {
            const content = m.content as Record<string, unknown>;
            return typeof content?.text === 'string' ? content.text : JSON.stringify(m.content);
          });
        const turnCount = recent.filter((m) => m.kind === 'message' && m.role === 'operator' && m.id !== operatorMessage.id).length + 1;
        const dialectic = deps.brainDialectic
          ? await deps.brainDialectic.buildTurn({
              workspaceId: ws.workspaceId,
              appId: pkg.id,
              sessionId,
              userId: ws.user.id,
              agentId: orchestratorAgent.id,
              turnCount,
              userMessage: message,
              recentMessages: recentText,
              forceRefresh: body.useViewportContext === true,
            })
          : { injectedMessage: message, injection: '', systemInjection: '', atomIds: [], sessionAtomIds: [], dialecticFired: false };

        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({ id: operatorMessage.id, role: 'operator', kind: 'message', content: operatorMessage.content, createdAt: operatorMessage.createdAt }),
        });
        if (dialectic.injection) {
          await stream.writeSSE({
            event: 'brain_context',
            data: JSON.stringify({
              atomIds: dialectic.atomIds,
              sessionAtomIds: dialectic.sessionAtomIds,
              dialecticFired: dialectic.dialecticFired,
            }),
          });
        }

        let finalText = '';
        try {
          for await (const delta of ChatSessionExecutor.turn(adapterReg.adapter, history, dialectic.injectedMessage, turnContext, {
            tools: appTools,
            systemAddendum: dialectic.systemInjection,
          })) {
            await stream.writeSSE({ event: 'delta', data: JSON.stringify(delta) });
            if (delta.type === 'text') finalText += delta.delta;
            if (delta.type === 'done') break;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errored = deps.appThread!.append({
            appId: pkg.id,
            workspaceId: ws.workspaceId,
            entryWorkflowId: pkg.entryWorkflowId,
            role: 'system',
            kind: 'error',
            content: { text: `Chat turn failed: ${errMsg}` },
          });
          await stream.writeSSE({ event: 'message', data: JSON.stringify({ id: errored.id, role: 'system', kind: 'error', content: errored.content, createdAt: errored.createdAt }) });
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ finishReason: 'error' }) });
          return;
        }

        if (finalText.trim()) {
          const reply = deps.appThread!.append({
            appId: pkg.id,
            workspaceId: ws.workspaceId,
            entryWorkflowId: pkg.entryWorkflowId,
            role: 'app',
            kind: 'message',
            content: { text: finalText, agentId: orchestratorAgent.id, agentName: pkg.name },
          });
          await stream.writeSSE({
            event: 'message',
            data: JSON.stringify({ id: reply.id, role: 'app', kind: 'message', content: reply.content, createdAt: reply.createdAt }),
          });
          try {
            if (deps.sessionAtoms && finalText.length >= 80) {
              deps.sessionAtoms.add({
                workspaceId: ws.workspaceId,
                appId: pkg.id,
                sessionId,
                content: `App reply: ${finalText.slice(0, 1200)}`,
                confidence: 0.55,
              });
            }
            deps.peerRepresentations?.enqueueSessionUpdate({
              workspaceId: ws.workspaceId,
              sessionId,
              peerId: ws.user.id,
              peerType: 'user',
              observerPeerId: orchestratorAgent.id,
            });
            deps.sessionAtoms?.promoteEligible({
              workspaceId: ws.workspaceId,
              sessionId,
              queue: deps.brainQueue,
            });
          } catch (err) {
            console.warn('brain_phase3.post_turn_failed', err);
          }
        }
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ finishReason: 'stop' }) });
      });
    });

    app.post('/:appId/thread/confirm', async (c) => {
      const ws = getWorkspace(c);
      const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
      const body = appThreadConfirmSchema.parse(await c.req.json());
      const orchestratorAgent = findOrchestratorAgentForWorkspace(deps.db, ws.workspaceId);
      const adapterReg = orchestratorAgent && deps.adapters ? deps.adapters.get(orchestratorAgent.id) : null;
      if (!orchestratorAgent || !adapterReg?.adapter?.chat) {
        throw new AgentisError('ADAPTER_UNAVAILABLE', 'No chat orchestrator is connected for this workspace yet.');
      }

      return streamSSE(c, async (stream) => {
        let finalText = '';
        try {
          for await (const delta of ChatSessionExecutor.confirm(adapterReg.adapter, body.turnId, body.confirmed, {
            workspaceId: ws.workspaceId,
            userId: ws.user.id,
            conversationId: `app:${pkg.id}`,
          })) {
            await stream.writeSSE({ event: 'delta', data: JSON.stringify(delta) });
            if (delta.type === 'text') finalText += delta.delta;
            if (delta.type === 'done') break;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errored = deps.appThread!.append({
            appId: pkg.id,
            workspaceId: ws.workspaceId,
            entryWorkflowId: pkg.entryWorkflowId,
            role: 'system',
            kind: 'error',
            content: { text: `Confirmation failed: ${errMsg}` },
          });
          await stream.writeSSE({ event: 'message', data: JSON.stringify({ id: errored.id, role: 'system', kind: 'error', content: errored.content, createdAt: errored.createdAt }) });
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ finishReason: 'error' }) });
          return;
        }

        if (finalText.trim()) {
          const reply = deps.appThread!.append({
            appId: pkg.id,
            workspaceId: ws.workspaceId,
            entryWorkflowId: pkg.entryWorkflowId,
            role: 'app',
            kind: 'message',
            content: { text: finalText, agentId: orchestratorAgent.id, agentName: pkg.name },
          });
          await stream.writeSSE({
            event: 'message',
            data: JSON.stringify({ id: reply.id, role: 'app', kind: 'message', content: reply.content, createdAt: reply.createdAt }),
          });
        }
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ finishReason: 'stop' }) });
      });
    });
  }

  if (deps.appResults) {
    app.get('/:appId/output', (c) => {
      const ws = getWorkspace(c);
      const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
      const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
      const before = c.req.query('before') ?? undefined;
      const results = deps.appResults!.list({ workspaceId: ws.workspaceId, appId: pkg.id, limit, before });
      return c.json({ appId: pkg.id, results });
    });

    app.get('/:appId/output/latest', (c) => {
      const ws = getWorkspace(c);
      const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
      const result = deps.appResults!.latest(ws.workspaceId, pkg.id);
      return c.json({ appId: pkg.id, result });
    });

    app.get('/:appId/output/search', (c) => {
      const ws = getWorkspace(c);
      const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
      const query = c.req.query('q')?.trim();
      if (!query) throw new AgentisError('VALIDATION_FAILED', 'query parameter `q` is required');
      const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20), 1), 100);
      const results = deps.appResults!.search({ workspaceId: ws.workspaceId, appId: pkg.id, query, limit });
      return c.json({ appId: pkg.id, query, results });
    });

    app.get('/:appId/output/:resultId', (c) => {
      const ws = getWorkspace(c);
      const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
      const resultId = c.req.param('resultId');
      const result = deps.appResults!.get(ws.workspaceId, resultId);
      if (result.appId !== pkg.id) throw new AgentisError('RESOURCE_NOT_FOUND', 'result does not belong to this app');
      return c.json({ result });
    });

    app.get('/:appId/output/:resultId/neighbours', (c) => {
      const ws = getWorkspace(c);
      const pkg = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId'));
      const resultId = c.req.param('resultId');
      const result = deps.appResults!.get(ws.workspaceId, resultId);
      if (result.appId !== pkg.id) throw new AgentisError('RESOURCE_NOT_FOUND', 'result does not belong to this app');
      const neighbours = deps.appResults!.neighbours(ws.workspaceId, pkg.id, result.createdAt);
      return c.json({ result, ...neighbours });
    });
  }

  return app;
}

/** Workspace orchestrator agent resolution — mirrors orchestratorEventBridge. */
function findOrchestratorAgentForWorkspace(db: AgentisSqliteDb, workspaceId: string) {
  const agents = db.select().from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).all();
  return agents.find((a) => a.role === 'orchestrator')
    ?? agents.find((a) => /agentis|orchestrator/i.test(a.name))
    ?? agents[0]
    ?? null;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function loadAppPackage(db: AgentisSqliteDb, workspaceId: string, appId: string) {
  const row = db
    .select()
    .from(schema.appInstances)
    .where(and(
      eq(schema.appInstances.workspaceId, workspaceId),
      or(eq(schema.appInstances.id, appId), eq(schema.appInstances.slug, appId))!,
    ))
    .get();
  if (!row) {
    throw new AgentisError('RESOURCE_NOT_FOUND', `app '${appId}' not installed`);
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    version: row.version,
    status: row.status,
    spaceId: row.spaceId,
    entryWorkflowId: row.entryWorkflowId,
    intendedBehavior: row.intendedBehavior ?? stringField((row.packageContents ?? {}) as Record<string, unknown>, ['intendedBehavior', 'summary', 'description']),
    deployTarget: row.deployTarget ?? 'local',
    deployStatus: normalizedDeployStatus(db, workspaceId, row.entryWorkflowId, row.deployStatus ?? 'stopped'),
    manifest: (row.packageContents ?? {}) as Record<string, unknown>,
    credentialBindings: objectRecord(row.credentialBindings),
    datasetStatuses: arrayRecord(row.datasetStatuses),
    knowledgeBaseIds: objectRecord(row.knowledgeBaseIds),
    installedAt: row.activatedAt,
    pausedAt: row.pausedAt,
    updatedAt: row.updatedAt,
  };
}

const ACTIVE_APP_RUN_STATUSES = ['RUNNING'];

function normalizedDeployStatus(
  db: AgentisSqliteDb,
  workspaceId: string,
  entryWorkflowId: string | null,
  deployStatus: string,
): string {
  if (deployStatus !== 'running') return deployStatus;
  if (!entryWorkflowId) return 'stopped';
  const activeRun = db
    .select({ id: schema.workflowRuns.id })
    .from(schema.workflowRuns)
    .where(and(
      eq(schema.workflowRuns.workspaceId, workspaceId),
      eq(schema.workflowRuns.workflowId, entryWorkflowId),
      inArray(schema.workflowRuns.status, ACTIVE_APP_RUN_STATUSES),
    ))
    .limit(1)
    .get();
  return activeRun ? 'running' : 'stopped';
}

function workflowIdsForApp(
  db: AgentisSqliteDb,
  workspaceId: string,
  pkg: ReturnType<typeof loadAppPackage>,
): string[] {
  const ids = new Set<string>();
  if (pkg.entryWorkflowId) ids.add(pkg.entryWorkflowId);
  const rows = db.select({ id: schema.workflows.id, tags: schema.workflows.tags })
    .from(schema.workflows)
    .where(eq(schema.workflows.workspaceId, workspaceId))
    .all();
  for (const row of rows) {
    const tags = Array.isArray(row.tags) ? row.tags.map(String) : [];
    if (tags.includes(pkg.slug)) ids.add(row.id);
  }
  return [...ids];
}

function appIssueLabel(slug: string) {
  return `app:${slug}`;
}

function durationMs(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function buildAppResultsSnapshot(
  db: AgentisSqliteDb,
  workspaceId: string,
  pkg: ReturnType<typeof loadAppPackage>,
  rawWindow: string | undefined,
) {
  const window = parseAppResultWindow(rawWindow);
  const periodMs = APP_RESULT_WINDOWS[window] * 24 * 60 * 60 * 1000;
  const currentStart = Date.now() - periodMs;
  const previousStart = currentStart - periodMs;
  const workflowIds = workflowIdsForApp(db, workspaceId, pkg);
  const workflows = workflowIds.length > 0
    ? db.select({ id: schema.workflows.id, title: schema.workflows.title })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), inArray(schema.workflows.id, workflowIds)))
        .all()
    : [];
  const workflowNameById = new Map(workflows.map((workflow) => [workflow.id, workflow.title]));
  const runs = workflowIds.length > 0
    ? db.select().from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), inArray(schema.workflowRuns.workflowId, workflowIds)))
        .orderBy(desc(schema.workflowRuns.createdAt))
        .limit(400)
        .all()
    : [];
  const currentRuns = runs.filter((run) => {
    const at = runTimestampMs(run);
    return at !== null && at >= currentStart;
  });
  const previousRuns = runs.filter((run) => {
    const at = runTimestampMs(run);
    return at !== null && at < currentStart && at >= previousStart;
  });
  const allAppRunIds = new Set(runs.map((run) => run.id));
  const currentRunIds = new Set(currentRuns.map((run) => run.id));
  const previousRunIds = new Set(previousRuns.map((run) => run.id));
  const budgetEvents = allAppRunIds.size > 0
    ? listBudgetEventsForWorkspace(db, workspaceId)
        .filter((event) => typeof event.runId === 'string' && allAppRunIds.has(event.runId))
    : [];
  const spendByRunId = new Map<string, number>();
  const spendByAgentId = new Map<string, number>();
  for (const event of budgetEvents) {
    if (event.eventType !== 'spend' || !event.runId) continue;
    if (currentRunIds.has(event.runId)) {
      spendByRunId.set(event.runId, (spendByRunId.get(event.runId) ?? 0) + Math.max(0, event.amountCents));
      spendByAgentId.set(event.agentId, (spendByAgentId.get(event.agentId) ?? 0) + Math.max(0, event.amountCents));
    }
  }
  const previousSpendByRunId = new Map<string, number>();
  for (const event of budgetEvents) {
    if (event.eventType !== 'spend' || !event.runId || !previousRunIds.has(event.runId)) continue;
    previousSpendByRunId.set(event.runId, (previousSpendByRunId.get(event.runId) ?? 0) + Math.max(0, event.amountCents));
  }

  const finishedRuns = currentRuns.filter((run) => run.status === 'COMPLETED' || run.status === 'FAILED');
  const completedRuns = finishedRuns.filter((run) => run.status === 'COMPLETED').length;
  const durations = finishedRuns
    .map((run) => durationMs(run.startedAt, run.completedAt))
    .filter((value): value is number => value !== null);
  const totalCost = currentRuns.reduce((sum, run) => sum + runCostDollars(run, spendByRunId.get(run.id)), 0);
  const previousTotalCost = previousRuns.reduce((sum, run) => sum + runCostDollars(run, previousSpendByRunId.get(run.id)), 0);
  const avgCostPerRun = currentRuns.length > 0 ? totalCost / currentRuns.length : 0;
  const spendCents = currentRuns.reduce((sum, run) => sum + runCostCents(run, spendByRunId.get(run.id)), 0);
  const previousSpendCents = previousRuns.reduce((sum, run) => sum + runCostCents(run, previousSpendByRunId.get(run.id)), 0);

  const agentIds = [...spendByAgentId.keys()];
  const agents = agentIds.length > 0
    ? db.select({ id: schema.agents.id, name: schema.agents.name })
        .from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, agentIds)))
        .all()
    : [];
  const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name]));
  const costByAgent = agentIds
    .map((agentId) => ({
      agentId,
      agentName: agentNameById.get(agentId) ?? 'Agent',
      cost: (spendByAgentId.get(agentId) ?? 0) / 100,
    }))
    .filter((item) => item.cost > 0)
    .sort((left, right) => right.cost - left.cost)
    .map((item) => ({
      ...item,
      share: totalCost > 0 ? item.cost / totalCost : 0,
    }));

  const runsById = new Map(runs.map((run) => [run.id, run]));
  const pendingApprovals = allAppRunIds.size > 0
    ? db.select().from(schema.approvalRequests)
        .where(and(eq(schema.approvalRequests.workspaceId, workspaceId), eq(schema.approvalRequests.status, 'pending')))
        .orderBy(desc(schema.approvalRequests.createdAt))
        .limit(50)
        .all()
        .filter((approval) => typeof approval.runId === 'string' && allAppRunIds.has(approval.runId))
        .slice(0, 20)
        .map((approval) => ({
          id: approval.id,
          title: approval.title,
          summary: approval.summary,
          runId: approval.runId ?? undefined,
          workflowName: approval.runId
            ? workflowNameById.get(runsById.get(approval.runId)?.workflowId ?? '') ?? undefined
            : undefined,
          createdAt: approval.createdAt,
        }))
    : [];

  const recentRuns = [...currentRuns]
    .sort((left, right) => (runTimestampMs(right) ?? 0) - (runTimestampMs(left) ?? 0))
    .slice(0, 10)
    .map((run) => ({
      id: run.id,
      workflowId: run.workflowId,
      workflowName: (run.workflowId ? workflowNameById.get(run.workflowId) : undefined) ?? 'Workflow',
      status: normalizeRunStatus(run.status),
      startedAt: run.startedAt ?? run.createdAt,
      durationMs: durationMs(run.startedAt, run.completedAt) ?? undefined,
      cost: runCostDollars(run, spendByRunId.get(run.id)),
      failedNode: failedNodeFromRun(run),
    }));

  const monthlyBudgetCents = numberField(pkg.manifest, ['monthlyBudgetCents', 'budgetCapCents']);
  const usageRatio = monthlyBudgetCents && monthlyBudgetCents > 0 ? spendCents / monthlyBudgetCents : null;
  const remainingCents = monthlyBudgetCents != null ? monthlyBudgetCents - spendCents : null;
  const deltaPct = previousTotalCost > 0
    ? ((totalCost - previousTotalCost) / previousTotalCost) * 100
    : totalCost > 0 ? 100 : 0;

  return {
    window,
    successRate: finishedRuns.length > 0 ? completedRuns / finishedRuns.length : 0,
    runCount: currentRuns.length,
    totalCost,
    avgCostPerRun,
    avgDurationMs: durations.length > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    metrics: [],
    pendingApprovals,
    recentRuns,
    costByAgent,
    trend: {
      previousTotalCost,
      previousSpendCents,
      deltaPct,
      direction: trendDirection(totalCost, previousTotalCost),
    },
    budget: {
      monthlyBudgetCents: monthlyBudgetCents ?? null,
      currentSpendCents: spendCents,
      remainingCents,
      usageRatio,
      status: budgetStatus(monthlyBudgetCents, spendCents),
    },
  };
}

function appDetailFromPackage(
  db: AgentisSqliteDb,
  workspaceId: string,
  pkg: ReturnType<typeof loadAppPackage>,
  extras: {
    knowledgeCount?: number;
    memoryCount?: number;
    spendSummary?: ReturnType<typeof buildAppResultsSnapshot>;
    domains?: Array<{ id: string; name: string; description?: string; workflowIds: string[] }>;
    intentHealth?: ReturnType<typeof appIntentHealth>;
  } = {},
) {
  const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
  const workflowRows = loadWorkflowRowsForApp(db, workspaceId, pkg);
  const workflows = workflowDetailsFromRows(db, workspaceId, pkg, workflowRows);
  const agents = agentDetailsFromWorkflowRows(db, workspaceId, workflowRows, manifest);
  const triggers = triggerDetailsFromWorkflowRows(db, workspaceId, workflowRows);
  const spendSummary = extras.spendSummary;
  return {
    id: pkg.id,
    slug: pkg.slug,
    name: pkg.name,
    version: pkg.version,
    status: pkg.status === 'setup' ? 'setup_needed' : pkg.status,
    description: typeof manifest.description === 'string'
      ? manifest.description
      : (manifest.summary as string | undefined) ?? '',
    intendedBehavior: pkg.intendedBehavior ?? stringField(manifest, ['intendedBehavior', 'summary', 'description']),
    category: stringField(manifest, ['category']) ?? null,
    spaceId: pkg.spaceId ?? null,
    iconGlyph: (manifest.iconGlyph as string | undefined) ?? 'A',
    iconColor: (manifest.iconColor as string | undefined) ?? '#15171c',
    iconUrl: stringField(manifest, ['iconUrl']) ?? null,
    coverImage: stringField(manifest, ['coverImage']) ?? null,
    entryWorkflowId: pkg.entryWorkflowId ?? null,
    deployTarget: pkg.deployTarget ?? 'local',
    deployStatus: pkg.deployStatus ?? 'stopped',
    installedAt: pkg.installedAt ?? null,
    outputLabels: outputLabelsFromManifest(manifest),
    domains: extras.domains ?? domainsFromManifest(manifest),
    dataTables: dataTablesFromManifest(manifest),
    workflows,
    agents,
    triggers,
    credentialSlots: credentialSlotsFromManifest(manifest).map((slot) => ({
      ...slot,
      bound: hasCredentialBinding(pkg.credentialBindings[slot.key]),
      bindingLabel: credentialBindingLabel(pkg.credentialBindings[slot.key]),
    })),
    datasetStatuses: pkg.datasetStatuses.map((status) => ({
      key: stringField(status, ['key']) ?? 'dataset',
      label: stringField(status, ['label']) ?? humanizeKey(stringField(status, ['key']) ?? 'dataset'),
      status: stringField(status, ['status']) ?? 'not_imported',
      optional: Boolean(status.optional),
      targetStore: stringField(status, ['targetStore']) ?? undefined,
      currentJobId: stringField(status, ['currentJobId', 'lastJobId']) ?? undefined,
    })),
    knowledgeSummary: {
      knowledgeBases: stringValues(pkg.knowledgeBaseIds).length,
      importedDatasets: pkg.datasetStatuses.filter((status) => stringField(status, ['status']) === 'imported').length,
      knowledgeItems: extras.knowledgeCount ?? 0,
      memoryItems: extras.memoryCount ?? 0,
    },
    spendSummary: {
      totalCost30d: spendSummary?.totalCost ?? 0,
      avgCostPerRun30d: spendSummary?.avgCostPerRun ?? 0,
      runCount30d: spendSummary?.runCount ?? 0,
      monthlyBudgetCents: spendSummary?.budget.monthlyBudgetCents ?? null,
      remainingBudgetCents: spendSummary?.budget.remainingCents ?? null,
      usageRatio: spendSummary?.budget.usageRatio ?? null,
      status: spendSummary?.budget.status ?? 'open',
    },
    intentHealth: extras.intentHealth ?? appIntentHealth(db, workspaceId, pkg),
  };
}

function appIntentHealth(
  db: AgentisSqliteDb,
  workspaceId: string,
  pkg: ReturnType<typeof loadAppPackage>,
) {
  return synthesizeAppIntentHealth({
    db,
    workspaceId,
    appId: pkg.id,
    intendedBehavior: pkg.intendedBehavior,
  });
}

function outputLabelsFromManifest(manifest: Record<string, unknown>) {
  const labels = sanitizeOutputLabels(arrayRecord(manifest.outputLabels));
  const graph = manifest.appGraphTemplate as AppGraph | undefined;
  for (const node of graph?.nodes ?? []) {
    if (node.type !== 'output_surface' || node.config.kind !== 'output_surface') continue;
    const key = node.config.outputKey?.trim();
    if (!key) continue;
    if (labels.some((label) => label.path === key)) continue;
    labels.push({
      label: humanizeKey(key),
      path: key,
      format: node.config.format,
      artifactType: node.config.artifactType,
    });
  }
  return sanitizeOutputLabels(labels);
}

/** Domain groups declared on the app's canvas template (§Layer 2). */
function domainsFromManifest(manifest: Record<string, unknown>) {
  const graph = manifest.appGraphTemplate as AppGraph | undefined;
  return (graph?.domains ?? []).map((domain) => ({
    id: domain.id,
    name: domain.name,
    description: domain.description,
    workflowIds: Array.isArray(domain.workflowIds) ? domain.workflowIds : [],
  }));
}

/** Declared Data layer tables (§Layer 3) — schema only, no records. */
function dataTablesFromManifest(manifest: Record<string, unknown>) {
  const raw = Array.isArray(manifest.dataTables) ? manifest.dataTables : [];
  return raw
    .filter((table): table is Record<string, unknown> => Boolean(table) && typeof table === 'object')
    .map((table) => ({
      name: stringField(table, ['name']) ?? 'table',
      description: stringField(table, ['description']) ?? null,
      fields: Object.entries((table.schema as Record<string, { type?: string }> | undefined) ?? {}).map(
        ([field, def]) => ({ name: field, type: def?.type ?? 'text' }),
      ),
    }));
}

function loadWorkflowRowsForApp(
  db: AgentisSqliteDb,
  workspaceId: string,
  pkg: ReturnType<typeof loadAppPackage>,
) {
  const workflowIds = workflowIdsForApp(db, workspaceId, pkg);
  return workflowIds.length > 0
    ? db.select().from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), inArray(schema.workflows.id, workflowIds)))
        .all()
    : [];
}

function workflowDetailsFromRows(
  db: AgentisSqliteDb,
  workspaceId: string,
  pkg: ReturnType<typeof loadAppPackage>,
  workflowRows: Array<typeof schema.workflows.$inferSelect>,
) {
  if (workflowRows.length === 0) {
    const workflowTemplates = (
      (pkg.manifest.workflowTemplates as Array<{ name?: string; title?: string; slug?: string }> | undefined)
      ?? (pkg.manifest.workflows as Array<{ title?: string; name?: string; slug?: string }> | undefined)
      ?? []
    );
    return workflowTemplates.map((workflow, index) => ({
      id: workflow.slug ?? `workflow-${index + 1}`,
      name: workflow.name ?? workflow.title ?? workflow.slug ?? `Workflow ${index + 1}`,
      status: 'idle',
      route: `/workflows/${workflow.slug ?? `workflow-${index + 1}`}`,
      triggerCount: 0,
      activeTriggerCount: 0,
      lastRunAt: null,
    }));
  }
  const workflowIds = workflowRows.map((workflow) => workflow.id);
  const triggerRows = db.select().from(schema.triggers)
    .where(and(eq(schema.triggers.workspaceId, workspaceId), inArray(schema.triggers.workflowId, workflowIds)))
    .all();
  const runRows = db.select().from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), inArray(schema.workflowRuns.workflowId, workflowIds)))
    .orderBy(desc(schema.workflowRuns.createdAt))
    .limit(Math.max(120, workflowRows.length * 20))
    .all();
  const triggersByWorkflow = groupBy(triggerRows, (row) => row.workflowId);
  const runsByWorkflow = groupBy(runRows, (row) => row.workflowId ?? '');
  return [...workflowRows]
    .sort((left, right) => {
      if (left.id === pkg.entryWorkflowId) return -1;
      if (right.id === pkg.entryWorkflowId) return 1;
      return left.title.localeCompare(right.title);
    })
    .map((workflow) => {
      const triggers = triggersByWorkflow.get(workflow.id) ?? [];
      const runs = runsByWorkflow.get(workflow.id) ?? [];
      const lastRun = runs[0] ?? null;
      const hasActiveRun = runs.some((run) => isRunningRun(run.status));
      const hasRecentFailure = runs.some((run) => run.status === 'FAILED' && isRecent(runTimestampMs(run), 24 * 60 * 60 * 1000));
      const activeTriggerCount = triggers.filter((trigger) => trigger.status === 'active').length;
      return {
        id: workflow.id,
        name: workflow.title,
        status: hasActiveRun
          ? 'running'
          : hasRecentFailure
            ? 'failed'
            : activeTriggerCount > 0
              ? 'active'
              : triggers.length > 0
                ? 'paused'
                : 'idle',
        route: `/workflows/${workflow.id}`,
        triggerCount: triggers.length,
        activeTriggerCount,
        lastRunAt: lastRun?.startedAt ?? lastRun?.createdAt ?? null,
      };
    });
}

function agentDetailsFromWorkflowRows(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflowRows: Array<{ graph: unknown }>,
  manifest: Record<string, unknown>,
) {
  const agentIds = [...extractAgentIdsFromWorkflowRows(workflowRows)];
  const manifestAgentNames = new Set(
    (((manifest.agents as Array<{ name?: string }> | undefined) ?? [])
      .map((agent) => agent.name?.trim())
      .filter((name): name is string => Boolean(name))),
  );
  const agents = agentIds.length > 0
    ? db.select().from(schema.agents)
        .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, agentIds)))
        .all()
    : manifestAgentNames.size > 0
      ? db.select().from(schema.agents)
          .where(eq(schema.agents.workspaceId, workspaceId))
          .all()
          .filter((agent) => manifestAgentNames.has(agent.name))
      : [];
  if (agents.length === 0) {
    return ((manifest.agents as Array<{ name?: string }> | undefined) ?? []).map((agent, index) => ({
      id: `agent-${index + 1}`,
      name: agent.name ?? `Agent ${index + 1}`,
      status: 'idle',
      role: null,
      route: null,
      lastHeartbeatAt: null,
      currentTaskId: null,
    }));
  }
  return [...agents]
    .sort((left, right) => rankAgentStatus(right.status) - rankAgentStatus(left.status) || left.name.localeCompare(right.name))
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      role: agent.role ?? null,
      route: `/agents/${agent.id}`,
      lastHeartbeatAt: agent.lastHeartbeatAt ?? null,
      currentTaskId: agent.currentTaskId ?? null,
    }));
}

function triggerDetailsFromWorkflowRows(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflowRows: Array<typeof schema.workflows.$inferSelect>,
) {
  const workflowIds = workflowRows.map((workflow) => workflow.id);
  if (workflowIds.length === 0) return [];
  const workflowNameById = new Map(workflowRows.map((workflow) => [workflow.id, workflow.title]));
  return db.select().from(schema.triggers)
    .where(and(eq(schema.triggers.workspaceId, workspaceId), inArray(schema.triggers.workflowId, workflowIds)))
    .orderBy(desc(schema.triggers.createdAt))
    .all()
    .map((trigger) => ({
      id: trigger.id,
      workflowId: trigger.workflowId,
      workflowName: workflowNameById.get(trigger.workflowId) ?? 'Workflow',
      triggerType: trigger.triggerType,
      status: trigger.status,
      lastFiredAt: trigger.lastFiredAt,
      summary: triggerSummary(trigger.triggerType, trigger.config),
      webhookUrl: trigger.triggerType === 'webhook' ? `/v1/webhooks/trigger/${trigger.id}` : null,
    }));
}

function credentialSlotsFromManifest(manifest: Record<string, unknown>) {
  return arrayRecord(manifest.credentialSlots).map((slot, index) => ({
    key: stringField(slot, ['key']) ?? `credential-${index + 1}`,
    service: stringField(slot, ['service']) ?? 'integration',
    label: stringField(slot, ['label']) ?? humanizeKey(stringField(slot, ['key']) ?? `credential-${index + 1}`),
    required: slot.required !== false,
    oauthFlow: Boolean(slot.oauthFlow),
    profile: stringField(slot, ['profile']) ?? null,
  }));
}

function extractAgentIdsFromWorkflowRows(rows: Array<{ graph: unknown }>) {
  const ids = new Set<string>();
  for (const row of rows) {
    const graph = objectRecord(row.graph);
    const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(isRecord) : [];
    for (const node of nodes) {
      const config = objectRecord(node.config);
      const agentId = stringField(config, ['agentId']);
      if (agentId) ids.add(agentId);
    }
  }
  return ids;
}

function sanitizeOutputLabels(labels: Array<Record<string, unknown>>) {
  const seen = new Set<string>();
  const normalized: Array<{ label: string; path: string; format?: string; artifactType?: string }> = [];
  for (const label of labels) {
    const path = stringField(label, ['path']);
    const humanLabel = stringField(label, ['label']) ?? (path ? humanizeKey(path) : undefined);
    if (!path || !humanLabel || seen.has(path)) continue;
    seen.add(path);
    normalized.push({
      label: humanLabel,
      path,
      format: stringField(label, ['format']) ?? undefined,
      artifactType: stringField(label, ['artifactType']) ?? undefined,
    });
  }
  return normalized;
}

function setManifestOptional(manifest: Record<string, unknown>, key: string, value: string | null | undefined) {
  if (value === undefined) return;
  if (value === null || value.trim().length === 0) {
    delete manifest[key];
    return;
  }
  manifest[key] = value.trim();
}

function objectRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function arrayRecord(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(source: unknown, keys: string[]): string | undefined {
  if (!isRecord(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function stringValues(source: Record<string, unknown>): string[] {
  return Object.values(source).filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function numberField(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), item]);
  }
  return grouped;
}

function parseAppResultWindow(raw: string | undefined): AppResultWindow {
  if (raw === '1d' || raw === '7d' || raw === '30d') return raw;
  return '7d';
}

function runTimestampMs(run: { startedAt: string | null; createdAt: string }) {
  const stamp = Date.parse(run.startedAt ?? run.createdAt);
  return Number.isFinite(stamp) ? stamp : null;
}

function runCostMicros(run: { runState: unknown } & Record<string, unknown>) {
  const direct = typeof run.costMicros === 'number' ? run.costMicros : null;
  if (direct != null && Number.isFinite(direct)) return Math.max(0, direct);
  const state = objectRecord(run.runState);
  const observability = objectRecord(state.observability);
  const nested = observability.costMicros;
  return typeof nested === 'number' && Number.isFinite(nested) ? Math.max(0, nested) : 0;
}

function runCostDollars(run: { runState: unknown } & Record<string, unknown>, fallbackCents?: number) {
  const micros = runCostMicros(run);
  if (micros > 0) return micros / 1_000_000;
  if (fallbackCents && fallbackCents > 0) return fallbackCents / 100;
  return 0;
}

function runCostCents(run: { runState: unknown } & Record<string, unknown>, fallbackCents?: number) {
  const micros = runCostMicros(run);
  if (micros > 0) return Math.round(micros / 10_000);
  if (fallbackCents && fallbackCents > 0) return fallbackCents;
  return 0;
}

function normalizeRunStatus(status: string) {
  switch (status.toUpperCase()) {
    case 'COMPLETED': return 'completed';
    case 'FAILED': return 'failed';
    case 'CANCELLED': return 'cancelled';
    case 'WAITING': return 'waiting';
    case 'CREATED':
    case 'PLANNING':
    case 'RUNNING':
      return 'running';
    default:
      return status.toLowerCase();
  }
}

function failedNodeFromRun(run: { runState: unknown } & Record<string, unknown>) {
  const state = objectRecord(run.runState);
  const failure = objectRecord(state.failure);
  return stringField(failure, ['nodeId', 'failedNode', 'node']);
}

function trendDirection(current: number, previous: number) {
  if (Math.abs(current - previous) < 0.005) return 'flat';
  if (current > previous) return 'up';
  return 'down';
}

function budgetStatus(limitCents: number | null, spendCents: number) {
  if (limitCents == null || limitCents <= 0) return 'open';
  if (spendCents >= limitCents) return 'over';
  if (spendCents >= limitCents * 0.8) return 'near';
  return 'ok';
}

function rankAgentStatus(status: string | null) {
  if (status === 'busy' || status === 'active' || status === 'running') return 4;
  if (status === 'online') return 3;
  if (status === 'error') return 2;
  if (status === 'offline') return 1;
  return 0;
}

function isRunningRun(status: string) {
  return status.toUpperCase() === 'RUNNING';
}

function isRecent(timestamp: number | null, thresholdMs: number) {
  return timestamp !== null && Date.now() - timestamp <= thresholdMs;
}

function triggerSummary(triggerType: string, config: unknown) {
  const values = objectRecord(config);
  if (triggerType === 'cron') return stringField(values, ['cron', 'expression', 'schedule']) ?? 'Scheduled trigger';
  if (triggerType === 'webhook') return stringField(values, ['path', 'event', 'topic']) ?? 'Webhook trigger';
  if (triggerType === 'persistent_listener') return stringField(values, ['channel', 'source', 'topic']) ?? 'Listener trigger';
  return 'Manual trigger';
}

function hasCredentialBinding(value: unknown) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!isRecord(value)) return false;
  return Boolean(stringField(value, ['label', 'name', 'credentialId', 'id']));
}

function credentialBindingLabel(value: unknown) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return stringField(value, ['label', 'name', 'credentialId', 'id']) ?? null;
}

function listBudgetEventsForWorkspace(db: AgentisSqliteDb, workspaceId: string) {
  const client = (db as unknown as {
    $client: {
      prepare: (statement: string) => {
        all: (workspaceId: string) => Array<{
          id: string;
          workspaceId: string;
          agentId: string;
          runId: string | null;
          eventType: string;
          amountCents: number;
          balanceAfterCents: number;
          createdAt: string;
        }>;
      };
    };
  }).$client;
  return client.prepare(`
    SELECT
      id,
      workspace_id AS workspaceId,
      agent_id AS agentId,
      run_id AS runId,
      event_type AS eventType,
      amount_cents AS amountCents,
      balance_after_cents AS balanceAfterCents,
      created_at AS createdAt
    FROM budget_events
    WHERE workspace_id = ?
    ORDER BY created_at DESC
    LIMIT 2000
  `).all(workspaceId);
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function appKindLabel(kind: z.infer<typeof createAppSchema>['appKind']): string {
  switch (kind) {
    case 'automation': return 'Automation';
    case 'assistant': return 'Assistant';
    case 'research': return 'Research';
    case 'support': return 'Support';
    case 'sales': return 'Sales';
    case 'operations': return 'Operations';
    case 'custom': return 'Custom';
  }
}

function appKindGlyph(kind: z.infer<typeof createAppSchema>['appKind']): string {
  switch (kind) {
    case 'assistant': return 'A';
    case 'research': return 'R';
    case 'support': return 'S';
    case 'sales': return '$';
    case 'operations': return 'O';
    case 'custom': return '*';
    case 'automation': return 'Z';
  }
}

function numberQuery(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function sessionAtomConfidence(message: string): number {
  const trimmed = message.trim();
  if (/\b(remember|important|always|never|prefer|preference|we use|my workflow|our process)\b/i.test(trimmed)) return 0.78;
  if (trimmed.length > 500) return 0.68;
  if (trimmed.length > 160) return 0.62;
  return 0.56;
}

function appKindColor(kind: z.infer<typeof createAppSchema>['appKind']): string {
  switch (kind) {
    case 'assistant': return '#7c83ff';
    case 'research': return '#22d3ee';
    case 'support': return '#34d399';
    case 'sales': return '#f59e0b';
    case 'operations': return '#a78bfa';
    case 'custom': return '#94a3b8';
    case 'automation': return '#f43f5e';
  }
}

function parseIntOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function computeBaselineConfidence(
  baselines: Array<{ sampleSize: number; successRate?: number }>,
): number | null {
  if (baselines.length === 0) return null;
  // Weighted by sample size: bigger samples count more.
  let totalWeight = 0;
  let weightedConfidence = 0;
  for (const b of baselines) {
    const w = Math.max(1, b.sampleSize);
    const c = 1 - Math.exp(-b.sampleSize / 10);
    totalWeight += w;
    weightedConfidence += w * c;
  }
  return totalWeight > 0 ? weightedConfidence / totalWeight : null;
}

// Re-export types used by callers — keeps the routes file self-contained.
export type { MemoryEpisode };
