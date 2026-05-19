/**
 * App API Surface (AGENTIS-PLATFORM-10X §Layer 1 / §A1).
 *
 * Generalizes `WorkflowDeploymentService` from "deploy one workflow" to
 * "deploy a whole app". Every app that declares an `api` surface gets a
 * stable URL rooted at this server:
 *
 *   http://<host>/apps/<slug>/api/...
 *
 * Built-in routes (always available when an `api` surface is declared):
 *   GET    /apps/:slug/api/data/:table        → paginated, filterable list
 *   GET    /apps/:slug/api/data/:table/:id    → single record
 *   POST   /apps/:slug/api/data/:table        → insert a record
 *   POST   /apps/:slug/api/trigger/:workflow  → start a workflow run
 *
 * Plus every route declared in the manifest's `apiRoutes`.
 *
 * The webhook receiver surface lives here too:
 *   POST   /apps/:slug/webhook[/:hook]        → start the entry workflow
 *
 * Mounted at `/apps` (NOT `/v1/apps`) so it is reachable by external systems
 * without the platform's JWT auth — it has its own api-key auth model.
 */

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { AgentisPackageContents, AppApiRoute, AppDeployConfig } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AppDataService } from '../services/appDataService.js';
import { AppDashboardService } from '../services/appDashboardService.js';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';

interface AppApiSurfaceDeps {
  db: AgentisSqliteDb;
  appData: AppDataService;
  triggerRuntime: TriggerRuntime;
  bus: EventBus;
  logger: Logger;
}

type AppRow = typeof schema.appInstances.$inferSelect;

