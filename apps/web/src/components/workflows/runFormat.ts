/**
 * Shared formatting helpers for the workflow Runs / Output tabs.
 */

/** "4.3s" / "1m 12s" / "820ms" — never throws. */
export function formatDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}m ${s}s`;
}

/** "just now" / "2min ago" / "3h ago" / "yesterday" / "3 days ago". */
export function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export interface WorkflowRunSummary {
  id: string;
  status: 'running' | 'completed' | 'completed_with_violation' | 'failed' | 'pending' | 'cancelled' | 'paused' | 'waiting';
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  triggeredBy: 'manual' | 'cron' | 'webhook' | 'event';
  isReplay?: boolean;
  /** Output contract violations from the run's final output, when the workflow declared an outputContract. */
  contractViolations?: string[];
}
