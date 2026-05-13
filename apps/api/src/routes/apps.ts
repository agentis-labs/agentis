/**
 * /v1/apps — App Knowledge Wedge HTTP surface.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §15.
 *
 * Routes:
 *   GET    /v1/apps                                       → list installed apps
 *   GET    /v1/apps/:appId                                → app summary + dataset specs
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
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AgentisError,
  type AgentisPackageContents,
  type AppGraph,
  type DatasetSpec,
  type DatasetIngestionJob,
  type MemoryEpisode,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
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
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { PackagerService } from '../services/packager.js';

const createAppSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(220).optional().default(''),
  goal: z.string().min(1).max(1200),
  appKind: z.enum(['automation', 'assistant', 'research', 'support', 'sales', 'operations', 'custom']).default('automation'),
  category: z.string().max(80).optional(),
  coverImage: z.string().max(2000).optional().nullable(),
  iconGlyph: z.string().max(8).optional(),
  iconColor: z.string().max(32).optional(),
});

export interface AppsRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  knowledge: KnowledgeStore;
  appMemory: AppMemoryStore;
  evaluators: EvaluatorExampleStore;
  baselines: WorkflowBaselineStore;
  intelligence: AppIntelligenceRuntime;
  promotion: IntelligencePromotion;
  ingestion: DatasetIngestion;
  canvas: AppCanvasService;
  brain: BrainComposer;
  collectiveBrain: CollectiveBrainService;
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
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        slug: row.slug,
        status,
        spaceId: row.spaceId,
        description: (contents.description as string | undefined) ?? (contents.summary as string | undefined) ?? '',
        category: (contents.category as string | undefined) ?? null,
        iconGlyph: (contents.iconGlyph as string | undefined) ?? 'A',
        iconColor: (contents.iconColor as string | undefined) ?? '#15171c',
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
      coverImage: body.coverImage ?? null,
      iconGlyph: body.iconGlyph ?? appKindGlyph(body.appKind),
      iconColor: body.iconColor ?? appKindColor(body.appKind),
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
        tags: ['guided-app', body.appKind, category],
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
        category,
        iconGlyph: contents.iconGlyph,
        iconColor: contents.iconColor,
        path: `${used.path}?layer=canvas&new=1`,
      },
    }, 201);
  });

  // ── App summary + manifest ────────────────────────────────
  app.get('/:appId', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('appId');
    const pkg = loadAppPackage(deps.db, ws.workspaceId, appId);
    return c.json({ app: appDetailFromPackage(pkg) });
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
    const id = c.req.param('id');
    const body = (await c.req.json()) as Partial<
      Pick<MemoryEpisode, 'title' | 'content' | 'trust' | 'importance' | 'tags'>
    >;
    const updated = deps.appMemory.update(ws.workspaceId, id, body);
    if (!updated) throw new AgentisError('RESOURCE_NOT_FOUND', `memory '${id}' not found`);
    return c.json({ episode: updated });
  });

  app.delete('/:appId/memory/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const deleted = deps.appMemory.delete(ws.workspaceId, id);
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

  app.get('/:appId/evaluator-examples', listEvaluatorExamples);
  app.post('/:appId/evaluator-examples', createEvaluatorExample);
  app.get('/:appId/evaluators/examples', listEvaluatorExamples);
  app.post('/:appId/evaluators/examples', createEvaluatorExample);

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

  app.get('/:appId/brain/graph', (c) => {
    const ws = getWorkspace(c);
    const appId = loadAppPackage(deps.db, ws.workspaceId, c.req.param('appId')).id;
    const graph = deps.collectiveBrain.getGraph(ws.workspaceId, {
      scope: 'app',
      appId,
      minConfidence: numberQuery(c.req.query('minConfidence')) ?? undefined,
      limit: numberQuery(c.req.query('limit')) ?? undefined,
    });
    return c.json({ graph });
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
    const workflowIds = workflowIdsForApp(deps.db, ws.workspaceId, pkg);
    const runs = workflowIds.length > 0
      ? deps.db.select().from(schema.workflowRuns)
          .where(and(eq(schema.workflowRuns.workspaceId, ws.workspaceId), inArray(schema.workflowRuns.workflowId, workflowIds)))
          .orderBy(desc(schema.workflowRuns.createdAt))
          .limit(100)
          .all()
      : [];
    const finished = runs.filter((run) => run.status === 'COMPLETED' || run.status === 'FAILED');
    const completed = finished.filter((run) => run.status === 'COMPLETED').length;
    const durations = finished
      .map((run) => durationMs(run.startedAt, run.completedAt))
      .filter((value): value is number => value !== null);
    return c.json({
      successRate: finished.length > 0 ? completed / finished.length : 0,
      runCount: runs.length,
      totalCost: 0,
      avgDurationMs: durations.length > 0 ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
      metrics: [],
      pendingApprovals: deps.db.select().from(schema.approvalRequests)
        .where(and(eq(schema.approvalRequests.workspaceId, ws.workspaceId), eq(schema.approvalRequests.status, 'pending')))
        .orderBy(desc(schema.approvalRequests.createdAt))
        .limit(20)
        .all(),
      recentRuns: runs.slice(0, 10),
    });
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

  return app;
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
    entryWorkflowId: row.entryWorkflowId,
    manifest: (row.packageContents ?? {}) as Record<string, unknown>,
    installedAt: row.activatedAt,
  };
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

function durationMs(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function appDetailFromPackage(pkg: ReturnType<typeof loadAppPackage>) {
  const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
  const workflowTemplates = (
    (manifest.workflowTemplates as Array<{ name?: string; title?: string; slug?: string }> | undefined)
    ?? (manifest.workflows as Array<{ title?: string; name?: string; slug?: string }> | undefined)
    ?? []
  );
  const workflows = workflowTemplates.map((workflow, index) => ({
    id: workflow.slug ?? `workflow-${index + 1}`,
    name: workflow.name ?? workflow.title ?? workflow.slug ?? `Workflow ${index + 1}`,
  }));
  const agents = ((manifest.agents as Array<{ name?: string }> | undefined) ?? []).map((agent, index) => ({
    id: `agent-${index + 1}`,
    name: agent.name ?? `Agent ${index + 1}`,
  }));
  return {
    id: pkg.id,
    slug: pkg.slug,
    name: pkg.name,
    version: pkg.version,
    status: pkg.status === 'setup' ? 'setup_needed' : pkg.status,
    description: (manifest.description as string | undefined) ?? (manifest.summary as string | undefined) ?? '',
    iconGlyph: (manifest.iconGlyph as string | undefined) ?? 'A',
    iconColor: (manifest.iconColor as string | undefined) ?? '#15171c',
    entryWorkflowId: pkg.entryWorkflowId ?? null,
    outputLabels: outputLabelsFromManifest(manifest),
    workflows,
    agents,
  };
}

function outputLabelsFromManifest(manifest: Record<string, unknown>) {
  const labels = Array.isArray(manifest.outputLabels)
    ? [...(manifest.outputLabels as Array<Record<string, unknown>>)]
    : [];
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
  return labels;
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
