/**
 * /v1/apps/:id/{data,deploy} — authenticated management of the app's
 * Data layer (Layer 3) and Deploy layer (Layer 5) — AGENTIS-PLATFORM-10X.
 *
 * Mounted as a second router on `/v1/apps` alongside `buildAppRoutes`; Hono
 * merges the two. Keeping it isolated avoids touching the 2k-line apps.ts.
 *
 * The Data tab (schema viewer + record browser) and the Deploy tab
 * (deployment target, API routes, api-key minting) are served from here.
 */

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, count, eq, gte, inArray, max } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import type { AgentisPackageContents } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { AppDataService } from '../services/appDataService.js';
import { AppDashboardService } from '../services/appDashboardService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { hashApiKey } from './appApiSurface.js';

interface AppDeployDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  appData: AppDataService;
}

const DEPLOY_TARGETS = ['local', 'always_on', 'scheduled', 'api_server'] as const;

// ── Surface status ─────────────────────────────────────────────────────────

interface SurfaceStatusItem {
  type: string;
  label: string;
  configured: boolean;
  live: boolean;
  activityToday: number;
  activityUnit: string;
  lastActivityAt: string | null;
}

const SURFACE_DISPLAY: Record<string, { label: string; unit: string }> = {
  thread:           { label: 'Thread',           unit: 'message' },
  api:              { label: 'API',              unit: 'request' },
  webhook_receiver: { label: 'Webhook receiver', unit: 'webhook' },
  stream:           { label: 'Stream',           unit: 'event'   },
  embed:            { label: 'Embed',            unit: 'view'    },
  page:             { label: 'Page',             unit: 'view'    },
  artifact:         { label: 'Artifact',         unit: 'artifact'},
  dashboard:        { label: 'Dashboard',        unit: 'view'    },
};

/**
 * Core surfaces always shown so operators can see what is and isn't active.
 * Any additional manifest-declared surfaces are appended after these.
 */
const CORE_SURFACE_TYPES = ['thread', 'api', 'webhook_receiver'];

function computeSurfaceStatus(
  db: AgentisSqliteDb,
  appId: string,
  entryWorkflowId: string | null,
  surfaces: Array<{ type: string; label?: string }>,
  deployStatus: string,
  todayIso: string,
): SurfaceStatusItem[] {
  const surfaceSet = new Set(surfaces.map((s) => s.type));
  const isRunning = deployStatus === 'running';

  // Thread — count all app thread messages today
  const threadRow = db
    .select({ cnt: count(), last: max(schema.appThreadMessages.createdAt) })
    .from(schema.appThreadMessages)
    .where(and(
      eq(schema.appThreadMessages.appId, appId),
      gte(schema.appThreadMessages.createdAt, todayIso),
    ))
    .get();

  // API — count materialized app results today (proxy for API-surface outputs)
  const apiRow = db
    .select({ cnt: count(), last: max(schema.appResults.createdAt) })
    .from(schema.appResults)
    .where(and(
      eq(schema.appResults.appId, appId),
      gte(schema.appResults.createdAt, todayIso),
    ))
    .get();

  // Webhook receiver — count deliveries via the app's entry workflow triggers
  let webhookRow: { cnt: number; last: string | null } | undefined;
  if (entryWorkflowId) {
    webhookRow = db
      .select({ cnt: count(), last: max(schema.webhookDeliveries.receivedAt) })
      .from(schema.webhookDeliveries)
      .innerJoin(schema.triggers, eq(schema.triggers.id, schema.webhookDeliveries.triggerId))
      .where(and(
        eq(schema.triggers.workflowId, entryWorkflowId),
        gte(schema.webhookDeliveries.receivedAt, todayIso),
      ))
      .get();
  }

  const allTypes = [...new Set([...CORE_SURFACE_TYPES, ...surfaces.map((s) => s.type)])];

  return allTypes.map((type) => {
    const configured = surfaceSet.has(type);
    const live = configured && isRunning;
    const display = SURFACE_DISPLAY[type] ?? { label: type, unit: 'event' };
    const userLabel = surfaces.find((s) => s.type === type)?.label;
    let activityToday = 0;
    let lastActivityAt: string | null = null;
    if (configured) {
      switch (type) {
        case 'thread':
          activityToday = threadRow?.cnt ?? 0;
          lastActivityAt = threadRow?.last ?? null;
          break;
        case 'api':
          activityToday = apiRow?.cnt ?? 0;
          lastActivityAt = apiRow?.last ?? null;
          break;
        case 'webhook_receiver':
          activityToday = webhookRow?.cnt ?? 0;
          lastActivityAt = webhookRow?.last ?? null;
          break;
      }
    }
    return {
      type,
      label: userLabel ?? display.label,
      configured,
      live,
      activityToday,
      activityUnit: display.unit,
      lastActivityAt,
    };
  });
}

