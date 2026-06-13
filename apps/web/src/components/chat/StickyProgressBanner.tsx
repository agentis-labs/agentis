import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { ToolCallData } from './toolCalls';

/**
 * StickyProgressBanner - floating pill at the bottom-center
 * of the chat viewport instead of a top sticky bar. Less intrusive, more
 * contextual. Shows the currently running tool + overall progress.
 */
export function StickyProgressBanner({
  toolCalls,
  onJumpToLatest,
  activeRunId,
  onCancelRun,
}: {
  toolCalls: ToolCallData[];
  onJumpToLatest?: () => void;
  activeRunId?: string;
  onCancelRun?: (runId: string) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const running = toolCalls.filter((call) => call.status === 'running');
  const done = toolCalls.filter((call) => call.status === 'success').length;
  const failed = toolCalls.filter((call) => call.status === 'error').length;
  const total = toolCalls.length;
  const activeStep = running[0];

  const hasActiveTools = running.length > 0;

  useEffect(() => {
    if (hasActiveTools) setDismissed(false);
  }, [hasActiveTools]);

  if (toolCalls.length === 0 || running.length === 0 || dismissed) return null;

  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div
      className={clsx(
        'pointer-events-none sticky bottom-3 z-20 mb-3 flex justify-center',
        'animate-in slide-in-from-bottom-1 fade-in duration-300',
      )}
    >
      <div className={clsx(
        'pointer-events-auto w-[min(100%,520px)]',
        'flex items-center gap-2.5 rounded-xl px-3 py-2',
        'border border-accent/25 bg-surface/95 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.5)] backdrop-blur-md',
        'text-[11px]',
      )}>
        {/* Spinner */}
        <Loader2 size={13} className="shrink-0 animate-spin text-accent" />

        {/* Current step name */}
        <div className="min-w-0 flex-1">
          <span className="font-semibold text-text-primary">
            {activeStep ? activeStep.name : 'Agent is working'}
          </span>
          {total > 1 && (
            <span className="ml-2 font-mono text-[10px] text-text-muted tabular-nums">
              {done}/{total}
            </span>
          )}
          {failed > 0 && (
            <span className="ml-1.5 font-medium text-danger">· {failed} failed</span>
          )}
        </div>

        {/* Mini progress bar */}
        {total > 1 && (
          <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-2 shrink-0">
            <div
              className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {onJumpToLatest && (
            <button
              type="button"
              onClick={onJumpToLatest}
              className="rounded-md border border-line px-2 py-1 text-[10px] font-medium text-text-secondary transition hover:border-accent/40 hover:text-text-primary"
            >
              Latest
            </button>
          )}
          {onCancelRun && activeRunId && (
            <button
              type="button"
              onClick={() => onCancelRun(activeRunId)}
              className="rounded-md border border-danger/20 bg-danger/8 px-2 py-1 text-[10px] font-medium text-danger transition hover:bg-danger/15"
            >
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted/60 transition hover:bg-surface-2 hover:text-text-muted"
            aria-label="Dismiss progress banner"
          >
            <X size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
