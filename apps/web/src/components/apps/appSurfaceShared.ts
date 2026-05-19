/**
 * Shared types + helpers for the redesigned App Surface
 * (docs/UIUX-refactor/SURFACE-PAGE-REDESIGN.md).
 *
 * The Surface is composed of AppDomainStrip, AppActionInbox, AppWorkFeed,
 * AppSignalsPanel and AppSetupChecklist. They share the data shapes and the
 * small formatting primitives declared here so the layout reads consistently.
 */

// ── Data shapes ────────────────────────────────────────────────────────────

export interface SurfaceDomain {
  id: string;
  name: string;
  description?: string;
  workflowIds: string[];
}

export interface SurfaceDataField {
  name: string;
  type: string;
}

export interface SurfaceDataTable {
  name: string;
  description: string | null;
  fields: SurfaceDataField[];
}

export interface SurfaceWorkflow {
  id: string;
  name: string;
  status?: string;
  triggerCount?: number;
  activeTriggerCount?: number;
  lastRunAt?: string | null;
}

export interface SurfaceAgent {
  id: string;
  name: string;
  status?: string;
}

export interface SurfaceTrigger {
  id: string;
  workflowId: string;
  workflowName: string;
  triggerType: string;
  status: string;
  lastFiredAt?: string | null;
  summary?: string;
}

export interface SurfaceDatasetStatus {
  key: string;
  label: string;
  status: string;
  optional?: boolean;
}

export interface SurfaceBudget {
  monthlyBudgetCents?: number | null;
  currentSpendCents?: number;
  remainingCents?: number | null;
  usageRatio?: number | null;
  status?: string;
}

export interface SurfaceIntentHealthEpisode {
  id: string;
  title: string;
  type: string;
  outcomeStatus: string | null;
  similarity: number;
  createdAt: string;
}

export interface SurfaceIntentHealth {
  status: 'unanchored' | 'learning' | 'aligned' | 'watch' | 'drifting';
  score: number;
  episodeCount: number;
  alignedCount: number;
  driftCount: number;
  intentPresent: boolean;
  summary: string;
  signals: Array<{ label: string; value: string; tone: 'good' | 'warn' | 'danger' | 'muted' }>;
  topMatches: SurfaceIntentHealthEpisode[];
  driftCandidates: SurfaceIntentHealthEpisode[];
}

/** Everything the Surface tab needs about its app — passed by AppDetailPage. */
export interface SurfaceApp {
  id: string;
  slug: string;
  name: string;
  version?: string;
  status?: string;
  description?: string;
  intendedBehavior?: string | null;
  intentHealth?: SurfaceIntentHealth | null;
  entryWorkflowId?: string | null;
  deployTarget?: string;
  deployStatus?: string;
  installedAt?: string | null;
  domains: SurfaceDomain[];
  dataTables: SurfaceDataTable[];
  workflows: SurfaceWorkflow[];
  agents: SurfaceAgent[];
  triggers: SurfaceTrigger[];
  datasetStatuses: SurfaceDatasetStatus[];
  budget?: SurfaceBudget;
}

export interface SurfaceRun {
  id: string;
  workflowId?: string;
  workflowName?: string;
  status: string;
  startedAt: string;
  durationMs?: number;
  cost?: number;
  failedNode?: string;
}

export interface SurfaceApproval {
  id: string;
  title: string;
  summary?: string;
  runId?: string;
  workflowName?: string;
  createdAt: string;
}

export interface SurfaceThreadMessage {
  id: string;
  role: 'operator' | 'app' | 'system';
  kind: 'message' | 'progress' | 'result' | 'checkpoint' | 'error';
  content: Record<string, unknown> & {
    text?: string;
    summary?: string | null;
    outputKey?: string;
    title?: string;
    status?: string;
  };
  runId: string | null;
  approvalId: string | null;
  createdAt: string;
}

export interface SurfaceSignal {
  id: string;
  label: string;
  value: string;
  format: 'count' | 'percent' | 'currency' | 'ratio';
  table: string;
  trend?: 'up' | 'down' | 'flat';
}

export interface SurfaceRecord {
  table: string;
  recordId: string;
  record: Record<string, unknown>;
  createdAt: string;
}

export type DomainStatus = 'running' | 'idle' | 'scheduled' | 'errored';

// ── Formatting helpers ─────────────────────────────────────────────────────

export function asTime(value?: string | null): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - asTime(iso);
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatMoney(value?: number | null): string {
  if (value == null) return '—';
  if (value === 0) return '$0.00';
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  if (value > 0 && value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function humanizeLabel(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function clipText(value: string, max = 160): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

export function formatCellValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  }
  return String(value);
}

export function normalizeRunStatus(status?: string): 'completed' | 'failed' | 'running' | 'pending' {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'running':
    case 'in_progress':
      return 'running';
    default:
      return 'pending';
  }
}

/**
 * Resolve a domain's live status from its workflows + triggers.
 * Running beats errored beats scheduled beats idle.
 */
export function resolveDomainStatus(
  workflows: SurfaceWorkflow[],
  triggers: SurfaceTrigger[],
): DomainStatus {
  if (workflows.some((wf) => (wf.status ?? '').toLowerCase() === 'running')) return 'running';
  if (workflows.some((wf) => (wf.status ?? '').toLowerCase() === 'failed')) return 'errored';
  if (triggers.some((t) => t.triggerType === 'cron' && t.status === 'active')) return 'scheduled';
  return 'idle';
}

/** Primary trigger type for a domain — drives the chip icon. */
export function domainTriggerType(triggers: SurfaceTrigger[]): string {
  const active = triggers.find((t) => t.status === 'active') ?? triggers[0];
  return active?.triggerType ?? 'manual';
}
