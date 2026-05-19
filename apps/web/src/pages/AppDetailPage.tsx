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

import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import {
  AlertTriangle,
  AppWindow,
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  Bot,
  Brain as MemoryIcon,
  Cable,
  Check,
  Coins,
  Database,
  Eye,
  FileText,
  LayoutDashboard,
  Image as ImageIcon,
  PauseCircle,
  Play,
  Rocket,
  RotateCcw,
  Settings,
  Signal,
  Tag,
  Target as OutputIcon,
  Trash2,
  Upload,
  Workflow as CanvasIcon,
  X,
  Plus,
} from 'lucide-react';
import { IconButton } from '../components/shared/Button';
import { api } from '../lib/api';
import { useToast } from '../components/shared/Toast';
import { Button } from '../components/shared/Button';
import { FilterBar } from '../components/shared/FilterBar';
import { Skeleton } from '../components/shared/Skeleton';
import { StatusBadge } from '../components/shared/StatusBadge';
import { EmptyState } from '../components/shared/EmptyState';
import { SegmentedControl } from '../components/shared/SegmentedControl';
import { useConfirm } from '../components/shared/ConfirmDialog';
import { AppCanvasView } from '../components/app-graph/AppCanvasView';
import { BrainView } from '../components/brain/BrainView';
import { BrainManageView } from '../components/brain/BrainManageView';
import { BrainTabHeader, type BrainMode } from '../components/brain/BrainTabHeader';
import { BrainHealthDashboard } from '../components/brain/BrainHealthDashboard';
import { DisputeResolutionPanel } from '../components/brain/DisputeResolutionPanel';
import { AppDispatchSurface } from '../components/apps/AppDispatchSurface';
import type { SurfaceIntentHealth } from '../components/apps/appSurfaceShared';
import { DataView } from '../components/app-detail/DataView';
import { DeployView } from '../components/app-detail/DeployView';
import { DashboardView } from '../components/app-detail/DashboardView';
import { ResultDetailPage } from './ResultDetailPage';

interface SurfaceStatusItem {
  type: string;
  label: string;
  configured: boolean;
  live: boolean;
  activityToday: number;
  activityUnit: string;
  lastActivityAt: string | null;
}

interface OutputLabel {
  label: string;
  path: string;
  format?: 'number' | 'currency' | 'percent' | 'text';
  artifactType?: 'document' | 'metric' | 'chart' | 'list' | 'file' | 'decision' | 'custom' | 'table' | 'link';
}

interface AppIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  linkedWorkflowId?: string | null;
  activeRunId?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AppWorkflowSummary {
  id: string;
  name: string;
  status?: string;
  route?: string | null;
  triggerCount?: number;
  activeTriggerCount?: number;
  lastRunAt?: string | null;
}

interface AppAgentSummary {
  id: string;
  name: string;
  status?: string;
  role?: string | null;
  route?: string | null;
  lastHeartbeatAt?: string | null;
  currentTaskId?: string | null;
}

interface AppTriggerSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  triggerType: string;
  status: string;
  lastFiredAt?: string | null;
  summary?: string;
  webhookUrl?: string | null;
}

interface AppCredentialSlot {
  key: string;
  service: string;
  label: string;
  required: boolean;
  oauthFlow?: boolean;
  profile?: string | null;
  bound: boolean;
  bindingLabel?: string | null;
}

interface DatasetStatusSummary {
  key: string;
  label: string;
  status: string;
  optional?: boolean;
  targetStore?: string;
  currentJobId?: string;
}

interface AppKnowledgeSummary {
  knowledgeBases: number;
  importedDatasets: number;
  knowledgeItems: number;
  memoryItems: number;
}

interface AppSpendSummary {
  totalCost30d: number;
  avgCostPerRun30d: number;
  runCount30d: number;
  monthlyBudgetCents?: number | null;
  remainingBudgetCents?: number | null;
  usageRatio?: number | null;
  status?: string;
}

interface AppDetail {
  id: string;
  slug: string;
  name: string;
  version?: string;
  status?: string;
  description?: string;
  intendedBehavior?: string | null;
  category?: string | null;
  spaceId?: string | null;
  iconGlyph?: string;
  iconColor?: string;
  iconUrl?: string | null;
  coverImage?: string | null;
  entryWorkflowId?: string | null;
  deployTarget?: string;
  deployStatus?: string;
  installedAt?: string | null;
  outputLabels?: OutputLabel[];
  domains?: AppDomainSummary[];
  dataTables?: AppDataTableSummary[];
  workflows?: AppWorkflowSummary[];
  agents?: AppAgentSummary[];
  triggers?: AppTriggerSummary[];
  credentialSlots?: AppCredentialSlot[];
  datasetStatuses?: DatasetStatusSummary[];
  knowledgeSummary?: AppKnowledgeSummary;
  spendSummary?: AppSpendSummary;
  intentHealth?: SurfaceIntentHealth | null;
}

interface AppDomainSummary {
  id: string;
  name: string;
  description?: string;
  workflowIds: string[];
}

interface AppDataTableSummary {
  name: string;
  description: string | null;
  fields: Array<{ name: string; type: string }>;
}

interface OutputMetric {
  label: string;
  value: number | string;
  format?: string;
  trend?: 'up' | 'down' | 'flat';
  trendDelta?: number;
}

interface PerformanceData {
  window: Window;
  successRate: number;
  runCount: number;
  totalCost: number;
  avgCostPerRun: number;
  avgDurationMs: number;
  metrics: OutputMetric[];
  pendingApprovals: Array<{
    id: string;
    title: string;
    summary?: string;
    runId?: string;
    workflowName?: string;
    createdAt: string;
  }>;
  recentRuns: Array<{
    id: string;
    workflowId?: string;
    workflowName?: string;
    status: string;
    startedAt: string;
    durationMs?: number;
    cost?: number;
    failedNode?: string;
    metricValues?: Record<string, string | number>;
  }>;
  costByAgent: Array<{
    agentId: string;
    agentName: string;
    cost: number;
    share: number;
  }>;
  trend: {
    previousTotalCost: number;
    previousSpendCents: number;
    deltaPct: number;
    direction: 'up' | 'down' | 'flat';
  };
  budget: {
    monthlyBudgetCents?: number | null;
    currentSpendCents: number;
    remainingCents?: number | null;
    usageRatio?: number | null;
    status: string;
  };
}

type Window = '1d' | '7d' | '30d';
type Layer = 'output' | 'canvas' | 'data' | 'brain' | 'deploy';
type OutputTab = 'results' | 'performance' | 'activity' | 'config' | 'dashboard';