export function buildAppDeployRoutes(deps: AppDeployDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));
  const dashboardService = new AppDashboardService(deps.appData);

  const loadApp = (c: Context) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id') ?? '';
    const row = deps.db
      .select()
      .from(schema.appInstances)
      .where(and(eq(schema.appInstances.id, id), eq(schema.appInstances.workspaceId, ws.workspaceId)))
      .get();
    return { ws, row: row ?? null };
  };

  // ── Data layer ─────────────────────────────────────────────────────────

  /** List the app's Data tables with declared schema + row counts. */
  app.get('/:id/data', (c) => {
    const { row } = loadApp(c);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'app not found');
    const tables = deps.appData.listTables(row.id).map((t) => ({
      ...t,
      schema: deps.appData.schema(row.id, t.name),
    }));
    return c.json({ tables });
  });

  /**
   * Surface signals — auto-derived business metrics from the Data layer plus
   * a recent-records feed for the unified work feed (SURFACE-PAGE-REDESIGN.md §6).
   *
   * Registered before `/:id/data/:table` so `signals` is not treated as a
   * table name by the wildcard route.
   */
  app.get('/:id/data/signals', (c) => {
    const { row } = loadApp(c);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'app not found');
    const tables = deps.appData.listTables(row.id);
    const signals: SurfaceSignal[] = [];
    const recentRecords: SurfaceRecord[] = [];

    for (const meta of tables) {
      const declared = deps.appData.schema(row.id, meta.name);
      const fields = declared ? Object.keys(declared.schema) : [];
      let records: Array<Record<string, unknown>> = [];
      try {
        records = deps.appData.query(row.id, meta.name, { limit: 1000, orderBy: 'created_at', orderDir: 'desc' }).records;
      } catch {
        records = [];
      }
      for (const rec of records.slice(0, 8)) {
        recentRecords.push({
          table: meta.name,
          recordId: String(rec.id ?? ''),
          record: rec,
          createdAt: typeof rec.created_at === 'string' ? rec.created_at : new Date().toISOString(),
        });
      }
      deriveTableSignals(meta.name, fields, records, meta.rowCount, signals);
    }

    recentRecords.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ signals: signals.slice(0, 6), recentRecords: recentRecords.slice(0, 16) });
  });

  /**
   * Dashboard surface — metrics, charts, and tables computed live from the
   * Data layer. Driven by the manifest `dashboard` declaration; auto-generated
   * from the Data schema when no declaration exists.
   */
  app.get('/:id/dashboard', (c) => {
    const { row } = loadApp(c);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'app not found');
    const contents = (row.packageContents ?? {}) as unknown as AgentisPackageContents;
    return c.json(dashboardService.compute(row.id, contents.dashboard));
  });

  /** Browse records in one Data table. */
  app.get('/:id/data/:table', (c) => {
    const { row } = loadApp(c);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'app not found');
    try {
      const result = deps.appData.query(row.id, c.req.param('table'), {
        limit: numQuery(c, 'limit', 50),
        offset: numQuery(c, 'offset', 0),
        orderBy: c.req.query('orderBy'),
        orderDir: c.req.query('orderDir') === 'asc' ? 'asc' : 'desc',
      });
      return c.json(result);
    } catch (err) {
      throw new AgentisError('RESOURCE_NOT_FOUND', (err as Error).message);
    }
  });

  /** Operator manual insert into a Data table. */
  app.post('/:id/data/:table', async (c) => {
    const { row } = loadApp(c);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'app not found');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const { id } = deps.appData.insert(row.workspaceId, row.id, c.req.param('table'), body);
    return c.json({ id }, 201);
  });

  app.delete('/:id/data/:table/:recordId', (c) => {
    const { row } = loadApp(c);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'app not found');
    deps.appData.delete(row.workspaceId, row.id, c.req.param('table'), c.req.param('recordId'));
    return c.json({ ok: true });
  });

  // ── Deploy layer ───────────────────────────────────────────────────────

  /** Deploy tab payload: target, status, declared routes, surfaces. */
  app.get('/:id/deploy', (c) => {
    const { row } = loadApp(c);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'app not found');
    const contents = (row.packageContents ?? {}) as unknown as AgentisPackageContents;
    const deployStatus = normalizedDeployStatus(deps.db, row.workspaceId, row.entryWorkflowId, row.deployStatus);
    const surfaces = contents.surfaces ?? [];
    const todayIso = new Date(new Date().toDateString()).toISOString();
    return c.json({
      deployTarget: row.deployTarget,
      deployStatus,
      hasApiKey: !!row.apiKeyHash,
      surfaces,
      surfaceEndpoints: surfaceEndpoints(row.slug, surfaces),
      surfaceStatus: computeSurfaceStatus(deps.db, row.id, row.entryWorkflowId, surfaces, deployStatus, todayIso),
      apiRoutes: contents.apiRoutes ?? [],
      deployConfig: contents.deployConfig ?? null,
      baseUrl: `/apps/${row.slug}/api`,
      webhookUrl: surfaces.some((s) => s.type === 'webhook_receiver')
        ? `/apps/${row.slug}/webhook`
        : null,
    });
  });

  /** Change the deployment target / status. */
  app.put('/:id/deploy', async (c) => {
    const { row } = loadApp(c);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'app not found');
    const body = (await c.req.json().catch(() => ({}))) as {
      target?: string;
      status?: string;
    };
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.target) {
      if (!DEPLOY_TARGETS.includes(body.target as (typeof DEPLOY_TARGETS)[number])) {
        throw new AgentisError('VALIDATION_FAILED', `invalid deploy target: ${body.target}`);
      }
      patch.deployTarget = body.target;
    }
    if (body.status && ['stopped', 'running', 'error'].includes(body.status)) {
      patch.deployStatus = body.status;
    }
    deps.db.update(schema.appInstances).set(patch).where(eq(schema.appInstances.id, row.id)).run();
    return c.json({ ok: true, deployTarget: patch.deployTarget ?? row.deployTarget });
  });

  /** Mint a fresh API key — the raw key is returned exactly once. */
  app.post('/:id/deploy/api-key', (c) => {
    const { row } = loadApp(c);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'app not found');
    const key = `agk_${randomBytes(24).toString('hex')}`;
    deps.db
      .update(schema.appInstances)
      .set({ apiKeyHash: hashApiKey(key), updatedAt: new Date().toISOString() })
      .where(eq(schema.appInstances.id, row.id))
      .run();
    return c.json({ apiKey: key, note: 'Store this now — it is not retrievable later.' }, 201);
  });

  return app;
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

