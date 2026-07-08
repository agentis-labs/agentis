/**
 * StatusBadge â€” shared status pill with semantic tone.
 *
 * Same pill = same meaning everywhere. Supports both legacy string-based
 * status (auto-mapped to a tone) and the new rich semantic API with
 * per-status pulse behavior.
 */

import clsx from 'clsx';
import type { ReactNode } from 'react';

export type StatusTone = 'accent' | 'warn' | 'danger' | 'muted' | 'neutral';

const KNOWN: Record<string, StatusTone> = {
  online: 'accent',
  ready: 'accent',
  active: 'accent',
  running: 'accent',
  live: 'accent',
  completed: 'accent',
  connected: 'accent',
  healthy: 'accent',
  ok: 'accent',
  succeeded: 'accent',
  success: 'accent',

  degraded: 'warn',
  pending: 'warn',
  waiting: 'warn',
  partial: 'warn',
  retrying: 'warn',
  warning: 'warn',
  warn: 'warn',
  attention: 'warn',
  setting_up: 'warn',
  paused: 'warn',

  offline: 'danger',
  failed: 'danger',
  error: 'danger',
  disconnected: 'danger',
  rejected: 'danger',
  broken: 'danger',

  idle: 'muted',
  draft: 'muted',
  unknown: 'muted',
  archived: 'muted',
  stopped: 'muted',
};

const PULSE_STATES = new Set([
  'running', 'live', 'active', 'pending', 'waiting', 'connecting', 'retrying', 'setting_up',
]);

export interface StatusBadgeProps {
  status?: string | null;
  tone?: StatusTone;
  label?: ReactNode;
  dot?: boolean;
  pulse?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function statusTone(status: string | null | undefined): StatusTone {
  if (!status) return 'muted';
  return KNOWN[status.toLowerCase()] ?? 'neutral';
}

const TONE_CLS: Record<StatusTone, string> = {
  accent: 'border-accent/30 bg-accent-soft text-accent',
  warn: 'border-warn/30 bg-warn-soft text-warn',
  danger: 'border-danger/30 bg-danger-soft text-danger',
  muted: 'border-line bg-surface-2 text-text-muted',
  neutral: 'border-line bg-surface-2 text-text-primary',
};

const DOT_CLS: Record<StatusTone, string> = {
  accent: 'bg-accent',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-text-muted/50',
  neutral: 'bg-text-muted/50',
};

export function StatusBadge({
  status, tone, label, dot = true, pulse, size = 'md', className,
}: StatusBadgeProps) {
  const t = tone ?? statusTone(status);
  const text = label ?? status ?? 'unknown';
  const shouldPulse = pulse ?? (typeof status === 'string' && PULSE_STATES.has(status.toLowerCase()));
  return (
    <span
      role="status"
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-pill border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]',
        TONE_CLS[t],
        className,
      )}
    >
      {dot && (
        <span
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            DOT_CLS[t],
            shouldPulse && 'animate-pulse-dot',
            t === 'accent' && shouldPulse && 'shadow-glow',
          )}
        />
      )}
      <span className="capitalize">{text}</span>
    </span>
  );
}

export function StatusDot({
  status, tone, pulse, size = 8, className,
}: {
  status?: string | null;
  tone?: StatusTone;
  pulse?: boolean;
  size?: number;
  className?: string;
}) {
  const t = tone ?? statusTone(status);
  const shouldPulse = pulse ?? (typeof status === 'string' && PULSE_STATES.has(status.toLowerCase()));
  return (
    <span
      aria-label={status ?? 'status'}
      style={{ width: size, height: size }}
      className={clsx('inline-block rounded-full', DOT_CLS[t], shouldPulse && 'animate-pulse-dot', className)}
    />
  );
}