export function buildAppApiSurfaceRoutes(deps: AppApiSurfaceDeps) {
  const app = new Hono();
  const dashboardService = new AppDashboardService(deps.appData);

  // ── Resolve the app by slug for every route ────────────────────────────
  const resolveApp = (c: Context): AppRow | null => {
    const slug = c.req.param('slug');
    if (!slug) return null;
    return (
      deps.db.select().from(schema.appInstances).where(eq(schema.appInstances.slug, slug)).get() ??
      null
    );
  };

  const contentsOf = (row: AppRow): AgentisPackageContents =>
    (row.packageContents ?? {}) as unknown as AgentisPackageContents;

  /** Authorize a request against the app's api-server auth model. */
  const authorize = (c: Context, row: AppRow, routeAuth?: AppApiRoute['auth']): boolean => {
    const deploy = contentsOf(row).deployConfig as AppDeployConfig | undefined;
    const mode = routeAuth ?? deploy?.apiServer?.auth ?? 'api_key';
    if (mode === 'public' || mode === 'none') return true;
    const presented = c.req.header('x-api-key') ?? bearerToken(c);
    if (!presented) return false;
    if (!row.apiKeyHash) return false;
    return sha256(presented) === row.apiKeyHash;
  };

  /** Resolve a workflow id for the app by slug, title-slug, or entry default. */
  const resolveWorkflow = (row: AppRow, slugOrId?: string): string | null => {
    const workflows = deps.db
      .select({ id: schema.workflows.id, title: schema.workflows.title })
      .from(schema.workflows)
      .where(eq(schema.workflows.appId, row.id))
      .all();
    if (!slugOrId) return row.entryWorkflowId ?? workflows[0]?.id ?? null;
    const direct = workflows.find((w) => w.id === slugOrId);
    if (direct) return direct.id;
    const bySlug = workflows.find((w) => slugify(w.title) === slugify(slugOrId));
    return bySlug?.id ?? row.entryWorkflowId ?? null;
  };

  const hasApiSurface = (row: AppRow): boolean => {
    const c = contentsOf(row);
    const surfaces = c.surfaces ?? [];
    return (
      surfaces.some((s) => s.type === 'api') ||
      (c.deployConfig as AppDeployConfig | undefined)?.target === 'api_server'
    );
  };

  const hasSurface = (row: AppRow, type: string): boolean =>
    (contentsOf(row).surfaces ?? []).some((s) => s.type === type);

  // ── Built-in: Data layer REST ──────────────────────────────────────────

  app.get('/:slug/api/data/:table', (c) => {
    const row = resolveApp(c);
    if (!row || !hasApiSurface(row)) return c.json({ error: 'app api surface not found' }, 404);
    if (!authorize(c, row)) return c.json({ error: 'unauthorized' }, 401);
    const table = c.req.param('table');
    try {
      const where: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c.req.query())) {
        if (['limit', 'offset', 'orderBy', 'orderDir'].includes(k)) continue;
        where[k] = v;
      }
      const result = deps.appData.query(row.id, table, {
        where,
        limit: numParam(c, 'limit', 50),
        offset: numParam(c, 'offset', 0),
        orderBy: c.req.query('orderBy'),
        orderDir: c.req.query('orderDir') === 'asc' ? 'asc' : 'desc',
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.get('/:slug/api/data/:table/:id', (c) => {
    const row = resolveApp(c);
    if (!row || !hasApiSurface(row)) return c.json({ error: 'app api surface not found' }, 404);
    if (!authorize(c, row)) return c.json({ error: 'unauthorized' }, 401);
    try {
      const record = deps.appData.getRecord(row.id, c.req.param('table'), c.req.param('id'));
      if (!record) return c.json({ error: 'record not found' }, 404);
      return c.json({ record });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.post('/:slug/api/data/:table', async (c) => {
    const row = resolveApp(c);
    if (!row || !hasApiSurface(row)) return c.json({ error: 'app api surface not found' }, 404);
    if (!authorize(c, row)) return c.json({ error: 'unauthorized' }, 401);
    const body = await safeJson(c);
    try {
      const { id } = deps.appData.insert(
        row.workspaceId,
        row.id,
        c.req.param('table'),
        body as Record<string, unknown>,
      );
      return c.json({ id }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── Built-in: trigger a workflow ───────────────────────────────────────

  app.post('/:slug/api/trigger/:workflow', async (c) => {
    const row = resolveApp(c);
    if (!row || !hasApiSurface(row)) return c.json({ error: 'app api surface not found' }, 404);
    if (!authorize(c, row)) return c.json({ error: 'unauthorized' }, 401);
    const workflowId = resolveWorkflow(row, c.req.param('workflow'));
    if (!workflowId) return c.json({ error: 'workflow not found' }, 404);
    const body = await safeJson(c);
    try {
      const result = await deps.triggerRuntime.startWorkflowRun({
        workflowId,
        workspaceId: row.workspaceId,
        ambientId: row.ambientId,
        userId: row.userId,
        inputs: body as Record<string, unknown>,
      });
      emitApiRequest(deps, row, c.req.path, 'trigger_workflow');
      return c.json({ runId: result.runId }, 202);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ── Built-in: artifact surface ─────────────────────────────────────────

  /** List the artifacts produced by this app's workflows. */
  app.get('/:slug/api/artifacts', (c) => {
    const row = resolveApp(c);
    if (!row || !hasApiSurface(row)) return c.json({ error: 'app api surface not found' }, 404);
    if (!authorize(c, row)) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ artifacts: listAppArtifacts(deps.db, row, false) });
  });

  /** Fetch one artifact (including its content). */
  app.get('/:slug/api/artifacts/:id', (c) => {
    const row = resolveApp(c);
    if (!row || !hasApiSurface(row)) return c.json({ error: 'app api surface not found' }, 404);
    if (!authorize(c, row)) return c.json({ error: 'unauthorized' }, 401);
    const artifact = listAppArtifacts(deps.db, row, true).find((a) => a.id === c.req.param('id'));
    if (!artifact) return c.json({ error: 'artifact not found' }, 404);
    return c.json({ artifact });
  });

  // ── Manifest-declared apiRoutes ────────────────────────────────────────

  app.all('/:slug/api/*', async (c) => {
    const row = resolveApp(c);
    if (!row || !hasApiSurface(row)) return c.json({ error: 'app api surface not found' }, 404);
    const contents = contentsOf(row);
    const routes = contents.apiRoutes ?? [];
    const subPath = '/' + c.req.path.split('/api/').slice(1).join('/api/');
    const method = c.req.method.toUpperCase();
    const match = routes.find(
      (r) => r.method === method && pathMatches(r.path, subPath),
    );
    if (!match) return c.json({ error: 'route not declared' }, 404);
    if (!authorize(c, row, match.auth)) return c.json({ error: 'unauthorized' }, 401);

    try {
      if (match.handler === 'query_data' && match.dataTable) {
        const result = deps.appData.query(row.id, match.dataTable, {
          limit: numParam(c, 'limit', 50),
          offset: numParam(c, 'offset', 0),
        });
        return c.json(result);
      }
      if (match.handler === 'trigger_workflow') {
        const workflowId = resolveWorkflow(row, match.workflowSlug);
        if (!workflowId) return c.json({ error: 'workflow not found' }, 404);
        const body = await safeJson(c);
        const result = await deps.triggerRuntime.startWorkflowRun({
          workflowId,
          workspaceId: row.workspaceId,
          ambientId: row.ambientId,
          userId: row.userId,
          inputs: body as Record<string, unknown>,
        });
        emitApiRequest(deps, row, subPath, 'trigger_workflow');
        return c.json({ runId: result.runId }, 202);
      }
      return c.json({ error: `handler ${match.handler} not supported` }, 501);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ── Webhook receiver surface ───────────────────────────────────────────

  const webhookHandler = async (c: Context) => {
    const row = resolveApp(c);
    if (!row) return c.json({ error: 'app not found' }, 404);
    const contents = contentsOf(row);
    const hasWebhook = (contents.surfaces ?? []).some((s) => s.type === 'webhook_receiver');
    if (!hasWebhook) return c.json({ error: 'webhook surface not declared' }, 404);
    const body = await safeJson(c);
    const workflowId = resolveWorkflow(row, c.req.param('hook'));
    if (!workflowId) return c.json({ error: 'no workflow bound to webhook' }, 404);
    try {
      const result = await deps.triggerRuntime.startWorkflowRun({
        workflowId,
        workspaceId: row.workspaceId,
        ambientId: row.ambientId,
        userId: row.userId,
        inputs: {
          source: 'webhook',
          hook: c.req.param('hook') ?? 'default',
          receivedAt: new Date().toISOString(),
          ...(body as Record<string, unknown>),
        },
      });
      return c.json({ accepted: true, runId: result.runId }, 202);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  };
  app.post('/:slug/webhook', webhookHandler);
  app.post('/:slug/webhook/:hook', webhookHandler);

  // ── Stream surface — SSE feed of the app's event bus ───────────────────

  app.get('/:slug/stream', (c) => {
    const row = resolveApp(c);
    if (!row || !hasSurface(row, 'stream')) return c.json({ error: 'stream surface not declared' }, 404);
    if (!authorize(c, row)) return c.json({ error: 'unauthorized' }, 401);
    const appRoom = REALTIME_ROOMS.app(row.id);
    // Optional `?events=a,b` filter narrows the stream to specific event names.
    const filter = (c.req.query('events') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ appId: row.id, at: new Date().toISOString() }) });
      const unsubscribe = deps.bus.subscribe((msg) => {
        if (msg.room !== appRoom) return;
        if (filter.length > 0 && !filter.includes(msg.envelope.event)) return;
        void stream.writeSSE({
          event: msg.envelope.event,
          data: JSON.stringify(msg.envelope.payload ?? {}),
        });
      });
      // Hold the stream open until the client disconnects.
      await new Promise<void>((resolve) => {
        const signal = c.req.raw.signal;
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      unsubscribe();
    });
  });

  // ── Page surface — live HTML page the app owns ─────────────────────────

  const pageHandler = (c: Context) => {
    const row = resolveApp(c);
    if (!row || !hasSurface(row, 'page')) return c.text('page surface not declared', 404);
    // The page content is the most recent `html` artifact (optionally named).
    const name = c.req.param('name');
    const artifacts = listAppArtifacts(deps.db, row, true).filter((a) => a.type === 'html');
    const page = name
      ? artifacts.find((a) => slugify(a.title) === slugify(name))
      : artifacts[0];
    if (!page) {
      return c.html(shellHtml(row.name ?? 'App', '<p>This page has not been generated yet.</p>'));
    }
    return c.html(typeof page.content === 'string' ? page.content : shellHtml(row.name ?? 'App', ''));
  };
  app.get('/:slug/page', pageHandler);
  app.get('/:slug/page/:name', pageHandler);

  // ── Embed surface — iframe-able live status widget ─────────────────────

  app.get('/:slug/embed', (c) => {
    const row = resolveApp(c);
    if (!row || !hasSurface(row, 'embed')) return c.text('embed surface not declared', 404);
    const contents = contentsOf(row);
    // Server-render the dashboard into the widget so the iframe needs no auth.
    const dashboard = dashboardService.compute(row.id, contents.dashboard);
    return c.html(embedHtml(row.name ?? 'App', dashboard.metrics));
  });

  return app;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Hash an api key for storage. Exported so the apps route can mint keys. */
export function hashApiKey(key: string): string {
  return sha256(key);
}

function bearerToken(c: Context): string | null {
  const h = c.req.header('authorization');
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function numParam(c: Context, key: string, fallback: number): number {
  const raw = c.req.query(key);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** Match a declared route path (supporting `:param` segments) to a request path. */
function pathMatches(declared: string, actual: string): boolean {
  const d = declared.split('/').filter(Boolean);
  const a = actual.split('/').filter(Boolean);
  if (d.length !== a.length) return false;
  return d.every((seg, i) => seg.startsWith(':') || seg === a[i]);
}

export interface AppArtifact {
  id: string;
  type: string;
  title: string;
  runId: string | null;
  nodeId: string | null;
  metadata: unknown;
  createdAt: string;
  content?: string;
}

/** List artifacts produced by any of an app's workflows. */
function listAppArtifacts(db: AgentisSqliteDb, row: AppRow, includeContent: boolean): AppArtifact[] {
  const workflowIds = db
    .select({ id: schema.workflows.id })
    .from(schema.workflows)
    .where(eq(schema.workflows.appId, row.id))
    .all()
    .map((w) => w.id);
  if (workflowIds.length === 0) return [];
  const rows = db
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.workspaceId, row.workspaceId),
        inArray(schema.artifacts.workflowId, workflowIds),
      ),
    )
    .orderBy(desc(schema.artifacts.createdAt))
    .limit(200)
    .all();
  return rows.map((a) => ({
    id: a.id,
    type: a.type,
    title: a.title,
    runId: a.runId,
    nodeId: a.nodeId,
    metadata: a.metadata,
    createdAt: a.createdAt,
    ...(includeContent ? { content: a.content } : {}),
  }));
}

/** Escape a value for safe interpolation into served HTML. */
function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shellHtml(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;margin:0;padding:24px;background:#0c0c0e;color:#e8e8ea">` +
    `<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h1>${body}</body></html>`
  );
}

function embedHtml(
  title: string,
  metrics: Array<{ label: string; value: number; format: string }>,
): string {
  const cards = metrics
    .map(
      (m) =>
        `<div style="flex:1;min-width:120px;border:1px solid #2a2a2e;border-radius:10px;padding:12px">` +
        `<div style="font-size:11px;text-transform:uppercase;color:#8a8a90">${escapeHtml(m.label)}</div>` +
        `<div style="font-size:22px;font-weight:600;margin-top:6px">${escapeHtml(m.value)}</div></div>`,
    )
    .join('');
  const body =
    `<div style="display:flex;flex-wrap:wrap;gap:10px">${cards || '<p style="color:#8a8a90">No metrics yet.</p>'}</div>`;
  return shellHtml(title, body);
}

function emitApiRequest(
  deps: AppApiSurfaceDeps,
  row: AppRow,
  path: string,
  handler: string,
): void {
  try {
    deps.bus.publish(REALTIME_ROOMS.app(row.id), REALTIME_EVENTS.APP_API_REQUEST, {
      appId: row.id,
      workspaceId: row.workspaceId,
      path,
      handler,
      at: new Date().toISOString(),
    });
  } catch {
    /* non-critical */
  }
}
