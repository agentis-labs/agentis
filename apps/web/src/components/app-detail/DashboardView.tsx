/**
 * DashboardView — the dashboard surface (AGENTIS-PLATFORM-10X §Layer 1).
 *
 * A live operator command center: metric cards, charts, and record tables
 * computed from the app's Data layer. Driven by the manifest `dashboard`
 * declaration; auto-generated from the Data schema when none is declared.
 * Polls `/v1/apps/:id/dashboard` on the app-declared refresh interval.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutDashboard, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { Skeleton } from '../shared/Skeleton';
import { EmptyState } from '../shared/EmptyState';
import { Button } from '../shared/Button';

interface DashboardMetric {
  label: string;
  value: number;
  format: 'count' | 'sum' | 'avg' | 'min' | 'max';
  table: string;
}
interface DashboardChartPoint {
  label: string;
  value: number;
}
interface DashboardChart {
  type: 'line' | 'bar' | 'pie' | 'area';
  label: string;
  table: string;
  points: DashboardChartPoint[];
}
interface DashboardTable {
  name: string;
  description: string | null;
  rowCount: number;
  columns: string[];
  recent: Array<Record<string, unknown>>;
}
interface DashboardPayload {
  metrics: DashboardMetric[];
  charts: DashboardChart[];
  tables: DashboardTable[];
  generated: 'manifest' | 'auto';
  refreshIntervalSeconds: number;
  computedAt: string;
}

function formatValue(v: number, format: DashboardMetric['format']): string {
  if (format === 'avg') return v.toFixed(2);
  return Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v);
}

export function DashboardView({ appId }: { appId: string }) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const payload = await api<DashboardPayload>(`/v1/apps/${appId}/dashboard`);
      setData(payload);
    } catch {
      setData({
        metrics: [],
        charts: [],
        tables: [],
        generated: 'auto',
        refreshIntervalSeconds: 30,
        computedAt: new Date().toISOString(),
      });
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh on the app-declared interval.
  useEffect(() => {
    if (!data) return;
    timer.current = setTimeout(() => void load(), Math.max(5, data.refreshIntervalSeconds) * 1000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [data, load]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  if (!data || (data.metrics.length === 0 && data.charts.length === 0 && data.tables.length === 0)) {
    return (
      <EmptyState
        icon={<LayoutDashboard size={28} />}
        title="No dashboard data yet"
        body="This app's dashboard fills in once its Data layer has records. Run a workflow that writes to a Data table."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-text-muted">
          {data.generated === 'manifest' ? 'Declared dashboard' : 'Auto-generated from Data schema'}
          {' · updated '}
          {new Date(data.computedAt).toLocaleTimeString()}
        </p>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCw size={13} /> Refresh
        </Button>
      </div>

      {data.metrics.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {data.metrics.map((m, i) => (
            <div key={`${m.label}-${i}`} className="rounded-card border border-line bg-surface p-4">
              <p className="text-[11px] uppercase tracking-wide text-text-muted">{m.label}</p>
              <p className="mt-2 text-2xl font-semibold text-text">{formatValue(m.value, m.format)}</p>
              <p className="mt-1 text-[11px] text-text-muted">
                {m.format} · {m.table}
              </p>
            </div>
          ))}
        </div>
      )}

      {data.charts.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {data.charts.map((ch, i) => (
            <ChartCard key={`${ch.label}-${i}`} chart={ch} />
          ))}
        </div>
      )}

      {data.tables.length > 0 && (
        <div className="flex flex-col gap-4">
          {data.tables.map((t) => (
            <TableCard key={t.name} table={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChartCard({ chart }: { chart: DashboardChart }) {
  const points = chart.points;
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <p className="text-[13px] font-medium text-text">{chart.label}</p>
      <p className="text-[11px] text-text-muted">{chart.table}</p>
      {points.length === 0 ? (
        <p className="mt-6 text-[12px] text-text-muted">No data points yet.</p>
      ) : (
        <div className="mt-4 flex h-32 items-end gap-1">
          {points.map((p, i) => (
            <div key={`${p.label}-${i}`} className="flex flex-1 flex-col items-center gap-1" title={`${p.label}: ${p.value}`}>
              <div
                className="w-full rounded-t bg-accent/70"
                style={{ height: `${Math.max(2, (p.value / max) * 100)}%` }}
              />
              <span className="w-full truncate text-center text-[9px] text-text-muted">{p.label.slice(5)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TableCard({ table }: { table: DashboardTable }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium text-text">{table.name}</p>
        <span className="text-[11px] text-text-muted">{table.rowCount} rows</span>
      </div>
      {table.recent.length === 0 ? (
        <p className="mt-3 text-[12px] text-text-muted">No records yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-line text-text-muted">
                {table.columns.slice(0, 6).map((col) => (
                  <th key={col} className="px-2 py-1 font-normal">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.recent.slice(0, 8).map((rec, i) => (
                <tr key={String(rec.id ?? i)} className="border-b border-line/50">
                  {table.columns.slice(0, 6).map((col) => (
                    <td key={col} className="max-w-[180px] truncate px-2 py-1 text-text">
                      {renderCell(rec[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