/** External URL for each declared surface that exposes one. */
function surfaceEndpoints(
  slug: string,
  surfaces: Array<{ type: string; label?: string }>,
): Array<{ type: string; label: string; url: string }> {
  const base = `/apps/${slug}`;
  const urlFor: Record<string, string> = {
    api: `${base}/api`,
    webhook_receiver: `${base}/webhook`,
    stream: `${base}/stream`,
    embed: `${base}/embed`,
    page: `${base}/page`,
    artifact: `${base}/api/artifacts`,
  };
  const out: Array<{ type: string; label: string; url: string }> = [];
  for (const s of surfaces) {
    const url = urlFor[s.type];
    if (url) out.push({ type: s.type, label: s.label ?? s.type, url });
  }
  return out;
}

function numQuery(c: Context, key: string, fallback: number): number {
  const raw = c.req.query(key);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

interface SurfaceSignal {
  id: string;
  label: string;
  value: string;
  format: 'count' | 'percent' | 'currency' | 'ratio';
  table: string;
  trend?: 'up' | 'down' | 'flat';
}

interface SurfaceRecord {
  table: string;
  recordId: string;
  record: Record<string, unknown>;
  createdAt: string;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Window-over-window trend on record creation timestamps. */
function recordTrend(records: Array<Record<string, unknown>>): 'up' | 'down' | 'flat' {
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  let recent = 0;
  let prior = 0;
  for (const rec of records) {
    const ts = typeof rec.created_at === 'string' ? new Date(rec.created_at).getTime() : NaN;
    if (!Number.isFinite(ts)) continue;
    if (ts >= now - week) recent += 1;
    else if (ts >= now - 2 * week) prior += 1;
  }
  if (recent > prior) return 'up';
  if (recent < prior) return 'down';
  return 'flat';
}

/**
 * Derive operator-facing signals from one Data table's schema + records.
 * Mirrors the derivation rules in SURFACE-PAGE-REDESIGN.md §6.
 */
function deriveTableSignals(
  table: string,
  fields: string[],
  records: Array<Record<string, unknown>>,
  rowCount: number,
  out: SurfaceSignal[],
): void {
  const lower = table.toLowerCase();
  const has = (field: string) => fields.includes(field);
  let specific = false;

  if (lower === 'leads' || lower.endsWith('_leads') || lower === 'lead') {
    out.push({ id: `${table}.count`, label: 'Total Leads', value: String(rowCount), format: 'count', table, trend: recordTrend(records) });
    specific = true;
  }
  if (has('sentiment')) {
    const values = records.map((r) => num(r.sentiment)).filter((v): v is number => v !== null);
    if (values.length > 0) {
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      out.push({ id: `${table}.sentiment`, label: 'Avg Sentiment', value: avg.toFixed(2), format: 'ratio', table });
      specific = true;
    }
  }
  if (has('spend') && has('budget')) {
    const spend = records.reduce((s, r) => s + (num(r.spend) ?? 0), 0);
    const budget = records.reduce((s, r) => s + (num(r.budget) ?? 0), 0);
    out.push({
      id: `${table}.spend`,
      label: 'Spend',
      value: budget > 0 ? `$${spend.toFixed(2)} / $${budget.toFixed(0)}` : `$${spend.toFixed(2)}`,
      format: 'currency',
      table,
    });
    specific = true;
  }
  if (lower.includes('ticket') && has('status')) {
    const open = records.filter((r) => String(r.status ?? '').toLowerCase() === 'open').length;
    out.push({ id: `${table}.open`, label: 'Open Tickets', value: String(open), format: 'count', table, trend: recordTrend(records) });
    specific = true;
  }
  if (has('pass_count')) {
    const latest = records[0];
    if (latest) {
      const pass = num(latest.pass_count) ?? 0;
      const fail = num(latest.fail_count) ?? 0;
      const total = pass + fail;
      out.push({
        id: `${table}.pass`,
        label: 'Tests Passing',
        value: total > 0 ? `${Math.round((pass / total) * 100)}%` : '—',
        format: 'percent',
        table,
      });
      specific = true;
    }
  }
  if (has('churn_risk')) {
    const high = records.filter((r) => (num(r.churn_risk) ?? 0) > 0.7).length;
    out.push({ id: `${table}.churn`, label: 'High Churn Risk', value: String(high), format: 'count', table });
    specific = true;
  }
  // Generic fallback so every declared table still contributes one signal.
  if (!specific) {
    out.push({ id: `${table}.rows`, label: `${humanize(table)} records`, value: String(rowCount), format: 'count', table, trend: recordTrend(records) });
  }
}
