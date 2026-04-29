/**
 * StatusBadge — shared status pill with semantic tone.
 *
 * The same pill must mean the same thing everywhere: "online" is
 * always accent, "degraded" is always warn, "failed" / "offline" is
 * always danger, "idle" / "pending" is always muted. Anything else
 * uses the neutral tone so we can spot uncategorised states later.
 */

import clsx from 'clsx';
import type { ReactNode } from 'react';

export type StatusTone = 'accent' | 'warn' | 'danger' | 'muted' | 'neutral';

const KNOWN: Record<string, StatusTone> = {
  online: 'accent',
  ready: 'accent',
  active: 'accent',
  running: 'accent',
  completed: 'accent',
  connected: 'accent',
  healthy: 'accent',
  ok: 'accent',
  succeeded: 'accent',

  degraded: 'warn',
  pending: 'warn',
  waiting: 'warn',
  partial: 'warn',
  retrying: 'warn',
  warning: 'warn',
  warn: 'warn',

  offline: 'danger',
  failed: 'danger',
  error: 'danger',
  disconnected: 'danger',
  rejected: 'danger',

  idle: 'muted',
  draft: 'muted',
  unknown: 'muted',
  archived: 'muted',
  paused: 'muted',
};

export interface StatusBadgeProps {
  status?: string | null;
  tone?: StatusTone;
  label?: ReactNode;
  dot?: boolean;
  className?: string;
}

export function statusTone(status: string | null | undefined): StatusTone {
  if (!status) return 'muted';
  return KNOWN[status.toLowerCase()] ?? 'neutral';
}

const TONE_CLS: Record<StatusTone, string> = {
  accent: 'border-accent/30 bg-accent/10 text-accent',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  danger: 'border-danger/30 bg-danger/10 text-danger',
  muted: 'border-line bg-surface-2 text-text-muted',
  neutral: 'border-line bg-surface-2 text-text-primary',
};

const DOT_CLS: Record<StatusTone, string> = {
  accent: 'bg-accent shadow-glow',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-text-muted/50',
  neutral: 'bg-text-muted/50',
};

export function StatusBadge({ status, tone, label, dot = true, className }: StatusBadgeProps) {
  const t = tone ?? statusTone(status);
  const text = label ?? status ?? 'unknown';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        TONE_CLS[t],
        className,
      )}
    >
      {dot && <span className={clsx('h-1.5 w-1.5 rounded-full', DOT_CLS[t])} />}
      {text}
    </span>
  );
}
