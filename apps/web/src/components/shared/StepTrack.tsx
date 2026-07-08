

import { useState } from 'react';
import { CheckCircle2, ChevronRight, Circle, Loader2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import type { WorkStep, WorkStepStatus, WorkStepTrack } from '@agentis/core';

export interface StepTrackProps {
  track: WorkStepTrack | null;
  /** Current step text when there are no structured steps (derived fallback). */
  fallbackLabel?: string | null;
  /** Coarse progress when there are no structured steps. */
  fallbackProgress?: { completed: number; total: number } | null;
  active?: boolean;
  /** Start expanded (used in the panel's fullscreen / chat). */
  defaultExpanded?: boolean;
  className?: string;
}

export function StepTrack({
  track,
  fallbackLabel,
  fallbackProgress,
  active = true,
  defaultExpanded = false,
  className,
}: StepTrackProps) {
  const [pinned, setPinned] = useState(defaultExpanded);
  const [hovered, setHovered] = useState(false);

  const steps = track?.steps ?? [];
  const hasSteps = steps.length > 0;
  const total = track?.total ?? fallbackProgress?.total ?? 0;
  const current = track?.current ?? fallbackProgress?.completed ?? 0;
  const currentLabel = hasSteps ? currentStepLabel(steps, current) : (fallbackLabel ?? null);
  const pct = total > 0 ? Math.min(100, Math.max(4, Math.round((current / total) * 100))) : null;
  const open = hasSteps && (pinned || hovered);

  if (!hasSteps && !currentLabel && pct == null) return null;

  return (
    <div
      className={clsx('w-full', className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        disabled={!hasSteps}
        onClick={(event) => {
          event.stopPropagation();
          setPinned((value) => !value);
        }}
        className={clsx(
          'flex w-full items-center gap-1.5 text-left',
          hasSteps && 'cursor-pointer',
        )}
        aria-expanded={hasSteps ? open : undefined}
        title={hasSteps ? (open ? 'Hide steps' : 'Show steps') : undefined}
      >
        {hasSteps && (
          <ChevronRight
            size={12}
            className={clsx('shrink-0 text-text-muted transition-transform duration-150', open && 'rotate-90')}
          />
        )}
        <span className={clsx('min-w-0 flex-1 truncate text-[11px]', active ? 'text-text-secondary' : 'text-text-muted')}>
          {currentLabel ?? 'Workingâ€¦'}
        </span>
        {total > 0 && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-text-muted">{current}/{total}</span>
        )}
      </button>

      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line/60">
        <div
          className={clsx(
            'h-full rounded-full bg-accent transition-[width] duration-500',
            pct == null && active && 'w-2/5 animate-pulse',
          )}
          style={pct != null ? { width: `${pct}%` } : undefined}
        />
      </div>

      {open && (
        <ol className="mt-2 space-y-1.5 border-l border-line/60 pl-3">
          {steps.map((step, index) => (
            <li key={step.id || `${index}-${step.label}`} className="flex items-start gap-2">
              <StepStatusIcon status={step.status} />
              <span
                className={clsx(
                  'min-w-0 flex-1 text-[11px] leading-snug',
                  step.status === 'pending' && 'text-text-muted/70',
                  step.status === 'running' && 'font-medium text-text-primary',
                  step.status === 'done' && 'text-text-muted line-through decoration-line/50',
                  step.status === 'failed' && 'text-danger',
                )}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function currentStepLabel(steps: WorkStep[], current: number): string | null {
  const running = steps.find((step) => step.status === 'running');
  if (running) return running.label;
  const index = Math.min(Math.max(current, 1), steps.length) - 1;
  return steps[index]?.label ?? steps[0]?.label ?? null;
}

function StepStatusIcon({ status }: { status: WorkStepStatus }) {
  if (status === 'running') return <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin text-accent" />;
  if (status === 'done') return <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-accent" />;
  if (status === 'failed') return <XCircle size={12} className="mt-0.5 shrink-0 text-danger" />;
  return <Circle size={12} className="mt-0.5 shrink-0 text-text-muted" />;
}



