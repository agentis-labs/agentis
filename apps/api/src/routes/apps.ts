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
 * `:appId` resolves to either an `agent_packages.id` row or any opaque string
 * the operator chose when seeding workflows directly. The wedge stores key
 * off the same `app_id` concept, so we don't validate it against a registry.
 */

import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import {
  AgentisError,
  type AppGraph,
  type DatasetSpec,
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
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

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
}

export function buildAppRoutes(deps: AppsRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ── Top-level app listing ─────────────────────────────────
  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.agentPackages)
      .where(eq(schema.agentPackages.workspaceId, ws.workspaceId))
      .all();
    const apps = rows.map((row) => {
      const manifest = (row.manifest ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        slug: (manifest.slug as string) ?? row.id,
        installedAt: row.installedAt,
      };
    });
    return c.json({ count: apps.length, apps });
  });

  // ── App summary + manifest ────────────────────────────────
  app.get('/:appId', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('appId');
    const pkg = loadAppPackage(deps.db, ws.workspaceId, appId);
    return c.json(pkg);
  });

  // ── Intelligence response ─────────────────────────────────
  app.get('/:appId/intelligence', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('appId');
    const pkg = loadAppPackage(deps.db, ws.workspaceId, appId);

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
        label: spec.label,
        wedgeRole: spec.wedgeRole,
        status: latest?.status ?? 'pending',
        freshness: spec.freshnessExpectation ?? null,
        targetStore: spec.targetStore,
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
        slug: (manifest.slug as string) ?? pkg.id,
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
    const appId = c.req.param('appId');
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
    const appId = c.req.param('appId');
    const pkg = loadAppPackage(deps.db, ws.workspaceId, appId);
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
    const appId = c.req.param('appId');
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

  // ── Start an ingestion job ────────────────────────────────
  // Accepts three content types:
  //   1. application/json: { payload: string, fileName?, encoding?: 'base64'|'utf8' }
  //   2. multipart/form-data: file field (binary), optional fileName field
  //   3. application/octet-stream: raw bytes; fileName from ?fileName= or X-File-Name
  app.post('/:appId/datasets/:key/ingest', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('appId');
    const key = c.req.param('key');
    const pkg = loadAppPackage(deps.db, ws.workspaceId, appId);
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
    const appId = c.req.param('appId');
    const jobId = c.req.param('jobId');

    // Load the job first to get datasetKey for spec lookup.
    const job = deps.ingestion.byId(ws.workspaceId, jobId);
    if (!job) throw new AgentisError('RESOURCE_NOT_FOUND', `ingestion job '${jobId}' not found`);

    // Resolve DatasetSpec from the app manifest.
    const pkg = loadAppPackage(deps.db, ws.workspaceId, appId);
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
    const appId = c.req.param('appId');
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
    const appId = c.req.param('appId');
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
    const appId = c.req.param('appId');
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
  app.get('/:appId/evaluator-examples', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('appId');
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
  });

  // ── Baselines ─────────────────────────────────────────────
  app.get('/:appId/baselines', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('appId');
    const baselines = deps.baselines.latestForApp(ws.workspaceId, appId);
    return c.json({ count: baselines.length, baselines });
  });

  // ── Promoted patterns (Class 4) ───────────────────────────
  app.get('/:appId/promoted-patterns', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('appId');
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
    const appId = c.req.param('appId');
    const record = deps.canvas.load(ws.workspaceId, appId);
    return c.json({
      app: { id: record.id, slug: record.slug, name: record.name, status: record.status },
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
    const appId = c.req.param('appId');
    const body = (await c.req.json().catch(() => null)) as { graph?: AppGraph } | null;
    if (!body || !body.graph || typeof body.graph !== 'object') {
      throw new AgentisError(
        'VALIDATION_FAILED',
        'PATCH body must include a `graph` field with an AppGraph object',
      );
    }
    const record = deps.canvas.save(ws.workspaceId, appId, body.graph);
    return c.json({
      app: { id: record.id, slug: record.slug, name: record.name, status: record.status },
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
    const appId = c.req.param('appId');
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

  app.post('/:appId/canvas/from-package', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('appId');
    const record = deps.canvas.resetFromPackage(ws.workspaceId, appId);
    return c.json({
      app: { id: record.id, slug: record.slug, name: record.name, status: record.status },
      graph: record.graph,
      references: record.references,
      validation: {
        errors: record.validation.errors.map(({ severity: _s, ...rest }) => rest),
        warnings: record.validation.warnings.map(({ severity: _s, ...rest }) => rest),
      },
    });
  });

  return app;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function loadAppPackage(db: AgentisSqliteDb, workspaceId: string, appId: string) {
  const row = db
    .select()
    .from(schema.agentPackages)
    .where(and(eq(schema.agentPackages.id, appId), eq(schema.agentPackages.workspaceId, workspaceId)))
    .get();
  if (!row) {
    // Permissive fallback — returns a stub so wedge endpoints work even when
    // the app id doesn't correspond to an installed package (e.g. when the
    // operator seeded workflows directly). The rest of the wedge stores key
    // off `appId` independently of `agentPackages`.
    return {
      id: appId,
      name: appId,
      version: '0.0.0',
      manifest: {},
      installedAt: new Date().toISOString(),
    };
  }
  return row;
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