const WINDOW_FILTERS = [
  { value: '1d', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
] as const satisfies ReadonlyArray<{ value: Window; label: string }>;

const OUTPUT_FORMAT_OPTIONS = ['', 'number', 'currency', 'percent', 'text'] as const;
const OUTPUT_ARTIFACT_OPTIONS = ['', 'metric', 'document', 'chart', 'list', 'table', 'link', 'file', 'decision', 'custom'] as const;

// Five-layer app model (AGENTIS-PLATFORM-10X §Part III): Surface / Canvas /
// Data / Brain / Deploy. The `output` value is retained for URL stability.
const LAYERS = [
  { value: 'output' as Layer, label: 'Surface', icon: <OutputIcon size={14} /> },
  { value: 'canvas' as Layer, label: 'Canvas', icon: <CanvasIcon size={14} /> },
  { value: 'data' as Layer, label: 'Data', icon: <Database size={14} /> },
  { value: 'brain' as Layer, label: 'Brain', icon: <MemoryIcon size={14} /> },
  { value: 'deploy' as Layer, label: 'Deploy', icon: <Rocket size={14} /> },
] as const;

export function AppDetailPage() {
  const { slug, resultId } = useParams<{ slug: string; resultId?: string }>();
  const nav = useNavigate();
  const location = useLocation();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [layer, setLayer] = useState<Layer>(() => {
    const params = new URLSearchParams(location.search);
    const current = params.get('layer') as Layer | null;
    if (
      current === 'output' ||
      current === 'canvas' ||
      current === 'data' ||
      current === 'brain' ||
      current === 'deploy'
    )
      return current;
    if (['knowledge', 'manage', 'map', 'health', 'disputes'].includes(params.get('brain') ?? '')) return 'brain';
    if (params.get('new') === '1') return 'canvas';
    if (params.get('tab')) return 'output';
    return 'output';
  });
  const [brainMode, setBrainMode] = useState<BrainMode>(() => {
    const mode = new URLSearchParams(location.search).get('brain');
    return mode === 'map' || mode === 'health' || mode === 'disputes' ? mode : 'knowledge';
  });
  const [outputTab, setOutputTab] = useState<OutputTab>(() => {
    const tab = new URLSearchParams(location.search).get('tab');
    return tab === 'performance' || tab === 'activity' || tab === 'config' ? tab : 'results';
  });
  const [dataLayerTable, setDataLayerTable] = useState<string | undefined>(undefined);

  const openDataLayer = useCallback((table?: string) => {
    setDataLayerTable(table);
    setLayer('data');
  }, []);



  const reloadApp = useCallback(async (options?: { silent?: boolean }) => {
    if (!slug) {
      setApp(null);
      setLoading(false);
      return null;
    }
    const silent = options?.silent ?? false;
    if (!silent) setLoading(true);
    try {
      const data = await api<{ app: AppDetail }>(`/v1/apps/${slug}`);
      setApp(data.app);
      return data.app;
    } catch {
      if (!silent) setApp(null);
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('layer', layer);
    if (layer === 'brain') url.searchParams.set('brain', brainMode);
    else url.searchParams.delete('brain');
    window.history.replaceState(window.history.state, '', url.toString());
  }, [layer, brainMode]);

  useEffect(() => {
    void reloadApp();
  }, [reloadApp]);

  function openBrainManage() {
    setLayer('brain');
    setBrainMode('knowledge');
  }

  if (loading && !app) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton width={250} height={28} />
        <Skeleton height={140} />
        <Skeleton height={420} />
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

  const displayStatus = appDisplayStatus(app);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-4 py-4 sm:px-6">
        <button onClick={() => nav('/apps')} className="mb-3 inline-flex items-center gap-1 text-[12px] text-text-muted hover:text-text-primary">
          <ArrowLeft size={12} /> Apps
        </button>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <AppAvatar app={app} className="h-14 w-14 shrink-0 text-[24px]" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-display text-text-primary">{app.name}</h1>
                <StatusBadge status={displayStatus.status} label={displayStatus.label} size="sm" />
                {app.spendSummary?.status && app.spendSummary.monthlyBudgetCents != null && (
                  <BudgetStatusPill status={app.spendSummary.status} />
                )}
                {layer === 'output' && (
                  <>
                    <IconButton
                      icon={<LayoutDashboard size={15} />}
                      label={outputTab === 'dashboard' ? 'Back to surface' : 'Open dashboard'}
                      size="sm"
                      variant="ghost"
                      onClick={() => setOutputTab(outputTab === 'dashboard' ? 'results' : 'dashboard')}
                    />
                    <IconButton
                      icon={<Settings size={15} />}
                      label={outputTab === 'results' ? 'Configure app' : 'Back to surface'}
                      size="sm"
                      variant="ghost"
                      onClick={() => setOutputTab(outputTab === 'results' ? 'config' : 'results')}
                    />
                  </>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-3 text-[12px] text-text-muted">
                {app.version && <span>v{app.version}</span>}
                {app.workflows && <span>{app.workflows.length} workflow{app.workflows.length === 1 ? '' : 's'}</span>}
                {app.agents && <span>{app.agents.length} agent{app.agents.length === 1 ? '' : 's'}</span>}
                {app.spendSummary && <span>{formatMoney(app.spendSummary.totalCost30d)} this month</span>}
              </div>
              {app.description && <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-text-secondary">{app.description}</p>}
            </div>
          </div>
          <div className="max-w-full overflow-x-auto pb-1">
            <SegmentedControl segments={LAYERS} value={layer} onChange={setLayer} />
          </div>
        </div>
      </div>

      {layer === 'output' && (
        <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {outputTab === 'dashboard' ? (
            <DashboardView appId={app.id} />
          ) : outputTab === 'results' ? (
            <ResultsTab
              app={app}
              onManage={() => setOutputTab('config')}
              onOpenCanvas={() => setLayer('canvas')}
              onOpenData={openDataLayer}
            />
          ) : (
            <ConfigTab
              app={app}
              initialSection={outputTab === 'performance' || outputTab === 'activity' ? outputTab : 'identity'}
              onUpdated={setApp}
              onRefresh={() => reloadApp({ silent: true })}
              onDeleted={() => nav('/apps')}
            />
          )}
        </div>
      )}

      {layer === 'canvas' && (
        <div className="flex-1 overflow-hidden">
          <AppCanvasView slug={app.slug} />
        </div>
      )}

      {layer === 'data' && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DataView appId={app.id} initialTable={dataLayerTable} />
        </div>
      )}

      {layer === 'deploy' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DeployView appId={app.id} />
        </div>
      )}

      {layer === 'brain' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <BrainTabHeader mode={brainMode} onChange={setBrainMode} />
          <div className="min-h-0 flex-1 overflow-hidden">
            {brainMode === 'map' ? (
              <BrainView slug={app.slug} onManage={openBrainManage} />
            ) : brainMode === 'health' ? (
              <BrainHealthDashboard slug={app.slug} />
            ) : brainMode === 'disputes' ? (
              <DisputeResolutionPanel slug={app.slug} />
            ) : (
              <BrainManageView appId={app.id} appName={app.name} />
            )}
          </div>
        </div>
      )}

      {/* Result detail slide-in — APP-OUTPUT-REPLAN.md §5.7 */}
      {resultId && <ResultDetailPage />}
    </div>
  );
}

function PerformanceTab({ app }: { app: AppDetail }) {
  const nav = useNavigate();
  const toast = useToast();
  const [window, setWindow] = useState<Window>('7d');
  const [data, setData] = useState<PerformanceData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<PerformanceData>(`/v1/apps/${app.slug}/results?window=${window}`);
      setData(next);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [app.slug, window]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function handleApprove(id: string) {
    try {
      await api(`/v1/approvals/${id}/resolve`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
      toast.success('Approval recorded');
      await loadData();
    } catch (error) {
      toast.error('Failed', String(error));
    }
  }

  async function handleReject(id: string) {
    try {
      await api(`/v1/approvals/${id}/resolve`, { method: 'POST', body: JSON.stringify({ decision: 'reject' }) });
      toast.success('Rejection recorded');
      await loadData();
    } catch (error) {
      toast.error('Failed', String(error));
    }
  }

  async function handleRetry(id: string) {
    try {
      await api(`/v1/runs/${id}/retry`, { method: 'POST' });
      toast.success('Retry started');
      await loadData();
    } catch (error) {
      toast.error('Retry failed', String(error));
    }
  }

  async function handleRunNow() {
    if (!app.entryWorkflowId) return;
    try {
      const result = await api<{ runId: string }>(`/v1/workflows/${app.entryWorkflowId}/run`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      toast.success('Run started');
      await loadData();
      nav(`/runs/${result.runId}`);
    } catch (error) {
      toast.error('Could not start run', String(error));
    }
  }

  if (loading) return <Skeleton height={460} />;

  if (!data || data.runCount === 0) {
    return (
      <div>
        <FilterBar options={WINDOW_FILTERS} value={window} onChange={setWindow} className="mb-5" />
        <EmptyState
          icon={<BarChart3 size={48} />}
          title="No runs in this period"
          body="This app hasn't been triggered yet."
          primaryAction={
            app.entryWorkflowId
              ? <Button variant="primary" size="md" iconLeft={<Play size={14} />} onClick={() => void handleRunNow()}>Run now</Button>
              : undefined
          }
          variant="page"
        />
      </div>
    );
  }

  const trendLabel = data.trend.direction === 'flat'
    ? 'No change'
    : `${data.trend.deltaPct >= 0 ? '+' : ''}${data.trend.deltaPct.toFixed(0)}%`;
  const previousLabel = `vs previous ${windowLabel(window).toLowerCase()}`;
  const stats = [
    { label: 'Total cost', value: formatMoney(data.totalCost), detail: `${data.runCount} runs in ${windowLabel(window).toLowerCase()}` },
    { label: 'Avg / run', value: formatMoney(data.avgCostPerRun), detail: 'Execution cost per run' },
    { label: 'Cost trend', value: trendLabel, detail: previousLabel },
    { label: 'Success rate', value: `${Math.round(data.successRate * 100)}%`, detail: `${formatDuration(data.avgDurationMs)} avg duration` },
    { label: 'Avg duration', value: formatDuration(data.avgDurationMs), detail: 'Completed and failed runs' },
  ];

  return (
    <div className="space-y-6">
      <FilterBar options={WINDOW_FILTERS} value={window} onChange={setWindow} />

      {data.pendingApprovals.length > 0 && (
        <div className="rounded-card border border-warn/20 bg-warn-soft p-4">
          <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-warn">
            <AlertTriangle size={14} /> Needs attention
          </div>
          <div className="space-y-2">
            {data.pendingApprovals.map((approval) => (
              <div key={approval.id} className="flex flex-col gap-3 rounded-card border border-warn/20 bg-surface px-4 py-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-text-primary">{approval.title}</div>
                  <div className="mt-1 text-[12px] text-text-secondary">{approval.summary ?? approval.workflowName ?? 'Review requested by this app.'}</div>
                  <div className="mt-1 text-[11px] text-text-muted">{approval.workflowName ?? 'Workflow'} · {relativeTime(approval.createdAt)}</div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="primary" size="sm" iconLeft={<Check size={11} />} onClick={() => void handleApprove(approval.id)}>Approve</Button>
                  <Button variant="secondary" size="sm" iconLeft={<X size={11} />} onClick={() => void handleReject(approval.id)}>Reject</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-card border border-line bg-surface p-4">
            <div className="text-display text-text-primary">{stat.value}</div>
            <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{stat.label}</div>
            <div className="mt-1 text-[12px] text-text-secondary">{stat.detail}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Recent runs</div>
              <div className="mt-1 text-[13px] text-text-secondary">Per-run cost, duration, and recovery actions.</div>
            </div>
            {app.entryWorkflowId && <Button size="sm" variant="secondary" iconLeft={<Play size={13} />} onClick={() => void handleRunNow()}>Run now</Button>}
          </div>
          <div className="mt-4 space-y-2">
            {data.recentRuns.map((run) => (
              <div key={run.id} className="rounded-card border border-line/80 bg-surface-2 px-4 py-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-primary">
                      <StatusBadge status={run.status} size="sm" />
                      <span className="font-mono">run_{run.id.slice(-6)}</span>
                      {run.workflowName && <span className="truncate text-text-muted">{run.workflowName}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-[12px] text-text-muted">
                      <span>{relativeTime(run.startedAt)}</span>
                      {run.durationMs != null && <span>{formatDuration(run.durationMs)}</span>}
                      {run.cost != null && <span>{formatMoney(run.cost)}</span>}
                    </div>
                    {run.failedNode && run.status === 'failed' && (
                      <div className="mt-1 text-[12px] text-danger">Failed at {run.failedNode}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="secondary" iconLeft={<Eye size={12} />} onClick={() => nav(`/runs/${run.id}`)}>View run</Button>
                    {run.status === 'failed' && (
                      <Button size="sm" variant="secondary" iconLeft={<RotateCcw size={12} />} onClick={() => void handleRetry(run.id)}>Retry</Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Budget</div>
                <div className="mt-1 text-[13px] text-text-secondary">Current spend against the app soft cap.</div>
              </div>
              <BudgetStatusPill status={data.budget.status} />
            </div>
            <div className="mt-4 text-[24px] font-semibold text-text-primary">{formatMoney(data.totalCost)}</div>
            <div className="mt-1 text-[12px] text-text-muted">spent in {windowLabel(window).toLowerCase()}</div>
            {data.budget.monthlyBudgetCents != null ? (
              <>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className={clsx(
                      'h-full rounded-full transition-all',
                      data.budget.status === 'over' ? 'bg-danger' : data.budget.status === 'near' ? 'bg-warn' : 'bg-accent',
                    )}
                    style={{ width: `${Math.min(100, Math.max(4, (data.budget.usageRatio ?? 0) * 100))}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between text-[12px] text-text-secondary">
                  <span>Cap {formatMoney((data.budget.monthlyBudgetCents ?? 0) / 100)}</span>
                  <span>
                    {data.budget.remainingCents != null && data.budget.remainingCents >= 0
                      ? `${formatMoney(data.budget.remainingCents / 100)} left`
                      : data.budget.remainingCents != null
                        ? `${formatMoney(Math.abs(data.budget.remainingCents) / 100)} over`
                        : 'No cap set'}
                  </span>
                </div>
              </>
            ) : (
              <div className="mt-4 rounded-card border border-dashed border-line bg-surface-2 px-3 py-3 text-[12px] text-text-muted">
                No app soft cap set yet. Add one in Configuration.
              </div>
            )}
          </div>

          <div className="rounded-card border border-line bg-surface p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Cost by agent</div>
            <div className="mt-1 text-[13px] text-text-secondary">Spend contribution from the agents used by this app in the selected window.</div>
            {data.costByAgent.length === 0 ? (
              <div className="mt-4 rounded-card border border-dashed border-line bg-surface-2 px-3 py-3 text-[12px] text-text-muted">
                Agent-level spend will show up once budget events are recorded for this app.
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {data.costByAgent.map((item) => (
                  <div key={item.agentId}>
                    <div className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="truncate text-text-primary">{item.agentName}</span>
                      <span className="text-text-secondary">{formatMoney(item.cost)}</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-3">
                      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(6, item.share * 100)}%` }} />
                    </div>
                    <div className="mt-1 text-[11px] text-text-muted">{Math.round(item.share * 100)}% of app spend</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

function ResultsTab({
  app,
  onManage,
  onOpenCanvas,
  onOpenData,
}: {
  app: AppDetail;
  onManage: () => void;
  onOpenCanvas: () => void;
  onOpenData: (table?: string) => void;
}) {
  return (
    <AppDispatchSurface
      app={{
        id: app.id,
        slug: app.slug,
        name: app.name,
        version: app.version,
        status: app.status,
        description: app.description,
        intendedBehavior: app.intendedBehavior,
        intentHealth: app.intentHealth,
        entryWorkflowId: app.entryWorkflowId,
        deployTarget: app.deployTarget,
        deployStatus: app.deployStatus,
        installedAt: app.installedAt,
        domains: (app.domains ?? []).map((domain) => ({
          id: domain.id,
          name: domain.name,
          description: domain.description,
          workflowIds: domain.workflowIds,
        })),
        dataTables: (app.dataTables ?? []).map((table) => ({
          name: table.name,
          description: table.description,
          fields: table.fields,
        })),
        workflows: (app.workflows ?? []).map((wf) => ({
          id: wf.id,
          name: wf.name,
          status: wf.status,
          triggerCount: wf.triggerCount,
          activeTriggerCount: wf.activeTriggerCount,
          lastRunAt: wf.lastRunAt,
        })),
        agents: (app.agents ?? []).map((agent) => ({ id: agent.id, name: agent.name, status: agent.status })),
        triggers: (app.triggers ?? []).map((trigger) => ({
          id: trigger.id,
          workflowId: trigger.workflowId,
          workflowName: trigger.workflowName,
          triggerType: trigger.triggerType,
          status: trigger.status,
          lastFiredAt: trigger.lastFiredAt,
          summary: trigger.summary,
        })),
        datasetStatuses: (app.datasetStatuses ?? []).map((ds) => ({
          key: ds.key,
          label: ds.label,
          status: ds.status,
          optional: ds.optional,
        })),
        budget: app.spendSummary
          ? {
              monthlyBudgetCents: app.spendSummary.monthlyBudgetCents,
              remainingCents: app.spendSummary.remainingBudgetCents,
              usageRatio: app.spendSummary.usageRatio,
              status: app.spendSummary.status,
            }
          : undefined,
      }}
      onManage={onManage}
      onOpenCanvas={onOpenCanvas}
      onOpenData={onOpenData}
    />
  );
}





function ArtifactValue({ label, value, hero = false }: { label: OutputLabel; value: unknown; hero?: boolean }) {
  const artifactType = resolveArtifactType(label, value);
  return (
    <div className={clsx('rounded-card border border-line/70 bg-surface-2 px-3 py-2.5', hero && 'bg-surface')}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-text-secondary">{label.label}</span>
        <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] capitalize text-text-muted">{artifactType}</span>
      </div>
      {artifactType === 'metric' ? (
        <div className={clsx(hero ? 'text-[28px]' : 'text-display', 'font-semibold text-text-primary')}>{formatValue(value, label.format)}</div>
      ) : artifactType === 'list' && Array.isArray(value) ? (
        <div className="space-y-1 text-[12px] text-text-primary">
          {value.slice(0, 5).map((item, index) => <div key={index}>{formatValue(item)}</div>)}
          {value.length > 5 && <div className="text-text-muted">+{value.length - 5} more</div>}
        </div>
      ) : artifactType === 'decision' ? (
        <div className="inline-flex rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent">{formatValue(value)}</div>
      ) : artifactType === 'table' ? (
        <TableArtifact value={value} />
      ) : artifactType === 'link' ? (
        <LinkArtifact value={value} />
      ) : artifactType === 'file' ? (
        <FileArtifact value={value} />
      ) : (
        <div className="max-h-48 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-text-primary">
          {formatValue(value)}
        </div>
      )}
    </div>
  );
}

function resolveArtifactType(label: OutputLabel, value: unknown) {
  if (label.artifactType && label.artifactType !== 'custom') return label.artifactType;
  if (label.format) return 'metric';
  if (Array.isArray(value)) {
    return value.every((item) => item && typeof item === 'object' && !Array.isArray(item)) ? 'table' : 'list';
  }
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return 'link';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.url === 'string') {
      return typeof record.name === 'string' || typeof record.fileName === 'string' ? 'file' : 'link';
    }
  }
  return 'document';
}

function readOutputValue(result: Record<string, unknown>, path: string) {
  const extracted = (result._extracted as Record<string, unknown> | undefined) ?? {};
  return result[path] ?? extracted[path];
}

function formatResultTimestamp(value?: string) {
  return value ? `Updated ${relativeTime(value)}` : 'Latest snapshot';
}

function issueLane(status: string) {
  switch (status) {
    case 'in_progress': return 'running';
    case 'in_review': return 'review';
    case 'done':
    case 'cancelled': return 'done';
    default: return 'backlog';
  }
}

function priorityTone(priority: string) {
  switch (priority) {
    case 'urgent': return 'bg-danger-soft text-danger';
    case 'high': return 'bg-warn-soft text-warn';
    case 'low': return 'bg-surface-2 text-text-secondary';
    case 'none': return 'bg-surface-2 text-text-muted';
    default: return 'bg-accent-soft text-accent';
  }
}

function priorityLabel(priority: string) {
  switch (priority) {
    case 'urgent': return 'Urgent';
    case 'high': return 'High';
    case 'low': return 'Low';
    case 'none': return 'None';
    default: return 'Normal';
  }
}

function TableArtifact({ value }: { value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) {
    return <div className="text-[12px] text-text-muted">No rows yet.</div>;
  }
  const rows = value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  if (rows.length === 0) {
    return <div className="text-[12px] text-text-primary">{formatValue(value)}</div>;
  }
  const firstRow = rows[0] ?? {};
  const columns = Object.keys(firstRow).slice(0, 4);
  return (
    <div className="overflow-hidden rounded-card border border-line/60 bg-surface">
      <table className="w-full text-left text-[12px]">
        <thead>
          <tr className="border-b border-line/60 bg-surface-2 text-[10px] uppercase tracking-wider text-text-muted">
            {columns.map((column) => <th key={column} className="px-2 py-2">{humanizeLabel(column)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 4).map((row, index) => (
            <tr key={index} className="border-b border-line/40 last:border-b-0">
              {columns.map((column) => <td key={column} className="px-2 py-2 text-text-primary">{formatValue(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinkArtifact({ value }: { value: unknown }) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const href = record && typeof record.url === 'string' ? record.url : typeof value === 'string' ? value : null;
  const title = record && typeof record.title === 'string' ? record.title : href;
  if (!href) return <div className="text-[12px] text-text-muted">No link available.</div>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="block rounded-card border border-line bg-surface px-3 py-2 text-[12px] text-accent hover:bg-surface-2">
      <div className="truncate font-medium">{title}</div>
      <div className="mt-1 truncate text-text-muted">{href}</div>
    </a>
  );
}

function FileArtifact({ value }: { value: unknown }) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const href = record && typeof record.url === 'string' ? record.url : typeof value === 'string' ? value : null;
  const name = record && typeof record.name === 'string'
    ? record.name
    : record && typeof record.fileName === 'string'
      ? record.fileName
      : 'Download file';
  if (!href) return <div className="text-[12px] text-text-muted">No file attached.</div>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-card border border-line bg-surface px-3 py-2 text-[12px] font-medium text-text-primary hover:bg-surface-2">
      {name}
    </a>
  );
}

type ConfigSectionId = 'identity' | 'connections' | 'surfaces' | 'limits' | 'performance' | 'activity' | 'workflows' | 'agents' | 'labels' | 'budget' | 'danger';

const CONFIG_NAV: Array<{ id: ConfigSectionId; label: string; icon: React.ReactNode; tone?: 'danger' }> = [
  { id: 'identity',    label: 'Identity',    icon: <ImageIcon size={14} /> },
  { id: 'connections', label: 'Connections', icon: <Cable size={14} /> },
  { id: 'surfaces',    label: 'Surfaces',    icon: <Signal size={14} /> },
  { id: 'limits',      label: 'Limits',      icon: <Coins size={14} /> },
  { id: 'performance', label: 'Performance', icon: <BarChart3 size={14} /> },
  { id: 'activity',    label: 'Activity',    icon: <FileText size={14} /> },
];

function ConfigTab({
  app,
  initialSection,
  onUpdated,
  onRefresh,
  onDeleted,
}: {
  app: AppDetail;
  initialSection: ConfigSectionId;
  onUpdated: (app: AppDetail) => void;
  onRefresh: () => Promise<AppDetail | null>;
  onDeleted: () => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description ?? '');
  const [intendedBehavior, setIntendedBehavior] = useState(app.intendedBehavior ?? '');
  const [spaceId, setSpaceId] = useState(app.spaceId ?? '');
  const [spaces, setSpaces] = useState<Array<{ id: string; name: string }>>([]);
  const [iconGlyph, setIconGlyph] = useState(app.iconGlyph ?? app.name.charAt(0).toUpperCase());
  const [iconColor, setIconColor] = useState(app.iconColor ?? '#15171c');
  const [iconUrl, setIconUrl] = useState(app.iconUrl ?? '');
  const [budgetInput, setBudgetInput] = useState(app.spendSummary?.monthlyBudgetCents != null ? String(app.spendSummary.monthlyBudgetCents / 100) : '');
  const [labels, setLabels] = useState<OutputLabel[]>(app.outputLabels ?? []);
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [savingBudget, setSavingBudget] = useState(false);
  const [savingLabels, setSavingLabels] = useState(false);
  const [busyTriggerId, setBusyTriggerId] = useState<string | null>(null);
  const [busyDangerAction, setBusyDangerAction] = useState<'status' | 'reset' | 'delete' | null>(null);
  const [activeSection, setActiveSection] = useState<ConfigSectionId>(initialSection);
  const [surfaceStatus, setSurfaceStatus] = useState<SurfaceStatusItem[] | null>(null);

  useEffect(() => {
    setName(app.name);
    setDescription(app.description ?? '');
    setIntendedBehavior(app.intendedBehavior ?? '');
    setSpaceId(app.spaceId ?? '');
    setIconGlyph(app.iconGlyph ?? app.name.charAt(0).toUpperCase());
    setIconColor(app.iconColor ?? '#15171c');
    setIconUrl(app.iconUrl ?? '');
    setBudgetInput(app.spendSummary?.monthlyBudgetCents != null ? String(app.spendSummary.monthlyBudgetCents / 100) : '');
    setLabels(app.outputLabels ?? []);
  }, [app]);

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  // Lazy-fetch surface status when the Surfaces section is first opened.
  useEffect(() => {
    if (activeSection !== 'surfaces' || surfaceStatus !== null) return;
    let cancelled = false;
    void api<{ surfaceStatus: SurfaceStatusItem[] }>(`/v1/apps/${app.id}/deploy`)
      .then((data) => { if (!cancelled) setSurfaceStatus(data.surfaceStatus ?? []); })
      .catch(() => { if (!cancelled) setSurfaceStatus([]); });
    return () => { cancelled = true; };
  }, [activeSection, surfaceStatus, app.id]);

  useEffect(() => {
    let cancelled = false;
    void api<{ spaces: Array<{ id: string; name: string }> }>('/v1/spaces')
      .then((data) => { if (!cancelled) setSpaces(data.spaces ?? []); })
      .catch(() => { if (!cancelled) setSpaces([]); });
    return () => { cancelled = true; };
  }, []);

  async function saveIdentity() {
    setSavingIdentity(true);
    try {
      const result = await api<{ app: AppDetail }>(`/v1/apps/${app.slug}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          description,
          intendedBehavior,
          spaceId: spaceId || null,
          iconGlyph: iconGlyph.trim() || null,
          iconColor: iconColor.trim() || null,
          iconUrl: iconUrl.trim() || null,
        }),
      });
      onUpdated(result.app);
      toast.success('App identity saved');
    } catch (error) {
      toast.error('Save failed', String(error));
    } finally {
      setSavingIdentity(false);
    }
  }

  async function saveBudget() {
    setSavingBudget(true);
    try {
      const monthlyBudgetCents = parseBudgetInput(budgetInput);
      const result = await api<{ app: AppDetail }>(`/v1/apps/${app.slug}`, {
        method: 'PATCH',
        body: JSON.stringify({ monthlyBudgetCents }),
      });
      onUpdated(result.app);
      toast.success('Budget saved');
    } catch (error) {
      toast.error('Save failed', String(error));
    } finally {
      setSavingBudget(false);
    }
  }

  async function saveLabels() {
    setSavingLabels(true);
    try {
      const outputLabels = cleanOutputLabels(labels);
      const result = await api<{ app: AppDetail }>(`/v1/apps/${app.slug}`, {
        method: 'PATCH',
        body: JSON.stringify({ outputLabels }),
      });
      onUpdated(result.app);
      toast.success('Output labels saved');
    } catch (error) {
      toast.error('Save failed', String(error));
    } finally {
      setSavingLabels(false);
    }
  }

  async function toggleTrigger(trigger: AppTriggerSummary) {
    setBusyTriggerId(trigger.id);
    try {
      await api(`/v1/triggers/${trigger.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: trigger.status === 'active' ? 'paused' : 'active' }),
      });
      toast.success(trigger.status === 'active' ? 'Trigger paused' : 'Trigger activated');
      const refreshed = await onRefresh();
      if (refreshed) onUpdated(refreshed);
    } catch (error) {
      toast.error('Could not update trigger', String(error));
    } finally {
      setBusyTriggerId(null);
    }
  }

  async function toggleAppStatus() {
    setBusyDangerAction('status');
    try {
      const result = await api<{ app: AppDetail }>(`/v1/apps/${app.slug}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: app.status === 'paused' ? 'active' : 'paused' }),
      });
      onUpdated(result.app);
      toast.success(app.status === 'paused' ? 'App marked active' : 'App paused');
    } catch (error) {
      toast.error('Could not update app status', String(error));
    } finally {
      setBusyDangerAction(null);
    }
  }

  async function resetBrain() {
    const ok = await confirm({
      title: `Reset intelligence for "${app.name}"?`,
      body: 'This clears app-scoped knowledge chunks, memory, evaluator examples, promoted patterns, and dataset import state.',
      confirmLabel: 'Reset app brain',
      tone: 'warn',
    });
    if (!ok) return;
    setBusyDangerAction('reset');
    try {
      const result = await api<{ app: AppDetail }>(`/v1/apps/${app.slug}/reset-brain`, { method: 'POST' });
      onUpdated(result.app);
      toast.success('App knowledge reset');
    } catch (error) {
      toast.error('Reset failed', String(error));
    } finally {
      setBusyDangerAction(null);
    }
  }

  async function deleteApp() {
    const ok = await confirm({
      title: `Delete app "${app.name}"?`,
      body: 'This removes the app instance, its workflows, triggers, outputs, and app-scoped knowledge. This action cannot be undone.',
      confirmLabel: 'Delete app',
      tone: 'danger',
      typeToConfirm: app.name,
    });
    if (!ok) return;
    setBusyDangerAction('delete');
    try {
      await api(`/v1/apps/${app.slug}`, { method: 'DELETE' });
      toast.success('App deleted');
      onDeleted();
    } catch (error) {
      toast.error('Delete failed', String(error));
      setBusyDangerAction(null);
    }
  }

  function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (loadEvent) => setIconUrl((loadEvent.target?.result as string) ?? '');
    reader.readAsDataURL(file);
  }

  const knowledge = app.knowledgeSummary;
  const budgetUsage = app.spendSummary?.usageRatio ?? null;
  const remainingBudgetCents = app.spendSummary?.remainingBudgetCents ?? null;

  return (
    <div className="flex min-h-0 gap-0 pb-10">
      <nav className="w-44 shrink-0 border-r border-line pr-3 pt-1">
        <div className="mb-3 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Settings</div>
        <div className="space-y-0.5">
          {CONFIG_NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveSection(item.id)}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-left transition-colors',
                activeSection === item.id
                  ? item.tone === 'danger'
                    ? 'bg-danger-soft/30 font-medium text-danger'
                    : 'bg-surface-2 font-medium text-text-primary'
                  : item.tone === 'danger'
                    ? 'text-danger/70 hover:bg-danger-soft/20 hover:text-danger'
                    : 'text-text-secondary hover:bg-surface-2/60 hover:text-text-primary',
              )}
            >
              <span className={clsx('shrink-0', item.tone === 'danger' ? 'text-danger/80' : 'text-text-muted')}>
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="min-w-0 flex-1 pl-6">
        {activeSection === 'identity' && (
        <ConfigSection
          icon={<ImageIcon size={15} />}
          title="Identity"
          detail="Name, image, description, and the Space this app belongs to."
          action={<Button size="sm" variant="primary" loading={savingIdentity} onClick={() => void saveIdentity()}>Save identity</Button>}
        >
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="flex w-full max-w-[220px] flex-col items-center gap-3 rounded-card border border-dashed border-line bg-surface-2 p-4 text-center">
              <AppAvatar
                app={{ ...app, name, iconGlyph, iconColor, iconUrl }}
                className="h-24 w-24 text-[32px]"
              />
              <div className="space-y-2">
                <Button size="sm" variant="secondary" iconLeft={<Upload size={13} />} onClick={() => fileRef.current?.click()}>Upload image</Button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleImageChange} />
                <div className="text-[11px] text-text-muted">If no image is uploaded, Agentis uses initials from the app name.</div>
                {iconUrl && <Button size="sm" variant="ghost" onClick={() => setIconUrl('')}>Remove image</Button>}
              </div>
            </div>

            <div className="grid flex-1 gap-4">
              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-text-secondary">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-text-secondary">Space</label>
                <select
                  value={spaceId}
                  onChange={(event) => setSpaceId(event.target.value)}
                  className="h-10 w-full rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary focus:border-accent focus:outline-none"
                >
                  <option value="">General</option>
                  {spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-text-secondary">Description</label>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={4}
                  className="w-full rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[14px] text-text-primary focus:border-accent focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-text-secondary">Intended behavior</label>
                <textarea
                  value={intendedBehavior}
                  onChange={(event) => setIntendedBehavior(event.target.value)}
                  rows={6}
                  className="w-full rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[14px] text-text-primary focus:border-accent focus:outline-none"
                />
              </div>
            </div>
          </div>
        </ConfigSection>
        )}

        {activeSection === 'performance' && (
          <div className="space-y-4">
            <div>
              <div className="text-[15px] font-semibold text-text-primary">Performance</div>
              <div className="mt-1 text-[12px] text-text-secondary">Cost, reliability, run history, and agent spend for this app.</div>
            </div>
            <PerformanceTab app={app} />
          </div>
        )}

        {activeSection === 'activity' && (
          <div className="space-y-4">
            <div>
              <div className="text-[15px] font-semibold text-text-primary">Activity</div>
              <div className="mt-1 text-[12px] text-text-secondary">Raw app events and execution trail.</div>
            </div>
            <ActivityTab app={app} />
          </div>
        )}

        {activeSection === 'workflows' && (
        <div className="space-y-5">
        <ConfigSection
          icon={<CanvasIcon size={15} />}
          title="Workflows"
          detail="Entry points, health, and quick access to the app's workflow surfaces.">

          {(app.workflows ?? []).length === 0 ? (
            <EmptyInline message="No workflows linked to this app yet." />
          ) : (
            <div className="space-y-2">
              {app.workflows!.map((workflow) => (
                <div key={workflow.id} className="flex flex-col gap-3 rounded-card border border-line bg-surface-2 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate text-[13px] font-medium text-text-primary">{workflow.name}</div>
                      <StatusBadge status={workflow.status ?? 'idle'} size="sm" />
                      {workflow.id === app.entryWorkflowId && <span className="rounded-pill bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">Entry workflow</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-[12px] text-text-muted">
                      <span>{workflow.activeTriggerCount ?? 0}/{workflow.triggerCount ?? 0} triggers active</span>
                      {workflow.lastRunAt && <span>Last run {relativeTime(workflow.lastRunAt)}</span>}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" iconRight={<ArrowUpRight size={12} />} onClick={() => nav(workflow.route ?? `/workflows/${workflow.id}`)}>Open canvas</Button>
                </div>
              ))}
            </div>
          )}
        </ConfigSection>
        <ConfigSection
          icon={<Play size={15} />}
          title="Triggers"
          detail="What starts this app, which trigger is active, and whether it is live right now."
        >
          {(app.triggers ?? []).length === 0 ? (
            <EmptyInline message="No triggers configured yet. Open the entry workflow to create one." />
          ) : (
            <div className="space-y-2">
              {app.triggers!.map((trigger) => (
                <div key={trigger.id} className="flex flex-col gap-3 rounded-card border border-line bg-surface-2 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-[13px] font-medium text-text-primary">{humanizeLabel(trigger.triggerType)}</div>
                      <StatusBadge status={trigger.status} size="sm" />
                      <span className="text-[11px] text-text-muted">{trigger.workflowName}</span>
                    </div>
                    <div className="mt-1 text-[12px] text-text-secondary">{trigger.summary ?? 'No trigger summary.'}</div>
                    <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-text-muted">
                      {trigger.lastFiredAt && <span>Last fired {relativeTime(trigger.lastFiredAt)}</span>}
                      {trigger.webhookUrl && <span className="font-mono">{trigger.webhookUrl}</span>}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busyTriggerId === trigger.id}
                    onClick={() => void toggleTrigger(trigger)}
                  >
                    {trigger.status === 'active' ? 'Pause' : 'Activate'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ConfigSection>
        </div>
        )}

        {activeSection === 'labels' && (
        <ConfigSection
          icon={<Tag size={15} />}
          title="Output labels"
          detail="Define the result fields this app should surface in Results and Performance."
          action={
            <div className="flex gap-2">
              {app.entryWorkflowId && (
                <Button size="sm" variant="secondary" onClick={() => nav(`/workflows/${app.entryWorkflowId}`)}>Edit in Canvas</Button>
              )}
              <Button size="sm" variant="primary" loading={savingLabels} onClick={() => void saveLabels()}>Save labels</Button>
            </div>
          }
        >
          <div className="space-y-3">
            <div className="rounded-card border border-dashed border-line bg-surface-2 px-3 py-3 text-[12px] text-text-muted">
              Labels created from output-surface nodes are auto-detected. Remove those in Canvas if you want them gone permanently.
            </div>
            {labels.map((label, index) => (
              <div key={`${label.path}-${index}`} className="grid gap-2 rounded-card border border-line bg-surface-2 p-3 md:grid-cols-[1.1fr_1fr_140px_150px_auto]">
                <input
                  type="text"
                  value={label.label}
                  onChange={(event) => setLabels((current) => updateLabel(current, index, { label: event.target.value }))}
                  placeholder="Label"
                  className="h-10 rounded-input border border-line bg-surface px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                />
                <input
                  type="text"
                  value={label.path}
                  onChange={(event) => setLabels((current) => updateLabel(current, index, { path: event.target.value }))}
                  placeholder="path.to.value"
                  className="h-10 rounded-input border border-line bg-surface px-3 font-mono text-[13px] text-text-primary focus:border-accent focus:outline-none"
                />
                <select
                  value={label.format ?? ''}
                  onChange={(event) => setLabels((current) => updateLabel(current, index, { format: (event.target.value || undefined) as OutputLabel['format'] }))}
                  className="h-10 rounded-input border border-line bg-surface px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                >
                  {OUTPUT_FORMAT_OPTIONS.map((option) => <option key={option || 'none'} value={option}>{option || 'Format'}</option>)}
                </select>
                <select
                  value={label.artifactType ?? ''}
                  onChange={(event) => setLabels((current) => updateLabel(current, index, { artifactType: (event.target.value || undefined) as OutputLabel['artifactType'] }))}
                  className="h-10 rounded-input border border-line bg-surface px-3 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                >
                  {OUTPUT_ARTIFACT_OPTIONS.map((option) => <option key={option || 'none'} value={option}>{option || 'Artifact'}</option>)}
                </select>
                <Button size="sm" variant="ghost" onClick={() => setLabels((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" iconLeft={<Plus size={12} />} onClick={() => setLabels((current) => [...current, { label: '', path: '', format: 'number', artifactType: 'metric' }])}>Add label</Button>
          </div>
        </ConfigSection>
        )}

        {activeSection === 'agents' && (
        <ConfigSection
          icon={<Bot size={15} />}
          title="Agents"
          detail="Execution agents used by this app and their current runtime posture."
        >
          {(app.agents ?? []).length === 0 ? (
            <EmptyInline message="No agents linked to this app yet." />
          ) : (
            <div className="space-y-2">
              {app.agents!.map((agent) => (
                <div key={agent.id} className="flex flex-col gap-3 rounded-card border border-line bg-surface-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-[13px] font-medium text-text-primary">{agent.name}</div>
                    <StatusBadge status={agent.status ?? 'idle'} size="sm" />
                    {agent.role && <span className="rounded-pill bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-muted">{agent.role}</span>}
                  </div>
                  <div className="flex flex-wrap gap-3 text-[12px] text-text-muted">
                    {agent.lastHeartbeatAt && <span>Heartbeat {relativeTime(agent.lastHeartbeatAt)}</span>}
                    {agent.currentTaskId && <span>Task {agent.currentTaskId}</span>}
                  </div>
                  {agent.route && <Button size="sm" variant="secondary" iconRight={<ArrowUpRight size={12} />} onClick={() => nav(agent.route!)}>Open agent</Button>}
                </div>
              ))}
            </div>
          )}
        </ConfigSection>
        )}

        {activeSection === 'connections' && (
        <ConfigSection
          icon={<Cable size={15} />}
          title="Connections"
          detail="External accounts this app needs in order to work."
        >
          {(app.credentialSlots ?? []).length === 0 ? (
            <EmptyInline message="This app does not need any external connections." />
          ) : (
            <div className="space-y-2">
              {app.credentialSlots!.map((slot) => (
                <div key={slot.key} className="flex flex-col gap-3 rounded-card border border-line bg-surface-2 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface text-text-muted">
                        <Cable size={13} />
                      </span>
                      <div className="text-[13px] font-medium text-text-primary">{slot.label}</div>
                      <StatusBadge label={slot.bound ? 'Bound' : 'Missing'} tone={slot.bound ? 'accent' : 'warn'} size="sm" status={undefined} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 pl-9 text-[12px] text-text-muted">
                      <span>{slot.service}</span>
                      {!slot.required && <span>Optional</span>}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => nav('/settings')}>{slot.bound ? 'Manage' : 'Connect'}</Button>
                </div>
              ))}
            </div>
          )}
        </ConfigSection>
        )}

        {activeSection === 'surfaces' && (
        <ConfigSection
          icon={<Signal size={15} />}
          title="Surfaces"
          detail="Live connection status for every surface this app exposes to operators, users, and external systems."
        >
          {surfaceStatus === null ? (
            <div className="space-y-2">
              <Skeleton height={32} />
              <Skeleton height={32} />
              <Skeleton height={32} />
            </div>
          ) : surfaceStatus.length === 0 ? (
            <EmptyInline message="No surface data available." />
          ) : (
            <div className="divide-y divide-line rounded-card border border-line">
              {surfaceStatus.map((s) => (
                <div key={s.type} className="flex items-center gap-4 px-4 py-3">
                  {/* Status dot */}
                  <span
                    className={[
                      'mt-px h-2.5 w-2.5 shrink-0 rounded-full',
                      s.live
                        ? 'bg-accent'
                        : s.configured
                          ? 'bg-text-muted'
                          : 'border border-line bg-surface-3',
                    ].join(' ')}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-text-primary">{s.label}</span>
                      {s.live && (
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                          live
                        </span>
                      )}
                      {!s.configured && (
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-muted">
                          not configured
                        </span>
                      )}
                      {s.configured && !s.live && (
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-muted">
                          stopped
                        </span>
                      )}
                    </div>
                    {s.configured && (
                      <div className="mt-0.5 flex flex-wrap gap-3 text-[12px] text-text-muted">
                        {s.activityToday > 0 && (
                          <span>
                            {s.activityToday} {s.activityUnit}{s.activityToday !== 1 ? 's' : ''} today
                          </span>
                        )}
                        {s.lastActivityAt && (
                          <span>last {surfaceRelTime(s.lastActivityAt)}</span>
                        )}
                        {s.activityToday === 0 && !s.lastActivityAt && (
                          <span>no activity today</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ConfigSection>
        )}

        {activeSection === 'limits' && (
        <ConfigSection
          icon={<Coins size={15} />}
          title="Limits"
          detail="Monthly cost cap and the irreversible actions for this app."
          action={<Button size="sm" variant="primary" loading={savingBudget} onClick={() => void saveBudget()}>Save limits</Button>}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <MetricPanel label="30-day spend" value={formatMoney(app.spendSummary?.totalCost30d ?? 0)} />
            <MetricPanel label="Runs" value={String(app.spendSummary?.runCount30d ?? 0)} />
          </div>
          <div className="mt-4 space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Monthly soft cap (USD)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={budgetInput}
                onChange={(event) => setBudgetInput(event.target.value)}
                placeholder="Leave blank for no cap"
                className="h-10 flex-1 rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <Button size="sm" variant="secondary" onClick={() => setBudgetInput('')}>Clear</Button>
            </div>
          </div>
          <div className="mt-5 space-y-3 border-t border-line pt-4">
            <DangerRow
              title={app.status === 'paused' ? 'Mark app active' : 'Pause app'}
              body={app.status === 'paused'
                ? 'Re-enable the app shell. Individual triggers still need to be activated if they were paused.'
                : 'Set the app to paused and deactivate its triggers.'}
              action={
                <Button size="sm" variant="secondary" loading={busyDangerAction === 'status'} iconLeft={<PauseCircle size={13} />} onClick={() => void toggleAppStatus()}>
                  {app.status === 'paused' ? 'Set active' : 'Pause app'}
                </Button>
              }
            />
            <DangerRow
              title="Reset knowledge"
              body="Clear app-scoped knowledge chunks, memory, evaluator examples, promoted patterns, and import state."
              action={<Button size="sm" variant="secondary" loading={busyDangerAction === 'reset'} onClick={() => void resetBrain()}>Reset brain</Button>}
            />
            <DangerRow
              title="Delete app"
              body="Permanently remove the app instance, its workflows, triggers, outputs, and app-scoped data."
              action={<Button size="sm" variant="danger" loading={busyDangerAction === 'delete'} iconLeft={<Trash2 size={13} />} onClick={() => void deleteApp()}>Delete app</Button>}
            />
          </div>
        </ConfigSection>
        )}

        {activeSection === 'budget' && (
        <ConfigSection
          icon={<Coins size={15} />}
          title="Budget & intelligence"
          detail="Soft cap, current spend, imported datasets, and the app's retained intelligence."
          action={<Button size="sm" variant="primary" loading={savingBudget} onClick={() => void saveBudget()}>Save budget</Button>}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <MetricPanel label="30-day spend" value={formatMoney(app.spendSummary?.totalCost30d ?? 0)} />
            <MetricPanel label="Avg / run" value={formatMoney(app.spendSummary?.avgCostPerRun30d ?? 0)} />
            <MetricPanel label="Knowledge bases" value={String(knowledge?.knowledgeBases ?? 0)} />
            <MetricPanel label="Memory items" value={String(knowledge?.memoryItems ?? 0)} />
          </div>
          <div className="mt-4 space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">Monthly soft cap (USD)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={budgetInput}
                onChange={(event) => setBudgetInput(event.target.value)}
                placeholder="Leave blank for no cap"
                className="h-10 flex-1 rounded-input border border-line bg-surface-2 px-3 text-[14px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <Button size="sm" variant="secondary" onClick={() => setBudgetInput('')}>Clear</Button>
            </div>
          </div>
          {app.spendSummary?.monthlyBudgetCents != null && (
            <div className="mt-4 rounded-card border border-line bg-surface-2 p-3">
              <div className="flex items-center justify-between gap-2 text-[12px] text-text-secondary">
                <span>Budget usage</span>
                <span>{Math.round((budgetUsage ?? 0) * 100)}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
                <div
                  className={clsx(
                    'h-full rounded-full',
                    app.spendSummary.status === 'over' ? 'bg-danger' : app.spendSummary.status === 'near' ? 'bg-warn' : 'bg-accent',
                  )}
                  style={{ width: `${Math.min(100, Math.max(4, (budgetUsage ?? 0) * 100))}%` }}
                />
              </div>
              <div className="mt-2 text-[12px] text-text-muted">
                {remainingBudgetCents != null && remainingBudgetCents >= 0
                  ? `${formatMoney(remainingBudgetCents / 100)} remaining`
                  : remainingBudgetCents != null
                    ? `${formatMoney(Math.abs(remainingBudgetCents) / 100)} over budget`
                    : 'No remaining budget available'}
              </div>
            </div>
          )}
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Datasets</div>
            {(app.datasetStatuses ?? []).length === 0 ? (
              <EmptyInline message="This app does not declare any datasets." compact />
            ) : (
              <div className="space-y-2">
                {app.datasetStatuses!.map((dataset) => (
                  <div key={dataset.key} className="rounded-card border border-line bg-surface-2 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-[13px] font-medium text-text-primary">{dataset.label}</div>
                      <StatusBadge status={dataset.status} size="sm" />
                      {!dataset.optional && <span className="rounded-pill bg-surface px-2 py-0.5 text-[10px] text-text-muted">Required</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-text-muted">
                      {dataset.targetStore && <span>{dataset.targetStore}</span>}
                      {dataset.currentJobId && <span>Job {dataset.currentJobId}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ConfigSection>
        )}

        {activeSection === 'danger' && (
        <ConfigSection
          icon={<AlertTriangle size={15} />}
          title="Danger zone"
          detail="Pause the app, clear its intelligence layer, or remove it entirely."
          tone="danger"
        >
          <div className="space-y-3">
            <DangerRow
              title={app.status === 'paused' ? 'Mark app active' : 'Pause app'}
              body={app.status === 'paused'
                ? 'Re-enable the app shell. Individual triggers still need to be activated if they were paused.'
                : 'Set the app to paused and deactivate its triggers.'}
              action={
                <Button size="sm" variant="secondary" loading={busyDangerAction === 'status'} iconLeft={<PauseCircle size={13} />} onClick={() => void toggleAppStatus()}>
                  {app.status === 'paused' ? 'Set active' : 'Pause app'}
                </Button>
              }
            />
            <DangerRow
              title="Reset knowledge"
              body="Clear app-scoped knowledge chunks, memory, evaluator examples, promoted patterns, and import state."
              action={<Button size="sm" variant="secondary" loading={busyDangerAction === 'reset'} onClick={() => void resetBrain()}>Reset brain</Button>}
            />
            <DangerRow
              title="Delete app"
              body="Permanently remove the app instance, its workflows, triggers, outputs, and app-scoped data."
              action={<Button size="sm" variant="danger" loading={busyDangerAction === 'delete'} iconLeft={<Trash2 size={13} />} onClick={() => void deleteApp()}>Delete app</Button>}
            />
          </div>
        </ConfigSection>
        )}
      </div>
    </div>
  );
}

function ActivityTab({ app }: { app: AppDetail }) {
  const [events, setEvents] = useState<Array<{ id: string; type: string; title: string; createdAt: string; runId?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void api<{ events: typeof events }>(`/v1/apps/${app.slug}/activity?limit=50`)
      .then((data) => { if (!cancelled) setEvents(data.events ?? []); })
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
      {events.map((event) => (
        <button
          key={event.id}
          type="button"
          onClick={() => event.runId && nav(`/runs/${event.runId}`)}
          className="flex w-full items-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2"
        >
          <span className="font-mono text-[10px] text-text-muted">{event.type}</span>
          <span className="flex-1 truncate text-[13px] text-text-primary">{event.title}</span>
          <span className="text-[11px] text-text-muted">{relativeTime(event.createdAt)}</span>
        </button>
      ))}
    </div>
  );
}

function ConfigSection({
  icon,
  title,
  detail,
  action,
  tone = 'default',
  children,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: React.ReactNode;
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <section className={clsx('rounded-card border p-4', tone === 'danger' ? 'border-danger/20 bg-danger-soft/20' : 'border-line bg-surface')}>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <span className={clsx('mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-card border', tone === 'danger' ? 'border-danger/20 bg-danger-soft text-danger' : 'border-line bg-surface-2 text-text-secondary')}>
            {icon}
          </span>
          <div>
            <div className="text-[14px] font-semibold text-text-primary">{title}</div>
            <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">{detail}</div>
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function AppAvatar({
  app,
  className,
}: {
  app: Pick<AppDetail, 'name' | 'iconUrl' | 'iconGlyph' | 'iconColor'>;
  className?: string;
}) {
  const text = (app.iconGlyph?.trim() || app.name.charAt(0).toUpperCase() || '?');
  return (
    <span
      className={clsx('flex items-center justify-center overflow-hidden rounded-card border border-line bg-surface-2 font-bold text-text-primary', className)}
      style={{ backgroundColor: app.iconColor ?? '#15171c' }}
    >
      {app.iconUrl ? <img src={app.iconUrl} alt="" className="h-full w-full object-cover" /> : text}
    </span>
  );
}

function MetricPanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-surface-2 p-3">
      <div className="text-[11px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 text-[20px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function DangerRow({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-danger/15 bg-surface px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-text-primary">{title}</div>
        <div className="mt-1 text-[12px] text-text-secondary">{body}</div>
      </div>
      {action}
    </div>
  );
}

function EmptyInline({ message, compact = false }: { message: string; compact?: boolean }) {
  return (
    <div className={clsx('rounded-card border border-dashed border-line bg-surface-2 text-center text-[13px] text-text-muted', compact ? 'px-3 py-3' : 'px-4 py-6')}>
      {message}
    </div>
  );
}

function BudgetStatusPill({ status }: { status: string }) {
  const label = status === 'over' ? 'Over budget' : status === 'near' ? 'Near cap' : status === 'ok' ? 'Within cap' : 'Open budget';
  return (
    <span className={clsx(
      'inline-flex items-center rounded-pill px-2.5 py-1 text-[11px] font-medium',
      status === 'over' && 'bg-danger-soft text-danger',
      status === 'near' && 'bg-warn-soft text-warn',
      status === 'ok' && 'bg-accent-soft text-accent',
      status === 'open' && 'bg-surface-2 text-text-muted',
    )}>
      {label}
    </span>
  );
}

function formatValue(value: unknown, format?: string): string {
  if (value == null) return '—';
  if (format === 'currency' && typeof value === 'number') return formatMoney(value);
  if (format === 'percent' && typeof value === 'number') return `${(value * 100).toFixed(1)}%`;
  if (format === 'number' && typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.slice(0, 60) + (text.length > 60 ? '…' : '');
  }
  return String(value);
}

function cleanOutputLabels(labels: OutputLabel[]): OutputLabel[] {
  const seen = new Set<string>();
  return labels
    .map((label) => ({
      label: label.label.trim(),
      path: label.path.trim(),
      format: label.format || undefined,
      artifactType: label.artifactType || undefined,
    }))
    .filter((label) => {
      if (!label.label || !label.path || seen.has(label.path)) return false;
      seen.add(label.path);
      return true;
    });
}

function updateLabel(labels: OutputLabel[], index: number, patch: Partial<OutputLabel>) {
  return labels.map((label, labelIndex) => (labelIndex === index ? { ...label, ...patch } : label));
}

function parseBudgetInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function normalizeColor(value: string | undefined) {
  return /^#[0-9a-fA-F]{6}$/.test(value ?? '') ? value! : '#15171c';
}

function appDisplayStatus(app: AppDetail): { status: string; label: string } {
  if (app.status === 'setup_needed') return { status: 'setup_needed', label: 'Setup needed' };
  if (app.status === 'paused') return { status: 'paused', label: 'Paused' };
  if (app.status === 'error' || app.deployStatus === 'error') return { status: 'error', label: 'Error' };
  if (app.deployStatus === 'running') return { status: 'live', label: 'Live' };
  return { status: 'stopped', label: 'Stopped' };
}

function formatMoney(value: number) {
  if (!Number.isFinite(value)) return '$0.00';
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  if (value > 0 && value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatDuration(ms?: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function relativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  } catch {
    return '';
  }
}

/** Compact relative-time formatter for surface activity timestamps. */
function surfaceRelTime(iso: string): string {
  try {
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}min ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    return `${Math.floor(diffH / 24)}d ago`;
  } catch {
    return '';
  }
}

function windowLabel(value: Window) {
  return WINDOW_FILTERS.find((filter) => filter.value === value)?.label ?? '7 days';
}

function humanizeLabel(value: string) {
  const spaced = value.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
