/**
 * AppDetailPage — three-layer app shell.
 *
 * Spec: docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §5, §11.
 *       docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §5.1, §14.
 *
 *   [Output]  → operator surface (performance, results, config, activity)
 *   [Canvas]  → system-composition graph (AppCanvasView)
 *   [Brain]   → intelligence surface (BrainView with Map / Flow / Ledger modes)
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Check, X, Eye, RotateCcw, AlertTriangle, BarChart3,
  Tag, Play, FileText, AppWindow,
  Target as OutputIcon, Workflow as CanvasIcon, Brain as MemoryIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../components/shared/Toast';
import { Tabs } from '../components/shared/Tabs';
import { Button } from '../components/shared/Button';
import { FilterBar } from '../components/shared/FilterBar';
import { Skeleton } from '../components/shared/Skeleton';
import { StatusBadge } from '../components/shared/StatusBadge';
import { EmptyState } from '../components/shared/EmptyState';
import { SegmentedControl } from '../components/shared/SegmentedControl';
import { AppCanvasView } from '../components/app-graph/AppCanvasView';
import { BrainView } from '../components/brain/BrainView';
import { BrainManageView } from '../components/brain/BrainManageView';
import { BrainTabHeader, type BrainMode } from '../components/brain/BrainTabHeader';
import { AppKnowledgeActivationCard } from '../components/apps/AppKnowledgeActivationCard';

interface AppDetail {
  id: string;
  slug: string;
  name: string;
  version?: string;
  status?: string;
  description?: string;
  iconGlyph?: string;
  iconColor?: string;
  entryWorkflowId?: string;
  outputLabels?: OutputLabel[];
  workflows?: Array<{ id: string; name: string }>;
  agents?: Array<{ id: string; name: string }>;
}

interface OutputLabel {
  label: string;
  path: string;
  format?: 'number' | 'currency' | 'percent' | 'text';
  artifactType?: 'document' | 'metric' | 'chart' | 'list' | 'file' | 'decision' | 'custom';
}

interface OutputMetric {
  label: string;
  value: number | string;
  format?: string;
  trend?: 'up' | 'down' | 'flat';
  trendDelta?: number;
}

interface PerformanceData {
  successRate: number;
  runCount: number;
  totalCost: number;
  avgDurationMs: number;
  metrics: OutputMetric[];
  pendingApprovals: Array<{
    id: string; title: string; runId?: string; workflowName?: string; createdAt: string;
  }>;
  recentRuns: Array<{
    id: string;
    status: 'completed' | 'failed' | 'running';
    startedAt: string;
    durationMs?: number;
    cost?: number;
    failedNode?: string;
    metricValues?: Record<string, string | number>;
  }>;
}

type Window = '1d' | '7d' | '30d';

const WINDOW_FILTERS = [
  { value: '1d',  label: 'Today' },
  { value: '7d',  label: '7 days' },
  { value: '30d', label: '30 days' },
] as const satisfies ReadonlyArray<{ value: Window; label: string }>;

function relativeTime(iso: string): string {
  try {
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600_000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  } catch { return ''; }
}

function formatDuration(ms?: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

type Layer = 'output' | 'canvas' | 'brain';

const LAYERS = [
  { value: 'output' as Layer, label: 'Output', icon: <OutputIcon size={14} /> },
  { value: 'canvas' as Layer, label: 'Canvas', icon: <CanvasIcon size={14} /> },
  { value: 'brain'  as Layer, label: 'Brain',  icon: <MemoryIcon size={14} /> },
] as const;

export function AppDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const toast = useToast();

  const [app, setApp] = useState<AppDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [layer, setLayer] = useState<Layer>(() => {
    const params = new URLSearchParams(window.location.search);
    const l = params.get('layer') as Layer | null;
    if (l === 'output' || l === 'canvas' || l === 'brain') return l;
    if (params.get('brain') === 'manage' || params.get('brain') === 'map') return 'brain';
    if (l === ('memory' as Layer)) return 'brain';
    if (params.get('new') === '1') return 'canvas';
    if (params.get('tab')) return 'output';
    return 'output';
  });
  const [brainMode, setBrainMode] = useState<BrainMode>(() => {
    const b = new URLSearchParams(window.location.search).get('brain');
    return b === 'manage' ? 'manage' : 'map';
  });
  const [outputTab, setOutputTab] = useState<string>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t || 'results';
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('layer', layer);
    if (layer === 'brain') url.searchParams.set('brain', brainMode);
    else url.searchParams.delete('brain');
    window.history.replaceState(null, '', url.toString());
  }, [layer, brainMode]);

  useEffect(() => {
    if (!slug) return;
    void api<{ app: AppDetail }>(`/v1/apps/${slug}`)
      .then((d) => setApp(d.app))
      .catch(() => setApp(null))
      .finally(() => setLoading(false));
  }, [slug]);

  function openBrainManage() {
    setLayer('brain');
    setBrainMode('manage');
  }

  if (loading && !app) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width={250} height={28} />
        <Skeleton height={120} />
        <Skeleton height={400} />
      </div>
    );
  }
  if (!app) {
    return (
      <div className="p-8">
        <EmptyState
          icon={<AppWindow size={48} />}
          title="App not found"
          body="This app may have been removed or you don't have access."
          primaryAction={<Button variant="primary" size="md" onClick={() => nav('/apps')}>Back to apps</Button>}
          variant="page"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-6 py-4">
        <button onClick={() => nav('/apps')} className="mb-3 inline-flex items-center gap-1 text-[12px] text-text-muted hover:text-text-primary">
          <ArrowLeft size={12} /> Apps
        </button>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <span
              className="flex h-12 w-12 items-center justify-center rounded-card text-[20px] font-bold"
              style={{ backgroundColor: app.iconColor ?? '#15171c' }}
            >
              {app.iconGlyph ?? '◈'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="text-display text-text-primary">{app.name}</h1>
                <StatusBadge status={app.status ?? 'idle'} size="sm" />
              </div>
              <div className="mt-1 flex flex-wrap gap-3 text-[12px] text-text-muted">
                {app.version && <span>v{app.version}</span>}
                {app.workflows && <span>{app.workflows.length} workflow{app.workflows.length === 1 ? '' : 's'}</span>}
                {app.agents && <span>{app.agents.length} agent{app.agents.length === 1 ? '' : 's'}</span>}
              </div>
              {app.description && (
                <p className="mt-2 text-[13px] text-text-secondary">{app.description}</p>
              )}
            </div>
          </div>
          <SegmentedControl segments={LAYERS} value={layer} onChange={setLayer} />
        </div>
      </div>

      {layer === 'output' && (
        <>
          <Tabs
            param="tab"
            defaultValue="results"
            value={outputTab}
            onChange={setOutputTab}
            tabs={[
              { value: 'results',     label: 'Results' },
              { value: 'performance', label: 'Performance' },
              { value: 'config',      label: 'Configuration' },
              { value: 'activity',    label: 'Recent runs' },
            ]}
            className="px-6"
          />
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {outputTab === 'results' && <AppKnowledgeActivationCard appSlug={app.slug} entryWorkflowId={app.entryWorkflowId} onManage={openBrainManage} />}
            {outputTab === 'performance' && <PerformanceTab app={app} />}
            {outputTab === 'results' && <ResultsTab app={app} />}
            {outputTab === 'config' && <ConfigTab app={app} />}
            {outputTab === 'activity' && <ActivityTab app={app} />}
          </div>
        </>
      )}

      {layer === 'canvas' && (
        <div className="flex-1 overflow-hidden">
          <AppCanvasView slug={app.slug} />
        </div>
      )}

      {layer === 'brain' && (
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
          <BrainTabHeader mode={brainMode} onChange={setBrainMode} />
          <div className="min-h-0 flex-1 overflow-hidden">
            {brainMode === 'map' ? <BrainView slug={app.slug} onManage={openBrainManage} /> : <BrainManageView slug={app.slug} />}
          </div>
        </div>
      )}
    </div>
  );
}

function PerformanceTab({ app }: { app: AppDetail }) {
  const nav = useNavigate();
  const toast = useToast();
  const [window, setWindow] = useState<Window>('7d');
  const [data, setData] = useState<PerformanceData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<PerformanceData>(`/v1/apps/${app.slug}/results?window=${window}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [app.slug, window]);

  async function handleApprove(id: string) {
    try { await api(`/v1/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }); toast.success('Approved'); }
    catch (e) { toast.error('Failed', String(e)); }
  }
  async function handleReject(id: string) {
    try { await api(`/v1/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'rejected' }) }); toast.success('Rejected'); }
    catch (e) { toast.error('Failed', String(e)); }
  }
  async function handleRetry(id: string) {
    try { await api(`/v1/runs/${id}/retry`, { method: 'POST' }); toast.success('Retry started'); }
    catch (e) { toast.error('Retry failed', String(e)); }
  }

  if (loading) return <Skeleton height={400} />;

  const hasRuns = data && data.runCount > 0;

  if (!hasRuns) {
    return (
      <div>
        <FilterBar options={WINDOW_FILTERS} value={window} onChange={setWindow} className="mb-5" />
        <EmptyState
          icon={<BarChart3 size={48} />}
          title="No runs in this period"
          body="This app hasn't been triggered yet."
          primaryAction={
            app.entryWorkflowId
              ? <Button variant="primary" size="md" iconLeft={<Play size={14} />}>Run now</Button>
              : undefined
          }
          variant="page"
        />
      </div>
    );
  }

  const stats = [
    ...(data!.metrics ?? []),
    {
      label: 'Success rate',
      value: `${Math.round(data!.successRate * 100)}%`,
      format: 'percent',
    },
    {
      label: 'Cost',
      value: `$${data!.totalCost.toFixed(2)}`,
      format: 'currency',
    },
  ];

  return (
    <div className="space-y-6">
      <FilterBar options={WINDOW_FILTERS} value={window} onChange={setWindow} />

      {/* Stat bar */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((m, i) => (
          <div key={i} className="rounded-card border border-line bg-surface p-4">
            <div className="text-display text-text-primary">{m.value}</div>
            <div className="mt-0.5 text-[11px] uppercase tracking-wider text-text-muted">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Pending approvals */}
      {data!.pendingApprovals.length > 0 && (
        <div>
          <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Needs attention</h3>
          <div className="space-y-2">
            {data!.pendingApprovals.map((a) => (
              <div key={a.id} className="flex items-start gap-3 rounded-card border border-warn/20 bg-warn-soft p-4">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn" />
                <div className="min-w-0 flex-1">
                  <div className="text-subheading text-text-primary">Approval needed: "{a.title}"</div>
                  <div className="mt-0.5 text-[12px] text-text-muted">
                    {a.workflowName ?? 'Workflow'} · run_{a.runId?.slice(-6)} · {relativeTime(a.createdAt)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button variant="primary" size="sm" iconLeft={<Check size={11} />} onClick={() => void handleApprove(a.id)}>Approve</Button>
                  <Button variant="secondary" size="sm" iconLeft={<X size={11} />} onClick={() => void handleReject(a.id)}>Reject</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent runs */}
      <div>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Recent runs</h3>
        <div className="space-y-1.5">
          {data!.recentRuns.map((r) => (
            <div key={r.id} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 transition-colors hover:bg-surface-2">
              <StatusBadge status={r.status} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13px] text-text-primary">
                  <span className="font-mono">run_{r.id.slice(-6)}</span>
                  <span className="text-text-muted">·</span>
                  <span className="text-text-muted">{relativeTime(r.startedAt)}</span>
                  {r.durationMs && <span className="text-text-muted">· {formatDuration(r.durationMs)}</span>}
                  {r.cost != null && <span className="text-text-muted">· ${r.cost.toFixed(2)}</span>}
                </div>
                {r.metricValues && Object.entries(r.metricValues).length > 0 && (
                  <div className="mt-0.5 text-[12px] text-text-secondary">
                    {Object.entries(r.metricValues).map(([k, v], i, arr) => (
                      <span key={k}>{k}: {v}{i < arr.length - 1 ? ' · ' : ''}</span>
                    ))}
                  </div>
                )}
                {r.status === 'failed' && r.failedNode && (
                  <div className="mt-0.5 text-[12px] text-danger">FAILED at {r.failedNode}</div>
                )}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button variant="secondary" size="sm" iconLeft={<Eye size={11} />} onClick={() => nav(`/runs/${r.id}`)}>View run</Button>
                {r.status === 'failed' && (
                  <Button variant="secondary" size="sm" iconLeft={<RotateCcw size={11} />} onClick={() => void handleRetry(r.id)}>Retry</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultsTab({ app }: { app: AppDetail }) {
  const [results, setResults] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void api<{ results: Array<Record<string, unknown>> }>(`/v1/apps/${app.slug}/output-results?window=7d&limit=100`)
      .then((d) => { if (!cancelled) setResults(d.results ?? []); })
      .catch(() => { if (!cancelled) setResults([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [app.slug]);

  if (loading) return <Skeleton height={400} />;

  const labels = app.outputLabels ?? [];
  const hasNonMetricArtifacts = labels.some((label) => (label.artifactType ?? (label.format ? 'metric' : 'document')) !== 'metric');

  if (labels.length === 0) {
    return (
      <EmptyState
        icon={<Tag size={48} />}
        title="No outputs configured yet"
        body="This app's results will show up here once you tell it what to track. Open the entry workflow and label what it produces — a number, a list, a document, or anything else."
        variant="page"
      />
    );
  }

  if (results.length === 0) {
    return (
      <EmptyState
        icon={<FileText size={48} />}
        title="No results yet"
        body="Once this app has runs, their outputs will appear here in a friendly UI."
        variant="page"
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-[12px] text-text-muted">{results.length} result{results.length === 1 ? '' : 's'} · last 7 days</div>

      {hasNonMetricArtifacts ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {results.map((r, i) => (
            <div key={i} className="rounded-card border border-line bg-surface p-4">
              <div className="mb-3 text-[11px] text-text-muted">
                {(() => {
                  const ts = r['_runStartedAt'] as string | undefined;
                  return ts ? relativeTime(ts) : 'Result';
                })()}
              </div>
              <div className="space-y-3">
                {labels.map((label) => {
                  const value = (r[label.path] ?? r['_extracted']?.[label.path as keyof object]) as unknown;
                  return <ArtifactValue key={label.path} label={label} value={value} />;
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                {labels.map((l) => <th key={l.path} className="px-4 py-2.5 text-left">{l.label}</th>)}
                <th className="px-4 py-2.5 text-left">When</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className="border-b border-line/60 last:border-b-0">
                  {labels.map((l) => {
                    const value = (r[l.path] ?? r['_extracted']?.[l.path as keyof object]) as unknown;
                    return (
                      <td key={l.path} className="px-4 py-3 text-[13px] text-text-primary">
                        {formatValue(value, l.format)}
                      </td>
                    );
                  })}
                  <td className="px-4 py-3 text-[12px] text-text-muted">
                    {(() => {
                      const ts = r['_runStartedAt'] as string | undefined;
                      return ts ? relativeTime(ts) : '—';
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ArtifactValue({ label, value }: { label: OutputLabel; value: unknown }) {
  const artifactType = label.artifactType ?? (label.format ? 'metric' : 'document');
  return (
    <div className="rounded-card border border-line/70 bg-surface-2 px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-text-secondary">{label.label}</span>
        <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] capitalize text-text-muted">{artifactType}</span>
      </div>
      {artifactType === 'metric' ? (
        <div className="text-display text-text-primary">{formatValue(value, label.format)}</div>
      ) : artifactType === 'list' && Array.isArray(value) ? (
        <div className="space-y-1 text-[12px] text-text-primary">
          {value.slice(0, 5).map((item, index) => <div key={index}>{formatValue(item)}</div>)}
          {value.length > 5 && <div className="text-text-muted">+{value.length - 5} more</div>}
        </div>
      ) : artifactType === 'decision' ? (
        <div className="inline-flex rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent">{formatValue(value)}</div>
      ) : (
        <div className="max-h-40 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-text-primary">
          {formatValue(value)}
        </div>
      )}
    </div>
  );
}

function formatValue(v: unknown, fmt?: string): string {
  if (v == null) return '—';
  if (fmt === 'currency' && typeof v === 'number') return `$${v.toFixed(2)}`;
  if (fmt === 'percent' && typeof v === 'number') return `${(v * 100).toFixed(1)}%`;
  if (fmt === 'number' && typeof v === 'number') return v.toLocaleString();
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60) + (JSON.stringify(v).length > 60 ? '…' : '');
  return String(v);
}

function ConfigTab({ app }: { app: AppDetail }) {
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Workflows</h3>
        {(app.workflows ?? []).length === 0 ? (
          <p className="text-[13px] text-text-muted">No workflows linked to this app.</p>
        ) : (
          <div className="space-y-1.5">
            {app.workflows!.map((w) => (
              <div key={w.id} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
                <span className="text-[13px] text-text-primary">{w.name}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Agents</h3>
        {(app.agents ?? []).length === 0 ? (
          <p className="text-[13px] text-text-muted">No agents linked to this app.</p>
        ) : (
          <div className="space-y-1.5">
            {app.agents!.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
                <span className="text-[13px] text-text-primary">{a.name}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Output labels</h3>
        {(app.outputLabels ?? []).length === 0 ? (
          <p className="text-[13px] text-text-muted">No outputs labeled yet. Open the entry workflow and label what it produces — then those values show up in the Results tab.</p>
        ) : (
          <div className="space-y-1.5">
            {app.outputLabels!.map((l) => (
              <div key={l.path} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
                <span className="text-[13px] font-medium text-text-primary">{l.label}</span>
                <span className="font-mono text-[11px] text-text-muted">{l.path}</span>
                {l.artifactType && <span className="ml-auto text-[11px] capitalize text-text-muted">{l.artifactType}</span>}
                {l.format && <span className={`${l.artifactType ? '' : 'ml-auto'} text-[11px] text-text-muted`}>{l.format}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ActivityTab({ app }: { app: AppDetail }) {
  const [events, setEvents] = useState<Array<{ id: string; type: string; title: string; createdAt: string; runId?: string; }>>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void api<{ events: typeof events }>(`/v1/apps/${app.slug}/activity?limit=50`)
      .then((d) => { if (!cancelled) setEvents(d.events ?? []); })
      .catch(() => { if (!cancelled) setEvents([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [app.slug]);

  if (loading) return <Skeleton height={300} />;

  if (events.length === 0) {
    return <EmptyState icon={<FileText size={48} />} title="No activity yet" body="Events for this app will appear here." />;
  }

  return (
    <div className="space-y-1">
      {events.map((e) => (
        <button
          key={e.id}
          type="button"
          onClick={() => e.runId && nav(`/runs/${e.runId}`)}
          className="flex w-full items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2"
        >
          <span className="font-mono text-[10px] text-text-muted">{e.type}</span>
          <span className="flex-1 truncate text-[13px] text-text-primary">{e.title}</span>
          <span className="text-[11px] text-text-muted">{relativeTime(e.createdAt)}</span>
        </button>
      ))}
    </div>
  );
}
