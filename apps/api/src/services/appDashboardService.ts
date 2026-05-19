/**
 * AppDashboardService — the dashboard surface (§Layer 1).
 *
 * Computes a live dashboard payload from the app's Data layer. When the app
 * manifest declares a `dashboard` (metrics + charts), those declarations drive
 * the payload. When it does not, a sensible default dashboard is auto-generated
 * from the Data schema — one count metric and one time-series chart per table —
 * so every app with a Data layer gets a usable dashboard with zero config.
 */

import type { AppDashboard, AppDataTable } from '@agentis/core';
import { AppDataService, safeMatch } from './appDataService.js';

export interface DashboardMetric {
  label: string;
  value: number;
  format: 'count' | 'sum' | 'avg' | 'min' | 'max';
  table: string;
}

export interface DashboardChartPoint {
  label: string;
  value: number;
}

export interface DashboardChart {
  type: 'line' | 'bar' | 'pie' | 'area';
  label: string;
  table: string;
  points: DashboardChartPoint[];
}

export interface DashboardTable {
  name: string;
  description: string | null;
  rowCount: number;
  columns: string[];
  recent: Array<Record<string, unknown>>;
}

export interface DashboardPayload {
  metrics: DashboardMetric[];
  charts: DashboardChart[];
  tables: DashboardTable[];
  generated: 'manifest' | 'auto';
  refreshIntervalSeconds: number;
  computedAt: string;
}

const SAMPLE_LIMIT = 500;
const DEFAULT_REFRESH = 30;

export class AppDashboardService {
  constructor(private readonly appData: AppDataService) {}

  /**
   * Compute the dashboard for an app. `dashboard` is the manifest declaration
   * (may be undefined — then a default dashboard is generated).
   */
  compute(appId: string, dashboard: AppDashboard | undefined | null): DashboardPayload {
    const tables = this.appData.listTables(appId);
    const declared = new Map<string, AppDataTable>();
    for (const t of tables) {
      const s = this.appData.schema(appId, t.name);
      if (s) declared.set(t.name, s);
    }

    const hasManifest = !!(dashboard && ((dashboard.metrics?.length ?? 0) > 0 || (dashboard.charts?.length ?? 0) > 0));
    const metrics: DashboardMetric[] = [];
    const charts: DashboardChart[] = [];

    if (hasManifest && dashboard) {
      for (const m of dashboard.metrics ?? []) {
        const records = this.#load(appId, m.table);
        metrics.push({
          label: m.label,
          value: aggregate(records, m.aggregation, m.field, m.filter, m.timeBucket),
          format: m.aggregation,
          table: m.table,
        });
      }
      for (const ch of dashboard.charts ?? []) {
        const records = this.#load(appId, ch.table);
        charts.push({
          type: ch.type,
          label: ch.label,
          table: ch.table,
          points: chartPoints(records, ch),
        });
      }
    } else {
      // Auto-generate: one count metric + one time-series chart per table.
      for (const [name, decl] of declared) {
        const records = this.#load(appId, name);
        metrics.push({
          label: `${humanize(name)} records`,
          value: records.length,
          format: 'count',
          table: name,
        });
        charts.push({
          type: 'line',
          label: `${humanize(name)} over time`,
          table: name,
          points: chartPoints(records, { valueField: '', timeField: 'created_at' }),
        });
      }
    }

    const pinned = dashboard?.pinnedTables;
    const tablePayload: DashboardTable[] = [];
    for (const t of tables) {
      if (pinned && pinned.length > 0 && !pinned.includes(t.name)) continue;
      const decl = declared.get(t.name);
      const recent = this.appData
        .query(appId, t.name, { limit: 10, orderBy: 'created_at', orderDir: 'desc' })
        .records;
      tablePayload.push({
        name: t.name,
        description: t.description,
        rowCount: t.rowCount,
        columns: decl ? ['id', ...Object.keys(decl.schema), 'created_at'] : ['id', 'created_at'],
        recent,
      });
    }

    return {
      metrics,
      charts,
      tables: tablePayload,
      generated: hasManifest ? 'manifest' : 'auto',
      refreshIntervalSeconds: dashboard?.defaultRefreshIntervalSeconds ?? DEFAULT_REFRESH,
      computedAt: new Date().toISOString(),
    };
  }

  #load(appId: string, table: string): Array<Record<string, unknown>> {
    try {
      return this.appData.query(appId, table, {
        limit: SAMPLE_LIMIT,
        orderBy: 'created_at',
        orderDir: 'desc',
      }).records;
    } catch {
      return [];
    }
  }
}

// ────────────────────────────────────────────────────────────
// Aggregation helpers
// ────────────────────────────────────────────────────────────

function aggregate(
  records: Array<Record<string, unknown>>,
  agg: 'count' | 'sum' | 'avg' | 'min' | 'max',
  field: string,
  filter?: string,
  timeBucket?: 'today' | '7d' | '30d' | 'all',
): number {
  let rows = records;
  if (timeBucket && timeBucket !== 'all') rows = rows.filter((r) => withinBucket(r, timeBucket));
  if (filter) rows = rows.filter((r) => safeMatch(filter, r));
  if (agg === 'count') return rows.length;
  const nums = rows
    .map((r) => toNumber(r[field]))
    .filter((n): n is number => n !== null);
  if (nums.length === 0) return 0;
  switch (agg) {
    case 'sum':
      return round(nums.reduce((s, n) => s + n, 0));
    case 'avg':
      return round(nums.reduce((s, n) => s + n, 0) / nums.length);
    case 'min':
      return round(Math.min(...nums));
    case 'max':
      return round(Math.max(...nums));
  }
}

function chartPoints(
  records: Array<Record<string, unknown>>,
  ch: {
    valueField: string;
    timeField?: string;
    groupBy?: string;
    aggregation?: 'count' | 'sum' | 'avg';
  },
): DashboardChartPoint[] {
  const agg = ch.aggregation ?? 'count';
  const buckets = new Map<string, number[]>();

  for (const rec of records) {
    let key: string;
    if (ch.groupBy) {
      key = String(rec[ch.groupBy] ?? '—');
    } else {
      const tf = ch.timeField ?? 'created_at';
      const ts = typeof rec[tf] === 'string' ? new Date(rec[tf] as string) : null;
      if (!ts || Number.isNaN(ts.getTime())) continue;
      key = ts.toISOString().slice(0, 10); // day bucket
    }
    const val = ch.valueField ? toNumber(rec[ch.valueField]) : 1;
    const arr = buckets.get(key) ?? [];
    arr.push(val ?? 0);
    buckets.set(key, arr);
  }

  const points = [...buckets.entries()].map(([label, vals]) => {
    let value: number;
    if (agg === 'count') value = vals.length;
    else if (agg === 'sum') value = vals.reduce((s, n) => s + n, 0);
    else value = vals.reduce((s, n) => s + n, 0) / Math.max(1, vals.length);
    return { label, value: round(value) };
  });
  // Time buckets sort chronologically; group buckets sort by value desc.
  if (!ch.groupBy) points.sort((a, b) => a.label.localeCompare(b.label));
  else points.sort((a, b) => b.value - a.value);
  return points.slice(0, 60);
}

function withinBucket(rec: Record<string, unknown>, bucket: 'today' | '7d' | '30d'): boolean {
  const raw = rec.created_at;
  if (typeof raw !== 'string') return false;
  const ts = new Date(raw).getTime();
  if (Number.isNaN(ts)) return false;
  const now = Date.now();
  const span = bucket === 'today' ? 86_400_000 : bucket === '7d' ? 7 * 86_400_000 : 30 * 86_400_000;
  return ts >= now - span;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
